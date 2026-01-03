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
    return std::nullopt;
}

std::string_view variant_name(Variant variant) {
    switch (variant) {
        case Variant::Classic:
            return "classic";
        case Variant::Standard:
            return "standard";
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
    return PawnMove{move.pawn, flip_horizontal(move.dir)};
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
    if (official_row < 1 || official_row > int(kRowLabels.size()) || cell.column < 0 ||
        cell.column >= int(kColumnLabels.size())) {
        throw std::runtime_error(std::format(
            "Cell coordinates ({}, {}) cannot be expressed as standard notation for {} rows",
            cell.column, cell.row, rows));
    }
    std::stringstream out;
    out << kColumnLabels[cell.column] << kRowLabels[official_row - 1];
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

std::string Move::standard_notation(Cell cat_start, Cell mouse_start, int rows) const {
    std::stringstream out;

    // Collect direction and wall actions separately
    std::optional<Cell> cat_destination;
    std::optional<Cell> mouse_destination;
    std::vector<Wall> walls;

    auto apply_pawn_move = [&](PawnMove move) {
        std::optional<Cell>& destination = move.pawn == Pawn::Cat ? cat_destination
                                                                  : mouse_destination;
        Cell start = move.pawn == Pawn::Cat ? cat_start : mouse_start;

        if (destination) {
            destination = destination->step(move.dir);
        } else {
            destination = start.step(move.dir);
        }
    };

    // Process first action
    folly::variant_match(
        first,
        [&](PawnMove move) { apply_pawn_move(move); },
        [&](Wall wall) { walls.push_back(wall); });

    // Process second action
    folly::variant_match(
        second,
        [&](PawnMove move) { apply_pawn_move(move); },
        [&](Wall wall) { walls.push_back(wall); });

    // Sort walls: vertical (Right/>) before horizontal (Down/^), then by column, then by row
    // Note: sorting uses internal coordinates which works because we only care about ordering
    std::sort(walls.begin(), walls.end(), [](Wall const& a, Wall const& b) {
        if (a.type != b.type) {
            return a.type == Wall::Right;  // Right (>) comes before Down (^)
        }
        return a.cell < b.cell;  // Then by cell position
    });

    // Output in order: cat move, mouse move, then walls, separated by periods
    bool first_action = true;
    if (cat_destination) {
        out << 'C' << cell_notation(*cat_destination, rows);
        first_action = false;
    }
    if (mouse_destination) {
        if (!first_action) {
            out << '.';
        }
        out << 'M' << cell_notation(*mouse_destination, rows);
        first_action = false;
    }
    for (Wall const& wall : walls) {
        if (!first_action) {
            out << '.';
        }
        out << wall_notation(wall, rows);
        first_action = false;
    }

    return out.str();
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

Board::Board(int columns, int rows, Cell red_cat, Cell red_mouse, Cell blue_cat, Cell blue_mouse,
             Variant variant)
    : m_red{red_cat, red_mouse},
      m_blue{blue_cat, blue_mouse},
      m_columns{columns},
      m_rows{rows},
      m_variant{variant},
      m_board(columns * rows) {
    state_at(red_cat).has_red_cat = true;
    state_at(blue_cat).has_blue_cat = true;
    state_at(red_mouse).has_red_mouse = true;
    state_at(blue_mouse).has_blue_mouse = true;
}

Board::Board(int columns, int rows, Variant variant)
    : Board{columns,
            rows,
            {0, 0},
            {0, rows - 1},
            {columns - 1, 0},
            {columns - 1, rows - 1},
            variant} {}

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
    if (pawn == Pawn::Mouse && !allows_mouse_moves()) {
        return {};
    }
    Cell const pos = pawn_position(player, pawn);
    auto dirs = kDirections | views::filter([&](Direction dir) { return !is_blocked({pos, dir}); });
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
    std::set<Wall> illegal_walls;
    std::vector<int> levels(m_columns * m_rows, -1);
    std::vector<StackFrame> stack(m_columns * m_rows);
    find_bridges(position(Player::Blue), goal(Player::Blue), levels, illegal_walls, stack);
    ranges::fill(levels, -1);
    find_bridges(position(Player::Red), goal(Player::Red), levels, illegal_walls, stack);

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
    auto const cat_dirs = legal_directions(player, Pawn::Cat);
    auto const mouse_dirs =
        allows_mouse_moves() ? legal_directions(player, Pawn::Mouse) : std::vector<Direction>{};
    auto const walls = legal_walls();

    std::vector<Action> result;
    result.reserve(cat_dirs.size() + mouse_dirs.size() + walls.size());
    for (Direction dir : cat_dirs) {
        result.emplace_back(PawnMove{Pawn::Cat, dir});
    }
    for (Direction dir : mouse_dirs) {
        result.emplace_back(PawnMove{Pawn::Mouse, dir});
    }
    result.insert(result.end(), walls.begin(), walls.end());

    return result;
}

void Board::take_step(Player player, Direction dir) {
    take_step(player, Pawn::Cat, dir);
}

void Board::take_step(Player player, Pawn pawn, Direction dir) {
    PlayerState& player_state = player == Player::Red ? m_red : m_blue;
    Cell& position = pawn == Pawn::Cat ? player_state.cat : player_state.mouse;

    if (is_blocked({position, dir})) {
        throw std::runtime_error("Trying to move through blocked wall!");
    }

    State& state = state_at(position);

    if (player == Player::Red) {
        if (pawn == Pawn::Cat) {
            state.has_red_cat = false;
        } else {
            state.has_red_mouse = false;
        }
        position = position.step(dir);
        if (pawn == Pawn::Cat) {
            state_at(position).has_red_cat = true;
        } else {
            state_at(position).has_red_mouse = true;
        }
    } else {
        if (pawn == Pawn::Cat) {
            state.has_blue_cat = false;
        } else {
            state.has_blue_mouse = false;
        }
        position = position.step(dir);
        if (pawn == Pawn::Cat) {
            state_at(position).has_blue_cat = true;
        } else {
            state_at(position).has_blue_mouse = true;
        }
    }
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
            if (move.pawn == Pawn::Mouse && !allows_mouse_moves()) {
                throw std::runtime_error("Mouse cannot move in classic variant");
            }
            take_step(player, move.pawn, move.dir);
        },
        [&](Wall wall) { place_wall(player, wall); });
}

Winner Board::winner() const {
    if (m_red.cat == m_blue.mouse) {
        int dist = distance(m_blue.cat, m_red.mouse);
        if (dist <= 2 && dist != -1) {
            return Winner::Draw;
        }
        return Winner::Red;
    }

    if (m_blue.cat == m_red.mouse) {
        return Winner::Blue;
    }

    return Winner::Undecided;
}

double Board::score_for(Player player) const {
    Winner current_winner = winner();

    if (current_winner == Winner::Draw) {
        return 0.0;
    }

    if (current_winner == Winner::Red) {
        return player == Player::Red ? 1.0 : -1.0;
    }

    if (current_winner == Winner::Blue) {
        return player == Player::Blue ? 1.0 : -1.0;
    }

    double dist = distance(position(player), goal(player));
    Player opponent = other_player(player);
    double opponent_dist = distance(position(opponent), goal(opponent));

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
    return player == Player::Red ? m_red.cat : m_blue.cat;
}

Cell Board::mouse(Player player) const {
    return player == Player::Red ? m_red.mouse : m_blue.mouse;
}

Cell Board::goal(Player player) const {
    return mouse(other_player(player));
}

Cell Board::pawn_position(Player player, Pawn pawn) const {
    if (pawn == Pawn::Cat) {
        return position(player);
    }
    return mouse(player);
}

Variant Board::variant() const {
    return m_variant;
}

bool Board::allows_mouse_moves() const {
    return m_variant == Variant::Standard;
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

Cell Board::flip_horizontal(Cell cell) const {
    return {m_columns - 1 - cell.column, cell.row};
}

Wall Board::flip_horizontal(Wall wall) const {
    return Wall{flip_horizontal(wall.cell), ::flip_horizontal(wall.direction())};
}

std::uint64_t std::hash<Board>::operator()(Board const& board) const {
    std::uint64_t position_hash =
        folly::hash::hash_combine(board.position(Player::Red), board.position(Player::Blue),
                                  board.mouse(Player::Red), board.mouse(Player::Blue),
                                  board.variant());

    return folly::hash::hash_range(
        board.m_board.begin(), board.m_board.end(), position_hash,
        [](Board::State state) { return std::bit_cast<std::uint8_t>(state); });
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
