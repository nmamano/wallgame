#pragma once

#include <array>
#include <compare>
#include <cstdint>
#include <iosfwd>
#include <optional>
#include <set>
#include <span>
#include <string_view>
#include <variant>
#include <vector>

enum class Direction {
    Right,
    Down,
    Left,
    Up
};

constexpr std::array<Direction, 4> kDirections = {Direction::Right, Direction::Down,
                                                  Direction::Left, Direction::Up};

[[nodiscard]] Direction flip_horizontal(Direction dir);

enum class Player {
    Red,
    Blue
};

enum class Variant {
    Classic,
    Standard
};

// Parses rules identities only. External compatibility names are normalized by
// the protocol adapter before they enter core game code.
std::optional<Variant> parse_variant(std::string_view variant);
std::string_view variant_name(Variant variant);

enum class Winner {
    Red,
    Blue,
    Draw,
    Undecided
};

Winner winner_from_player(Player player);
Player other_player(Player player);

struct Cell {
    int column;
    int row;

    std::strong_ordering operator<=>(Cell const& other) const = default;
    bool operator==(Cell const& other) const = default;

    [[nodiscard]] Cell step(Direction direction) const;
};

struct Wall {
    Cell cell;
    enum Type {
        Right,
        Down
    } type;

    Wall() = default;
    Wall(Cell cell, Type type);
    Wall(Cell cell, Direction direction);

    Direction direction() const;

    std::strong_ordering operator<=>(Wall const& other) const = default;
    bool operator==(Wall const& other) const = default;
};

enum class Pawn {
    Cat,
    Mouse
};

struct PawnMove {
    Pawn pawn;
    Direction dir;

    bool operator==(PawnMove const& other) const = default;
};

[[nodiscard]] PawnMove flip_horizontal(PawnMove move);

struct PreviousPosition {
    Pawn pawn;
    Cell cell;

    bool operator==(PreviousPosition const& other) const = default;
};

namespace std {
template <>
struct hash<Cell> {
    std::uint64_t operator()(Cell cell) const;
};

template <>
struct hash<Wall> {
    std::uint64_t operator()(Wall wall) const;
};

}  // namespace std

using Action = std::variant<PawnMove, Wall>;

struct Move {
    Action first;
    Action second;

    std::string standard_notation(Cell cat_start, Cell mouse_start, int rows) const;
};

// Helper functions for official notation output with row coordinate flipping
// (internal rows grow downward, official rows grow upward)
std::string cell_notation(Cell cell, int rows);
std::string wall_notation(Wall wall, int rows);

struct Turn {
    Player player;
    enum {
        First,
        Second
    } action;

    bool operator==(Turn const& other) const = default;

    [[nodiscard]] Turn next() const;
    [[nodiscard]] Turn prev() const;
};

std::ostream& operator<<(std::ostream& out, Direction dir);
std::ostream& operator<<(std::ostream& out, Player player);
std::ostream& operator<<(std::ostream& out, Pawn pawn);
std::ostream& operator<<(std::ostream& out, Cell cell);
std::ostream& operator<<(std::ostream& out, Wall wall);
std::ostream& operator<<(std::ostream& out, PawnMove const& move);
std::ostream& operator<<(std::ostream& out, Action const& action);
std::ostream& operator<<(std::ostream& out, Move const& move);
std::ostream& operator<<(std::ostream& out, Turn turn);

std::istream& operator>>(std::istream& out, Cell& cell);
std::istream& operator>>(std::istream& out, Wall& wall);
std::istream& operator>>(std::istream& in, Direction& dir);

class Board {
public:
    // Explicit default-board constructor for offline play and generation. BGS
    // serving uses the position constructor with every cell from initialState.
    Board(int columns, int rows, Variant variant = Variant::Classic);
    Board(int columns, int rows, Cell red_cat, Cell red_mouse, Cell blue_cat, Cell blue_mouse,
          Variant variant = Variant::Classic);

    bool operator==(Board const& other) const = default;

    bool is_blocked(Wall wall) const;

    std::vector<Direction> legal_directions(Player player) const;
    std::vector<Direction> legal_directions(Player player, Pawn pawn) const;
    std::vector<Wall> legal_walls() const;
    std::vector<Action> legal_actions(Player player) const;

    void take_step(Player player, Direction direction);
    void take_step(Player player, Pawn pawn, Direction direction);
    void place_wall(Player player, Wall wall);

    void do_action(Player player, Action action);

    // Whether `player`'s cat is standing on its goal. In the standard variant the goal is the
    // opponent's mouse, so this is a capture; in the classic variant the mouse never moves and this
    // is the cat reaching its corner.
    bool reached_goal(Player player) const;

    // The winner judged from the position alone, which is what the rules ask at the END of a turn.
    // Prefer the overload below wherever the turn is known.
    Winner winner() const;

    // The winner judged at a TURN BOUNDARY, the only moment a capture counts. `turn` is the turn
    // about to be played from this position - exactly what TreeNode::turn holds - so a Turn::Second
    // means the previous player is still mid-turn and nothing is decided yet: a pawn may walk
    // THROUGH the cell it would be captured on and out the other side. That holds in both
    // directions, a mouse walking past a cat and a cat walking over a mouse.
    //
    // The TypeScript server judges the same way - it computes both capture checks from the position
    // after BOTH actions (shared/domain/game-state.ts) - and the two MUST agree. When they did not,
    // a human mouse walking past the bot's cat ended the game inside the engine while the server
    // played on, and the session froze mid-turn (board task 8911a6d5).
    Winner winner(Turn turn) const;

    double score_for(Player player) const;
    double score_for(Player player, Turn turn) const;

    Cell position(Player player) const;
    Cell mouse(Player player) const;
    Cell goal(Player player) const;
    Cell pawn_position(Player player, Pawn pawn) const;
    Variant variant() const;
    bool allows_mouse_moves() const;
    int move_prior_size() const;

    int distance(Cell start, Cell target) const;

    // Computes relative distances from a given start cell to all other cells on the board.
    // Distances are normalized to be between 0 and 1.
    void fill_relative_distances(Cell start, std::span<float> dists) const;

    std::optional<Player> wall_owner(Wall wall) const;

    std::vector<std::array<bool, 4>> blocked_directions() const;

    // Optimized version of filL_relative_distances, expects to be given pre-computed blocked
    // directions (see function above), space to keep its internal queue for the BFS (can be empty),
    // and expects distances to already start out initialized to 1.0f.
    void fill_relative_distances(Cell start, std::span<float> dists,
                                 std::vector<std::array<bool, 4>> const& blocked_dirs,
                                 std::vector<std::pair<Cell, int>>& queue_vec) const;

    int columns() const;
    int rows() const;

    Cell cell_at_index(int i) const;
    int index_from_cell(Cell cell) const;

    [[nodiscard]] Cell flip_horizontal(Cell cell) const;
    [[nodiscard]] Wall flip_horizontal(Wall all) const;

private:
    struct State {
        bool has_red_cat : 1 = false;
        bool has_blue_cat : 1 = false;
        bool has_red_right_wall : 1 = false;
        bool has_red_down_wall : 1 = false;
        bool has_blue_right_wall : 1 = false;
        bool has_blue_down_wall : 1 = false;
        bool has_red_mouse : 1 = false;
        bool has_blue_mouse : 1 = false;

        bool operator==(State const& other) const = default;
    };

    struct PlayerState {
        Cell cat;
        Cell mouse;

        bool operator==(PlayerState const& other) const = default;
    } m_red, m_blue;

    friend std::hash<Board>;

    int m_columns;
    int m_rows;
    Variant m_variant;

    std::vector<State> m_board;

    State& state_at(Cell cell);
    State state_at(Cell cell) const;

    struct StackFrame {
        Cell cell;
        int level;
        int dir_index;
        bool target_found;
        int min_level;
    };

    void find_bridges(Cell start, Cell target, std::vector<int>& levels, std::set<Wall>& bridges,
                      std::vector<StackFrame>& stack) const;
};

namespace std {
template <>
struct hash<Board> {
    std::uint64_t operator()(Board const& board) const;
};
}  // namespace std
