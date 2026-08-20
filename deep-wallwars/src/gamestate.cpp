#include "gamestate.hpp"

#include <folly/Hash.h>
#include <folly/Overload.h>

#include <algorithm>
#include <array>
#include <cassert>
#include <deque>
#include <format>
#include <iostream>
#include <ranges>
#include <sstream>

namespace ranges = std::ranges;
namespace views = std::ranges::views;

static constexpr std::array<char, 13> kColumnLabels = {'a', 'b', 'c', 'd', 'e', 'f', 'g',
                                                       'h', 'i', 'j', 'k', 'l', 'm'};
static constexpr std::array<char, 10> kRowLabels = {'1', '2', '3', '4', '5',
                                                    '6', '7', '8', '9', 'X'};

std::optional<Variant> parse_variant(std::string_view variant) {
    if (variant == "classic") {
        return Variant::Classic;
    }
    if (variant == "standard") {
        return Variant::Standard;
    }
    if (variant == "animal-cycle") {
        return Variant::AnimalCycle;
    }
    return std::nullopt;
}

std::string_view variant_name(Variant variant) {
    switch (variant) {
        case Variant::Classic:
            return "classic";
        case Variant::Standard:
            return "standard";
        case Variant::AnimalCycle:
            return "animal-cycle";
    }
    return "unknown";
}

Direction flip_horizontal(Direction dir) {
    switch (dir) {
        case Direction::Right:
            return Direction::Left;
        case Direction::Left:
            return Direction::Right;
        case Direction::Down:
        case Direction::Up:
            return dir;
    }

    throw std::runtime_error("Unreachable: invalid direction (flip)!");
}

PawnMove flip_horizontal(PawnMove move) {
    return PawnMove{move.pawn, flip_horizontal(move.dir),
                    move.second_dir ? std::optional{flip_horizontal(*move.second_dir)}
                                    : std::nullopt};
}

Winner winner_from_player(Player player) {
    switch (player) {
        case Player::Red:
            return Winner::Red;
        case Player::Blue:
            return Winner::Blue;
    }

    throw std::runtime_error("Unreachable: invalid player!");
}

Player other_player(Player player) {
    switch (player) {
        case Player::Red:
            return Player::Blue;
        case Player::Blue:
            return Player::Red;
    }

    throw std::runtime_error("Unreachable: invalid player!");
}

Cell Cell::step(Direction direction) const {
    switch (direction) {
        case Direction::Right:
            return {column + 1, row};
        case Direction::Down:
            return {column, row + 1};
        case Direction::Left:
            return {column - 1, row};
        case Direction::Up:
            return {column, row - 1};
    }

    throw std::runtime_error("Unreachable: invalid direction (step)!");
}

Wall::Wall(Cell cell, Type type) : cell{cell}, type{type} {}

Wall::Wall(Cell c, Direction dir) {
    switch (dir) {
        case Direction::Right:
            cell = c;
            type = Right;
            return;
        case Direction::Down:
            cell = c;
            type = Down;
            return;
        case Direction::Left:
            cell = {c.column - 1, c.row};
            type = Right;
            return;
        case Direction::Up:
            cell = {c.column, c.row - 1};
            type = Down;
            return;
    }

    throw std::runtime_error("Unreachable: invalid direction (wall)!");
}

Direction Wall::direction() const {
    return type == Wall::Down ? Direction::Down : Direction::Right;
}

namespace std {
std::uint64_t hash<Cell>::operator()(Cell cell) const {
    return folly::hash::hash_combine(cell.column, cell.row);
}

std::uint64_t hash<Wall>::operator()(Wall wall) const {
    return folly::hash::hash_combine(wall.cell, wall.type);
}
}  // namespace std

Turn Turn::next() const {
    if (action == First) {
        return Turn{player, Second};
    } else {
        return Turn{player == Player::Red ? Player::Blue : Player::Red, First};
    }
}

Turn Turn::prev() const {
    if (action == Second) {
        return Turn{player, First};
    } else {
        return Turn{player == Player::Red ? Player::Blue : Player::Red, Second};
    }
}

std::string cell_notation(Cell cell, int rows) {
    // Flip row: internal row 0 is at top, official row 1 is at bottom
    // For a board with R rows: internal row r -> official row (R - r)
    int official_row = rows - cell.row;
    if (official_row < 1 || cell.column < 0 ||
        cell.column >= int(kColumnLabels.size())) {
        throw std::runtime_error(std::format(
            "Cell coordinates ({}, {}) cannot be expressed as standard notation for {} rows",
            cell.column, cell.row, rows));
    }
    std::stringstream out;
    out << kColumnLabels[cell.column] << official_row;
    return out.str();
}

std::string wall_notation(Wall wall, int rows) {
    std::stringstream out;
    if (wall.type == Wall::Right) {
        // Vertical wall: > followed by cell to the left
        // The reference cell is the wall's stored cell
        out << '>' << cell_notation(wall.cell, rows);
    } else {
        // Horizontal wall: ^ followed by cell below
        // Wall::Down at cell (c, r) is between rows r and r+1 (internal)
        // After row flip: between official rows (R-r) and (R-r-1)
        // The cell below (lower official row) is at internal row r+1
        Cell cell_below = wall.cell.step(Direction::Down);
        out << '^' << cell_notation(cell_below, rows);
    }
    return out.str();
}

static char pawn_notation(Pawn pawn) {
    switch (pawn) {
        case Pawn::Dog: return 'D';
        case Pawn::Cat: return 'C';
        case Pawn::Mouse: return 'M';
        case Pawn::Elephant: return 'E';
        case Pawn::Home: break;
    }
    throw std::runtime_error("Invalid pawn");
}

/*
The terms keep the order the move was PLAYED in, except for walls among themselves.

Both readers apply the terms in sequence - `parse_move_notation` resolves each one
against the board as it stands at that term, and the wallgame server feeds the same
string through its own rules - so a term can depend on the one before it. In Animal
Cycle a player may move one pawn out of a cell and the other one into it, and the
fixed order Dog, Cat, Mouse, Elephant sends the follower in first, onto a cell its
teammate has not left yet. Neither reader can apply that, and the move is refused.
This emitter writes the bot's OWN move (bgs_session.cpp), so the refusal lands on the
bot: its turn never takes effect. The wallgame server had the same defect in the
other direction and was fixed on 2026-08-19; this is the mirror of that fix, and the
rule is deliberately identical, so the two sides answer the question the same way.

Walls stay canonical against each other only. A wall merely removes paths, so if the
whole set leaves every player a route then so does every subset: any order of the
same walls is equally legal. A wall may NOT move past a pawn, because a capture ends
a move - a term written after a capturing pawn is never reached, and a wall written
there would be lost.

A pawn that steps twice is still ONE term naming where it ended, and it sits at that
pawn's FIRST action.

The turn holds two actions, one, or none, and the terms are whatever it holds. Nothing
below reads a fixed count: an empty turn is the pass token `---`, and a one-action turn
is a single term. See the header for why a short turn is a legal answer and not a
failure to build a long one.
*/
std::string turn_notation(std::span<Action const> actions, Board const& board, Player player) {
    if (actions.empty()) {
        return "---";
    }

    std::stringstream out;
    std::array<std::optional<Cell>, 4> destinations;
    std::vector<Wall> walls;

    auto apply_pawn_move = [&](PawnMove move) {
        auto& destination = destinations[static_cast<size_t>(move.pawn)];
        Cell start = board.pawn_position(player, move.pawn);

        if (destination) {
            destination = destination->step(move.dir);
        } else {
            destination = start.step(move.dir);
        }
        if (move.second_dir) destination = destination->step(*move.second_dir);
    };

    // First pass: where each pawn ended, and which walls were built.
    for (Action const& action : actions) {
        folly::variant_match(
            action,
            [&](PawnMove move) { apply_pawn_move(move); },
            [&](Wall wall) { walls.push_back(wall); });
    }

    // Sort walls: vertical (Right/>) before horizontal (Down/^), then by column, then by row
    // Note: sorting uses internal coordinates which works because we only care about ordering
    std::sort(walls.begin(), walls.end(), [](Wall const& a, Wall const& b) {
        if (a.type != b.type) {
            return a.type == Wall::Right;  // Right (>) comes before Down (^)
        }
        return a.cell < b.cell;  // Then by cell position
    });

    // Second pass: the played order. A pawn gets its term at its first action; each
    // wall slot takes the next wall in sorted order.
    std::array<bool, 4> emitted{};
    size_t wall_index = 0;
    bool first_action = true;
    for (Action const& action : actions) {
        std::string term;
        if (auto const* move = std::get_if<PawnMove>(&action)) {
            size_t const index = static_cast<size_t>(move->pawn);
            if (emitted[index]) continue;
            emitted[index] = true;
            term = std::string(1, pawn_notation(move->pawn)) +
                cell_notation(*destinations[index], board.rows());
        } else {
            term = wall_notation(walls[wall_index++], board.rows());
        }
        if (!first_action) out << '.';
        out << term;
        first_action = false;
    }

    return out.str();
}

std::string Move::standard_notation(Board const& board, Player player) const {
    std::array<Action, 2> const actions{first, second};
    return turn_notation(actions, board, player);
}

bool turn_must_end_after_action(Board const& board, Player player) {
    if (board.variant() == Variant::AnimalCycle) {
        return board.winner(Turn{player, Turn::Second}) != Winner::Undecided;
    }
    return board.reached_goal(player);
}

std::ostream& operator<<(std::ostream& out, Direction dir) {
    switch (dir) {
        case Direction::Right:
            out << "Right";
            break;
        case Direction::Down:
            out << "Down";
            break;
        case Direction::Left:
            out << "Left";
            break;
        case Direction::Up:
            out << "Up";
            break;
        default:
            out << "??";
    }

    return out;
}

std::ostream& operator<<(std::ostream& out, Player player) {
    switch (player) {
        case Player::Red:
            out << "Red";
            break;
        case Player::Blue:
            out << "Blue";
            break;
        default:
            out << "??";
    }

    return out;
}

std::ostream& operator<<(std::ostream& out, Pawn pawn) {
    switch (pawn) {
        case Pawn::Cat:
            out << "Cat";
            break;
        case Pawn::Mouse:
            out << "Mouse";
            break;
        case Pawn::Home:
            out << "Home";
            break;
        default:
            out << "??";
    }

    return out;
}

std::ostream& operator<<(std::ostream& out, Cell cell) {
    if (cell.row < 0 || cell.row >= int(kRowLabels.size()) || cell.column < 0 ||
        cell.column >= int(kColumnLabels.size())) {
        throw std::runtime_error(std::format(
            "Cell coordinates ({}, {}) cannot be expressed as standard notation:", cell.column,
            cell.row));
    }

    out << kColumnLabels[cell.column] << kRowLabels[cell.row];

    return out;
}

std::ostream& operator<<(std::ostream& out, Wall wall) {
    out << (wall.type == Wall::Right ? '>' : '^') << wall.cell;
    return out;
}

std::ostream& operator<<(std::ostream& out, PawnMove const& move) {
    out << move.pawn << ":" << move.dir;
    if (move.second_dir) out << "+" << *move.second_dir;
    return out;
}

std::ostream& operator<<(std::ostream& out, Action const& action) {
    std::visit([&](auto const& action) { out << action; }, action);
    return out;
}

std::ostream& operator<<(std::ostream& out, Move const& move) {
    out << move.first << ' ' << move.second;
    return out;
}

std::ostream& operator<<(std::ostream& out, Turn turn) {
    out << turn.player << ":";

    switch (turn.action) {
        case Turn::First:
            out << "First";
            break;
        case Turn::Second:
            out << "Second";
            break;
        default:
            out << "??";
    }

    return out;
}

std::istream& operator>>(std::istream& in, Cell& cell) {
    char column_label;
    char row_label;
    in >> column_label >> row_label;

    cell.column = column_label - 'a';
    cell.row = row_label == 'X' ? 9 : row_label - '1';

    // TODO: validate

    return in;
}

std::istream& operator>>(std::istream& in, Wall& wall) {
    char dir;
    in >> dir >> wall.cell;

    switch (dir) {
        case '^':
            wall.type = Wall::Down;
            break;
        case '>':
            wall.type = Wall::Right;
            break;
        default:
            throw std::runtime_error("Invalid wall direction!");
    }

    return in;
}

std::istream& operator>>(std::istream& in, Direction& dir) {
    std::string direction;
    in >> direction;

    if (direction == "right") {
        dir = Direction::Right;
    } else if (direction == "left") {
        dir = Direction::Left;
    } else if (direction == "down") {
        dir = Direction::Down;
    } else if (direction == "up") {
        dir = Direction::Up;
    } else {
        throw std::runtime_error("Invalid direction!");
    }

    return in;
}

namespace {
std::size_t pawn_index(Pawn pawn) {
    return static_cast<std::size_t>(pawn);
}
}  // namespace

Board::Board(int columns, int rows, Variant variant, std::vector<PawnPlacement> placements)
    : m_columns{columns},
      m_rows{rows},
      m_variant{variant},
      m_board(columns * rows) {
    for (PawnPlacement const& placement : placements) {
        auto const roster = pawn_roster(placement.player);
        if (std::find(roster.begin(), roster.end(), placement.pawn) == roster.end()) {
            throw std::runtime_error("Pawn does not belong to this variant");
        }
        if (placement.cell.column < 0 || placement.cell.row < 0 ||
            placement.cell.column >= columns || placement.cell.row >= rows) {
            throw std::runtime_error("Pawn placement is outside the board");
        }
        auto& slot = pawn_slots(placement.player)[pawn_index(placement.pawn)];
        if (slot) {
            throw std::runtime_error("Duplicate pawn placement");
        }
        slot = placement.cell;
    }

    for (Player player : {Player::Red, Player::Blue}) {
        for (Pawn pawn : pawn_roster(player)) {
            if (!has_pawn(player, pawn)) {
                throw std::runtime_error("Missing pawn placement for variant");
            }
        }
    }
}

Board::Board(int columns, int rows, Variant variant)
    : Board{columns, rows, variant,
            variant == Variant::Classic
                ? std::vector<PawnPlacement>{{Player::Red, Pawn::Cat, {0, 0}},
                                             {Player::Red, Pawn::Home, {columns - 1, rows - 1}},
                                             {Player::Blue, Pawn::Cat, {columns - 1, 0}},
                                             {Player::Blue, Pawn::Home, {0, rows - 1}}}
                : variant == Variant::Standard
                    ? std::vector<PawnPlacement>{{Player::Red, Pawn::Cat, {0, 0}},
                                                 {Player::Red, Pawn::Mouse, {0, rows - 1}},
                                                 {Player::Blue, Pawn::Cat, {columns - 1, 0}},
                                                 {Player::Blue, Pawn::Mouse,
                                                  {columns - 1, rows - 1}}}
                    : std::vector<PawnPlacement>{{Player::Red, Pawn::Cat, {0, 0}},
                                                 {Player::Red, Pawn::Elephant,
                                                  {columns - 1, rows - 1}},
                                                 {Player::Blue, Pawn::Mouse, {columns - 1, 0}},
                                                 {Player::Blue, Pawn::Dog, {0, rows - 1}}}} {}

bool Board::is_blocked(Wall wall) const {
    if (wall.cell.column < 0 || wall.cell.row < 0 || wall.cell.column >= m_columns ||
        wall.cell.row >= m_rows) {
        return true;
    }

    if (wall.type == Wall::Down) {
        if (wall.cell.row == m_rows - 1) {
            return true;
        }

        State const state = state_at(wall.cell);

        if (state.has_red_down_wall || state.has_blue_down_wall) {
            return true;
        }
    } else {
        if (wall.cell.column == m_columns - 1) {
            return true;
        }

        State const state = state_at(wall.cell);

        if (state.has_red_right_wall || state.has_blue_right_wall) {
            return true;
        }
    }

    return false;
}

std::vector<Direction> Board::legal_directions(Player player) const {
    return legal_directions(player, Pawn::Cat);
}

std::vector<Direction> Board::legal_directions(Player player, Pawn pawn) const {
    if (!has_pawn(player, pawn) || !pawn_is_movable(pawn)) {
        return {};
    }
    Cell const pos = pawn_position(player, pawn);
    auto dirs = kDirections | views::filter([&](Direction dir) {
        if (is_blocked({pos, dir})) return false;
        if (m_variant == Variant::AnimalCycle) {
            auto pawns = movable_pawns(player);
            Pawn teammate = pawns[0] == pawn ? pawns[1] : pawns[0];
            if (pos.step(dir) == pawn_position(player, teammate)) return false;
        }
        return true;
    });
    return {dirs.begin(), dirs.end()};
}

void Board::find_bridges(Cell start, Cell target, std::vector<int>& levels, std::set<Wall>& bridges,
                         std::vector<Board::StackFrame>& stack) const {
    // Initialize start cell
    levels[index_from_cell(start)] = 1;
    stack[0] = {start, 1, 0, start == target, 1};
    int stack_size = 1;

    while (stack_size > 0) {
        auto& frame = stack[stack_size - 1];

        // Look for unprocessed neighbors starting from current dir_index
        bool found_unprocessed = false;
        for (int dir_idx = frame.dir_index; dir_idx < 4; ++dir_idx) {
            Direction dir = kDirections[dir_idx];
            Wall wall{frame.cell, dir};

            if (is_blocked(wall))
                continue;

            Cell neighbor = frame.cell.step(dir);
            int neighbor_level = levels[index_from_cell(neighbor)];

            if (neighbor_level == frame.level - 1)
                continue;  // parent

            if (neighbor_level == -1) {
                // Found unprocessed neighbor - add to stack
                levels[index_from_cell(neighbor)] = frame.level + 1;
                frame.dir_index = dir_idx + 1;  // Resume from next direction when we return
                stack[stack_size++] = {neighbor, frame.level + 1, 0, neighbor == target,
                                       frame.level + 1};
                found_unprocessed = true;
                break;
            } else {
                // Already visited - update min_level
                frame.min_level = std::min(frame.min_level, neighbor_level);
            }
        }

        if (!found_unprocessed) {
            // All neighbors processed - do postprocessing and pop
            stack_size--;

            if (stack_size > 0) {
                auto& parent = stack[stack_size - 1];
                parent.target_found = parent.target_found || frame.target_found;
                parent.min_level = std::min(parent.min_level, frame.min_level);

                // Check bridge condition
                if (frame.target_found && frame.min_level > parent.level) {
                    Direction dir = kDirections[parent.dir_index - 1];
                    bridges.insert({parent.cell, dir});
                }
            }
        }
    }
}

std::vector<Wall> Board::legal_walls() const {
    if (m_variant == Variant::AnimalCycle) {
        std::vector<Wall> result;
        for (int column = 0; column < m_columns; ++column) {
            for (int row = 0; row < m_rows; ++row) {
                for (Wall::Type type : {Wall::Down, Wall::Right}) {
                    Wall wall{{column, row}, type};
                    if (is_blocked(wall)) continue;
                    bool legal =
                        path_exists(pawn_position(Player::Red, Pawn::Cat),
                                    pawn_position(Player::Blue, Pawn::Mouse), wall) &&
                        path_exists(pawn_position(Player::Blue, Pawn::Mouse),
                                    pawn_position(Player::Red, Pawn::Elephant), wall) &&
                        path_exists(pawn_position(Player::Red, Pawn::Elephant),
                                    pawn_position(Player::Blue, Pawn::Dog), wall) &&
                        path_exists(pawn_position(Player::Blue, Pawn::Dog),
                                    pawn_position(Player::Red, Pawn::Cat), wall);
                    if (legal) result.push_back(wall);
                }
            }
        }
        return result;
    }
    std::set<Wall> illegal_walls;
    std::vector<int> levels(m_columns * m_rows, -1);
    std::vector<StackFrame> stack(m_columns * m_rows);
    for (auto const& [start, target] : required_path_endpoints()) {
        find_bridges(start, target, levels, illegal_walls, stack);
        ranges::fill(levels, -1);
    }

    std::vector<Wall> result;

    for (int column = 0; column < m_columns; ++column) {
        for (int row = 0; row < m_rows; ++row) {
            for (Wall::Type type : {Wall::Down, Wall::Right}) {
                Wall const wall{{column, row}, type};

                if (!is_blocked(wall) && !illegal_walls.contains(wall)) {
                    result.push_back(wall);
                }
            }
        }
    }

    return result;
}

std::vector<Action> Board::legal_actions(Player player) const {
    // Inefficient but whatever for now
    auto const walls = legal_walls();

    std::vector<Action> result;
    for (Pawn pawn : movable_pawns(player)) {
        for (Direction dir : legal_directions(player, pawn)) {
            result.emplace_back(PawnMove{pawn, dir});
        }
    }
    result.insert(result.end(), walls.begin(), walls.end());

    return result;
}

void Board::take_step(Player player, Direction dir) {
    take_step(player, Pawn::Cat, dir);
}

void Board::take_step(Player player, Pawn pawn, Direction dir) {
    if (!has_pawn(player, pawn) || !pawn_is_movable(pawn)) {
        throw std::runtime_error("Pawn cannot move in this variant");
    }
    Cell& position = *pawn_slots(player)[pawn_index(pawn)];

    if (is_blocked({position, dir})) {
        throw std::runtime_error("Trying to move through blocked wall!");
    }

    position = position.step(dir);
}

void Board::place_wall(Player player, Wall wall) {
    State& state = state_at(wall.cell);

    if (is_blocked(wall)) {
        throw std::runtime_error("Trying to place on top of existing wall!");
    }

    // TODO: should at least add a debug check for disconnecting players from their goals?

    if (player == Player::Red) {
        if (wall.type == Wall::Right) {
            state.has_red_right_wall = true;
        } else {
            state.has_red_down_wall = true;
        }
    } else {
        if (wall.type == Wall::Right) {
            state.has_blue_right_wall = true;
        } else {
            state.has_blue_down_wall = true;
        }
    }
}

void Board::do_action(Player player, Action action) {
    folly::variant_match(
        action,
        [&](PawnMove move) {
            if (m_variant == Variant::AnimalCycle) {
                auto const pawns = movable_pawns(player);
                Pawn const teammate = pawns[0] == move.pawn ? pawns[1] : pawns[0];
                Cell const teammate_cell = pawn_position(player, teammate);
                Cell const intermediate = pawn_position(player, move.pawn).step(move.dir);
                if (intermediate == teammate_cell ||
                    (move.second_dir && intermediate.step(*move.second_dir) == teammate_cell)) {
                    throw std::runtime_error("Animal Cycle teammates cannot share a cell");
                }
            }
            take_step(player, move.pawn, move.dir);
            if (move.second_dir) {
                take_step(player, move.pawn, *move.second_dir);
            }
        },
        [&](Wall wall) { place_wall(player, wall); });
}

bool Board::reached_goal(Player player) const {
    return position(player) == goal(player);
}

Winner Board::winner() const {
    if (m_variant == Variant::AnimalCycle) return animal_cycle_winner();
    if (reached_goal(Player::Red)) {
        int dist = distance(position(Player::Blue), goal(Player::Blue));
        if (dist <= 2 && dist != -1) {
            return Winner::Draw;
        }
        return Winner::Red;
    }

    if (reached_goal(Player::Blue)) {
        return Winner::Blue;
    }

    return Winner::Undecided;
}

Winner Board::winner(Turn turn) const {
    if (m_variant == Variant::AnimalCycle) return winner();
    if (turn.action == Turn::Second) {
        return Winner::Undecided;
    }

    return winner();
}

double Board::score_for(Player player) const {
    // Only the phase matters below, so the player carried by this turn is arbitrary.
    return score_for(player, Turn{player, Turn::First});
}

double Board::score_for(Player player, Turn turn) const {
    Winner current_winner = winner(turn);

    if (current_winner == Winner::Draw) {
        return 0.0;
    }

    if (current_winner == Winner::Red) {
        return player == Player::Red ? 1.0 : -1.0;
    }

    if (current_winner == Winner::Blue) {
        return player == Player::Blue ? 1.0 : -1.0;
    }

    if (m_variant == Variant::AnimalCycle) {
        double red_dist = std::min(
            distance(pawn_position(Player::Red, Pawn::Cat),
                     pawn_position(Player::Blue, Pawn::Mouse)),
            distance(pawn_position(Player::Red, Pawn::Elephant),
                     pawn_position(Player::Blue, Pawn::Dog)));
        double blue_dist = std::min(
            distance(pawn_position(Player::Blue, Pawn::Mouse),
                     pawn_position(Player::Red, Pawn::Elephant)),
            distance(pawn_position(Player::Blue, Pawn::Dog),
                     pawn_position(Player::Red, Pawn::Cat)));
        double mine = player == Player::Red ? red_dist : blue_dist;
        double theirs = player == Player::Red ? blue_dist : red_dist;
        return mine < theirs ? 1.0 - mine / theirs : -1.0 + theirs / mine;
    }

    double dist = distance(position(player), goal(player));
    Player opponent = other_player(player);
    double opponent_dist = distance(position(opponent), goal(opponent));

    // Mid-turn a pawn may be standing on the cell where a capture WOULD be judged, which reads here
    // as a distance of zero - a capture the rules have not made yet. Taken literally the formula
    // below returns an exact win or an exact loss, so the search would either bank a capture that
    // can still be walked off or shun a walk-past it is now allowed to make; with a zero on BOTH
    // sides it would divide zero by zero.
    //
    // One step is the honest proxy rather than a guarantee: the pawn is about to move aside and the
    // other one is right behind it, though the mover is free to spend its second action elsewhere
    // and lose. Substituted on WHICHEVER distance is zero, so the score stays antisymmetric between
    // the two players. Neither substitution can fire at a turn boundary: a zero there means someone
    // has reached their goal, and `winner()` has already returned above.
    if (turn.action == Turn::Second) {
        if (dist == 0) {
            dist = 1;
        }
        if (opponent_dist == 0) {
            opponent_dist = 1;
        }
    }

    return dist < opponent_dist ? 1.0 - dist / opponent_dist : -1.0 + opponent_dist / dist;
}

int Board::distance(Cell start, Cell target) const {
    std::vector<bool> visited(m_columns * m_rows, false);
    std::deque<std::pair<Cell, int>> queue = {{start, 0}};

    while (!queue.empty()) {
        auto const [top, dist] = queue.front();
        queue.pop_front();

        if (top == target) {
            return dist;
        }

        visited[index_from_cell(top)] = true;

        for (Direction dir : kDirections) {
            if (is_blocked({top, dir})) {
                continue;
            }

            Cell const neighbor = top.step(dir);

            if (!visited[index_from_cell(neighbor)]) {
                queue.push_back({neighbor, dist + 1});
            }
        }
    }

    return -1;
}

void Board::fill_relative_distances(Cell start, std::span<float> dists) const {
    if (int(dists.size()) != m_columns * m_rows) {
        throw std::runtime_error("dists size does not match!");
    }

    std::vector<std::pair<Cell, int>> queue_vec;
    std::ranges::fill(dists, 1.0f);
    fill_relative_distances(start, dists, blocked_directions(), queue_vec);
}

std::vector<std::array<bool, 4>> Board::blocked_directions() const {
    std::vector<std::array<bool, 4>> result(m_columns * m_rows);

    for (int i = 0; i < m_columns * m_rows; ++i) {
        Cell cell = cell_at_index(i);

        for (Direction dir : kDirections) {
            result[i][int(dir)] = is_blocked({cell, dir});
        }
    }

    return result;
}

void Board::fill_relative_distances(Cell start, std::span<float> dists,
                                    std::vector<std::array<bool, 4>> const& blocked_dirs,
                                    std::vector<std::pair<Cell, int>>& queue_vec) const {
    int const board_size = m_columns * m_rows;
    if (int(dists.size()) != board_size) {
        throw std::runtime_error("dists size does not match board size!");
    }

    float const scaling_factor = 1.0f / board_size;

    queue_vec.clear();
    queue_vec.reserve(static_cast<size_t>(board_size));

    dists[index_from_cell(start)] = 0.0f;
    queue_vec.push_back({start, 0});

    size_t queue_head = 0;
    while (queue_head < queue_vec.size()) {
        auto const [top, dist] = queue_vec[queue_head++];
        int top_index = index_from_cell(top);

        for (Direction dir : kDirections) {
            if (blocked_dirs[top_index][int(dir)]) {
                continue;
            }

            Cell const neighbor = top.step(dir);
            int neighbor_index = index_from_cell(neighbor);

            if (dists[neighbor_index] == 1.0f) {
                queue_vec.push_back({neighbor, dist + 1});
                dists[neighbor_index] = (dist + 1) * scaling_factor;
            }
        }
    }
}

Cell Board::cell_at_index(int i) const {
    return {i / m_rows, i % m_rows};
}

int Board::index_from_cell(Cell cell) const {
    return cell.column * m_rows + cell.row;
}

Cell Board::position(Player player) const {
    if (m_variant == Variant::AnimalCycle) {
        return pawn_position(player, player == Player::Red ? Pawn::Cat : Pawn::Mouse);
    }
    return pawn_position(player, Pawn::Cat);
}

Cell Board::mouse(Player player) const {
    if (m_variant == Variant::AnimalCycle) {
        return pawn_position(player, player == Player::Red ? Pawn::Elephant : Pawn::Dog);
    }
    return pawn_position(player, Pawn::Mouse);
}

Cell Board::home(Player player) const {
    return pawn_position(player, Pawn::Home);
}

Cell Board::goal(Player player) const {
    switch (m_variant) {
        case Variant::Classic:
            return home(player);
        case Variant::Standard:
            return mouse(other_player(player));
        case Variant::AnimalCycle:
            return player == Player::Red
                ? pawn_position(Player::Blue, Pawn::Mouse)
                : pawn_position(Player::Red, Pawn::Elephant);
    }
    throw std::runtime_error("Unsupported variant");
}

Cell Board::pawn_position(Player player, Pawn pawn) const {
    auto const& slot = pawn_slots(player)[pawn_index(pawn)];
    if (!slot) {
        throw std::runtime_error("Pawn is not present in this variant");
    }
    return *slot;
}

bool Board::has_pawn(Player player, Pawn pawn) const {
    return pawn_slots(player)[pawn_index(pawn)].has_value();
}

bool Board::pawn_is_movable(Pawn pawn) const {
    switch (m_variant) {
        case Variant::Classic:
            return pawn == Pawn::Cat;
        case Variant::Standard:
            return pawn == Pawn::Cat || pawn == Pawn::Mouse;
        case Variant::AnimalCycle:
            return pawn == Pawn::Dog || pawn == Pawn::Cat || pawn == Pawn::Mouse ||
                pawn == Pawn::Elephant;
    }
    return false;
}

std::vector<Pawn> Board::pawn_roster(Player player) const {
    switch (m_variant) {
        case Variant::Classic:
            return {Pawn::Cat, Pawn::Home};
        case Variant::Standard:
            return {Pawn::Cat, Pawn::Mouse};
        case Variant::AnimalCycle:
            return player == Player::Red
                ? std::vector{Pawn::Cat, Pawn::Elephant}
                : std::vector{Pawn::Mouse, Pawn::Dog};
    }
    return {};
}

std::vector<Pawn> Board::movable_pawns(Player player) const {
    std::vector<Pawn> result;
    for (Pawn pawn : pawn_roster(player)) {
        if (pawn_is_movable(pawn)) result.push_back(pawn);
    }
    return result;
}

std::vector<std::pair<Cell, Cell>> Board::required_path_endpoints() const {
    if (m_variant == Variant::AnimalCycle) {
        return {
            {pawn_position(Player::Red, Pawn::Cat),
             pawn_position(Player::Blue, Pawn::Mouse)},
            {pawn_position(Player::Blue, Pawn::Mouse),
             pawn_position(Player::Red, Pawn::Elephant)},
            {pawn_position(Player::Red, Pawn::Elephant),
             pawn_position(Player::Blue, Pawn::Dog)},
            {pawn_position(Player::Blue, Pawn::Dog),
             pawn_position(Player::Red, Pawn::Cat)},
        };
    }
    return {{position(Player::Blue), goal(Player::Blue)},
            {position(Player::Red), goal(Player::Red)}};
}

std::pair<Cell, Cell> Board::model_landmarks(Player player) const {
    return {position(player), goal(player)};
}

Winner Board::animal_cycle_winner() const {
    if (pawn_position(Player::Red, Pawn::Cat) ==
        pawn_position(Player::Blue, Pawn::Mouse)) return Winner::Red;
    if (pawn_position(Player::Blue, Pawn::Mouse) ==
        pawn_position(Player::Red, Pawn::Elephant)) return Winner::Blue;
    if (pawn_position(Player::Red, Pawn::Elephant) ==
        pawn_position(Player::Blue, Pawn::Dog)) return Winner::Red;
    if (pawn_position(Player::Blue, Pawn::Dog) ==
        pawn_position(Player::Red, Pawn::Cat)) return Winner::Blue;
    return Winner::Undecided;
}

Variant Board::variant() const {
    return m_variant;
}

bool Board::allows_mouse_moves() const {
    return pawn_is_movable(Pawn::Mouse);
}

int Board::move_prior_size() const {
    return allows_mouse_moves() ? 8 : 4;
}

int Board::columns() const {
    return m_columns;
}

int Board::rows() const {
    return m_rows;
}

Board::State& Board::state_at(Cell cell) {
    return m_board[index_from_cell(cell)];
}

Board::State Board::state_at(Cell cell) const {
    return m_board[index_from_cell(cell)];
}

Board::PawnSlots& Board::pawn_slots(Player player) {
    return player == Player::Red ? m_red_pawns : m_blue_pawns;
}

Board::PawnSlots const& Board::pawn_slots(Player player) const {
    return player == Player::Red ? m_red_pawns : m_blue_pawns;
}

Cell Board::flip_horizontal(Cell cell) const {
    return {m_columns - 1 - cell.column, cell.row};
}

Wall Board::flip_horizontal(Wall wall) const {
    return Wall{flip_horizontal(wall.cell), ::flip_horizontal(wall.direction())};
}

std::uint64_t std::hash<Board>::operator()(Board const& board) const {
    std::uint64_t position_hash = board.variant() == Variant::AnimalCycle
        ? folly::hash::hash_combine(
              board.pawn_position(Player::Red, Pawn::Cat),
              board.pawn_position(Player::Red, Pawn::Elephant),
              board.pawn_position(Player::Blue, Pawn::Mouse),
              board.pawn_position(Player::Blue, Pawn::Dog), board.variant())
        : folly::hash::hash_combine(
              board.position(Player::Red), board.goal(Player::Red),
              board.position(Player::Blue), board.goal(Player::Blue), board.variant());

    return folly::hash::hash_range(
        board.m_board.begin(), board.m_board.end(), position_hash,
        [](Board::State state) { return std::bit_cast<std::uint8_t>(state); });
}

bool Board::path_exists(Cell start, Cell target, std::optional<Wall> extra_wall) const {
    std::vector<bool> visited(m_columns * m_rows, false);
    std::deque<Cell> queue{start};
    while (!queue.empty()) {
        Cell cell = queue.front(); queue.pop_front();
        if (cell == target) return true;
        int index = index_from_cell(cell);
        if (visited[index]) continue;
        visited[index] = true;
        for (Direction dir : kDirections) {
            Wall edge{cell, dir};
            if (is_blocked(edge) || (extra_wall && edge == *extra_wall)) continue;
            Cell next = cell.step(dir);
            if (!visited[index_from_cell(next)]) queue.push_back(next);
        }
    }
    return false;
}

std::optional<Player> Board::wall_owner(Wall wall) const {
    if (!is_blocked(wall)) {
        return std::nullopt;
    }
    State const state = state_at(wall.cell);
    if (wall.type == Wall::Down) {
        if (state.has_red_down_wall) {
            return Player::Red;
        } else if (state.has_blue_down_wall) {
            return Player::Blue;
        }
    } else {  // Wall::Right
        if (state.has_red_right_wall) {
            return Player::Red;
        } else if (state.has_blue_right_wall) {
            return Player::Blue;
        }
    }
    return std::nullopt;
}
