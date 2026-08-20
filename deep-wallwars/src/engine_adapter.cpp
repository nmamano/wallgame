#include "engine_adapter.hpp"

#include <folly/executors/CPUThreadPoolExecutor.h>
#include <folly/experimental/coro/BlockingWait.h>
#include <folly/logging/xlog.h>

#include <algorithm>
#include <charconv>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <utility>
#include <vector>

namespace engine_adapter {

static bool is_protocol_cell(json const& cell) {
    return cell.is_array() && cell.size() == 2 && cell[0].is_number_integer() &&
        cell[1].is_number_integer();
}

// Protocol cells use [row, column]. Board cells store {column, row}.
static Cell parse_cell(json const& cell_json) {
    return Cell{cell_json[1].get<int>(), cell_json[0].get<int>()};
}

static Wall parse_wall(json const& wall_json) {
    Cell const cell = parse_cell(wall_json["cell"]);
    if (wall_json["orientation"] == "vertical") {
        return Wall{cell, Wall::Right};
    }
    // A protocol horizontal wall is above its named cell.
    return Wall{Cell{cell.column, cell.row - 1}, Wall::Down};
}

// ============================================================================
// Padding Support
// ============================================================================

PaddingConfig create_padding_config(
    int model_rows, int model_columns,
    int game_rows, int game_columns,
    Variant variant) {

    PaddingConfig config;
    config.model_rows = model_rows;
    config.model_columns = model_columns;
    config.game_rows = game_rows;
    config.game_columns = game_columns;
    config.variant = variant;

    if (variant != Variant::Classic) {
        // Standard: embed at top-left
        config.row_offset = 0;
        config.col_offset = 0;
    } else {
        // Classic: embed at bottom, centered horizontally (left-biased)
        config.row_offset = model_rows - game_rows;
        config.col_offset = (model_columns - game_columns) / 2;  // Floor division (left-biased)
    }

    return config;
}

Cell transform_to_model(Cell game_cell, PaddingConfig const& config) {
    return Cell{
        game_cell.column + config.col_offset,
        game_cell.row + config.row_offset
    };
}

// Check if movement from a cell in a given direction is blocked by a wall
static bool is_direction_blocked(Board const& board, Cell from, Direction dir) {
    switch (dir) {
        case Direction::Right: return board.is_blocked(Wall{from, Wall::Right});
        case Direction::Left:  return board.is_blocked(Wall{Cell{from.column - 1, from.row}, Wall::Right});
        case Direction::Down:  return board.is_blocked(Wall{from, Wall::Down});
        case Direction::Up:    return board.is_blocked(Wall{Cell{from.column, from.row - 1}, Wall::Down});
    }
    return false;
}

// Find directions to move from `from` to `to` (1 or 2 steps)
// Returns empty vector if unreachable in 1-2 steps
static std::vector<Direction> find_path(Cell from, Cell to, Board const& board,
                                        Player player, Pawn pawn) {
    int dc = to.column - from.column;
    int dr = to.row - from.row;
    int manhattan = std::abs(dc) + std::abs(dr);

    if (manhattan == 0) {
        return {};  // Same cell - no movement needed
    }

    if (manhattan == 1) {
        // 1 step (adjacent)
        if (dc == 1) return {Direction::Right};
        if (dc == -1) return {Direction::Left};
        if (dr == 1) return {Direction::Down};
        if (dr == -1) return {Direction::Up};
    }

    if (manhattan == 2) {
        Direction h_dir = (dc > 0) ? Direction::Right : Direction::Left;
        Direction v_dir = (dr > 0) ? Direction::Down : Direction::Up;

        if (std::abs(dc) == 2) {
            // 2 steps in same horizontal direction
            Cell const mid = from.step(h_dir);
            if (is_direction_blocked(board, from, h_dir) ||
                is_direction_blocked(board, mid, h_dir)) return {};
            if (board.variant() == Variant::AnimalCycle) {
                auto movable = board.movable_pawns(player);
                Pawn teammate = movable[0] == pawn ? movable[1] : movable[0];
                if (mid == board.pawn_position(player, teammate)) return {};
            }
            return {h_dir, h_dir};
        }
        if (std::abs(dr) == 2) {
            // 2 steps in same vertical direction
            Cell const mid = from.step(v_dir);
            if (is_direction_blocked(board, from, v_dir) ||
                is_direction_blocked(board, mid, v_dir)) return {};
            if (board.variant() == Variant::AnimalCycle) {
                auto movable = board.movable_pawns(player);
                Pawn teammate = movable[0] == pawn ? movable[1] : movable[0];
                if (mid == board.pawn_position(player, teammate)) return {};
            }
            return {v_dir, v_dir};
        }

        // Diagonal move: try both orderings, pick the one where neither step is blocked
        Cell after_h = from.step(h_dir);
        Cell after_v = from.step(v_dir);

        auto const movable = board.movable_pawns(player);
        Pawn const teammate = movable[0] == pawn ? movable[1] : movable[0];
        auto avoids_teammate = [&](Cell mid) {
            return board.variant() != Variant::AnimalCycle ||
                mid != board.pawn_position(player, teammate);
        };
        bool h_first_ok = avoids_teammate(after_h) &&
                          !is_direction_blocked(board, from, h_dir) &&
                          !is_direction_blocked(board, after_h, v_dir);
        bool v_first_ok = avoids_teammate(after_v) &&
                          !is_direction_blocked(board, from, v_dir) &&
                          !is_direction_blocked(board, after_v, h_dir);

        if (h_first_ok) return {h_dir, v_dir};
        if (v_first_ok) return {v_dir, h_dir};
        return {};  // Both paths blocked
    }

    return {};  // Unreachable in 1-2 steps
}

Wall transform_to_model(Wall game_wall, PaddingConfig const& config) {
    return Wall{
        transform_to_model(game_wall.cell, config),
        game_wall.type
    };
}

std::optional<Cell> transform_to_game(Cell model_cell, PaddingConfig const& config) {
    int game_col = model_cell.column - config.col_offset;
    int game_row = model_cell.row - config.row_offset;

    // Check if the cell is within the game area
    if (game_col < 0 || game_col >= config.game_columns ||
        game_row < 0 || game_row >= config.game_rows) {
        return std::nullopt;
    }

    return Cell{game_col, game_row};
}

void place_padding_walls(Board& board, PaddingConfig const& config) {
    if (!config.needs_padding()) {
        return;
    }

    // For Standard variant: embed at top-left
    // Block right and bottom boundaries of the game area
    if (config.variant != Variant::Classic) {
        // Block bottom boundary (horizontal walls below game area)
        for (int col = 0; col < config.game_columns; ++col) {
            Wall wall{Cell{col, config.game_rows - 1}, Wall::Down};
            if (!board.is_blocked(wall)) {
                board.place_wall(Player::Red, wall);
            }
        }

        // Block right boundary (vertical walls right of game area)
        for (int row = 0; row < config.game_rows; ++row) {
            Wall wall{Cell{config.game_columns - 1, row}, Wall::Right};
            if (!board.is_blocked(wall)) {
                board.place_wall(Player::Red, wall);
            }
        }

        // Block walls in padding area so MCTS can't place out-of-bounds walls.
        for (int row = 0; row < config.model_rows; ++row) {
            for (int col = 0; col < config.model_columns; ++col) {
                if (row < config.game_rows && col < config.game_columns) {
                    continue;
                }
                Wall right_wall{Cell{col, row}, Wall::Right};
                if (!board.is_blocked(right_wall)) {
                    board.place_wall(Player::Red, right_wall);
                }
                Wall down_wall{Cell{col, row}, Wall::Down};
                if (!board.is_blocked(down_wall)) {
                    board.place_wall(Player::Red, down_wall);
                }
            }
        }
    } else {
        // Classic variant: embed at bottom, centered
        // Need to block:
        // 1. Top of game area (horizontal wall at row_offset - 1 if row_offset > 0)
        // 2. Left of game area (vertical walls)
        // 3. Right of game area (vertical walls)
        // 4. Horizontal walls in padding rows

        // Block all cells in the top padding area
        for (int row = 0; row < config.row_offset; ++row) {
            for (int col = 0; col < config.model_columns; ++col) {
                // Block horizontal walls (Down direction)
                if (row < config.model_rows - 1) {
                    Wall wall{Cell{col, row}, Wall::Down};
                    if (!board.is_blocked(wall)) {
                        board.place_wall(Player::Red, wall);
                    }
                }
                // Block vertical walls (Right direction)
                Wall right_wall{Cell{col, row}, Wall::Right};
                if (!board.is_blocked(right_wall)) {
                    board.place_wall(Player::Red, right_wall);
                }
            }
        }

        // Block top boundary of game area
        if (config.row_offset > 0) {
            for (int col = config.col_offset; col < config.col_offset + config.game_columns; ++col) {
                Wall wall{Cell{col, config.row_offset - 1}, Wall::Down};
                if (!board.is_blocked(wall)) {
                    board.place_wall(Player::Red, wall);
                }
            }
        }

        /*
        A Classic goal can sit in the padding. make_padded_training_board puts both
        homes on the model's bottom corners, and the bottom row is the only way in to
        them, so on that board the bottom row's vertical walls have to stay open.

        Serving is not that board. convert_bgs_config_to_board takes both homes from
        the game config, so they always name cells the game board has, and the corridor
        is dead space. Dead space the search can still build in: Board::legal_walls
        walks the whole model board, so every wall the padding leaves open is a move
        MCTS may pick and the session may send. That is how ">k1" left the engine on an
        eight-column board (board a74a9963), and ">h1" with it - the same open door one
        column further in, on the game board's own right edge.

        So the corridor is opened only for a board that needs one.
        */
        auto const sits_in_padding = [&config](Cell cell) {
            return !transform_to_game(cell, config).has_value();
        };
        bool const padding_holds_a_goal = sits_in_padding(board.goal(Player::Red)) ||
            sits_in_padding(board.goal(Player::Blue));

        // Block left boundary (vertical walls) - EXCEPT the corridor row
        if (config.col_offset > 0) {
            for (int row = config.row_offset; row < config.model_rows; ++row) {
                if (padding_holds_a_goal && row == config.model_rows - 1) {
                    continue;
                }
                Wall wall{Cell{config.col_offset - 1, row}, Wall::Right};
                if (!board.is_blocked(wall)) {
                    board.place_wall(Player::Red, wall);
                }
            }
        }

        // Block right boundary (vertical walls) - EXCEPT the corridor row
        int right_boundary_col = config.col_offset + config.game_columns - 1;
        if (right_boundary_col < config.model_columns - 1) {
            for (int row = config.row_offset; row < config.model_rows; ++row) {
                if (padding_holds_a_goal && row == config.model_rows - 1) {
                    continue;
                }
                Wall wall{Cell{right_boundary_col, row}, Wall::Right};
                if (!board.is_blocked(wall)) {
                    board.place_wall(Player::Red, wall);
                }
            }
        }

        // Block walls in padding columns within game rows to prevent out-of-bounds walls.
        int game_col_start = config.col_offset;
        int game_col_end = config.col_offset + config.game_columns;  // exclusive
        for (int row = config.row_offset; row < config.model_rows; ++row) {
            for (int col = 0; col < config.model_columns; ++col) {
                if (col >= game_col_start && col < game_col_end) {
                    continue;
                }
                Wall down_wall{Cell{col, row}, Wall::Down};
                if (!board.is_blocked(down_wall)) {
                    board.place_wall(Player::Red, down_wall);
                }
                if (padding_holds_a_goal && row == config.model_rows - 1) {
                    continue;
                }
                Wall right_wall{Cell{col, row}, Wall::Right};
                if (!board.is_blocked(right_wall)) {
                    board.place_wall(Player::Red, right_wall);
                }
            }
        }
    }
}

Board make_padded_training_board(int model_columns, int model_rows, int game_columns,
                                 int game_rows, Variant variant) {
    if (game_columns == model_columns && game_rows == model_rows) {
        return Board{model_columns, model_rows, variant};
    }

    PaddingConfig config =
        create_padding_config(model_rows, model_columns, game_rows, game_columns, variant);

    // Every cell below holds MODEL-frame coordinates. The prefix says which board
    // the corner is a corner OF: game_* starts as a corner of the game area and is
    // mapped in with transform_to_model, model_* is a corner of the model board
    // itself and is never transformed. Which player owns a corner depends on the
    // variant, so no name here states an owner. Board::pawn_roster is the authority
    // on ownership, and the Board constructor throws on any pawn outside it.
    Cell const game_top_left = transform_to_model(Cell{0, 0}, config);
    Cell const game_top_right = transform_to_model(Cell{game_columns - 1, 0}, config);

    std::vector<PawnPlacement> placements;
    if (variant == Variant::Classic) {
        // Classic goals go on the MODEL bottom corners, out in the padding, and
        // place_padding_walls answers that by leaving the bottom row open as the path
        // to them. That is why these two are NOT passed through transform_to_model,
        // unlike every other corner in this function. Serving does NOT do this either:
        // convert_bgs_config_to_board takes both homes from the game config, which
        // puts them on the game board.
        Cell const model_bottom_left = Cell{0, model_rows - 1};
        Cell const model_bottom_right = Cell{model_columns - 1, model_rows - 1};
        placements = {
            {Player::Red, Pawn::Cat, game_top_left},
            {Player::Red, Pawn::Home, model_bottom_right},
            {Player::Blue, Pawn::Cat, game_top_right},
            {Player::Blue, Pawn::Home, model_bottom_left},
        };
    } else {
        Cell const game_bottom_left = transform_to_model(Cell{0, game_rows - 1}, config);
        Cell const game_bottom_right =
            transform_to_model(Cell{game_columns - 1, game_rows - 1}, config);
        if (variant == Variant::AnimalCycle) {
            // Animal Cycle is the one variant where a player does not hold a whole
            // side of the board: Red holds top-left and bottom-right, Blue holds
            // top-right and bottom-left. Serving agrees with this - see the
            // AnimalCycle branch of convert_bgs_config_to_board - and the two must
            // stay in step, because convert_to_model_input writes one network plane
            // per (player, pawn) pair.
            placements = {
                {Player::Red, Pawn::Cat, game_top_left},
                {Player::Red, Pawn::Elephant, game_bottom_right},
                {Player::Blue, Pawn::Mouse, game_top_right},
                {Player::Blue, Pawn::Dog, game_bottom_left},
            };
        } else {
            placements = {
                {Player::Red, Pawn::Cat, game_top_left},
                {Player::Red, Pawn::Mouse, game_bottom_left},
                {Player::Blue, Pawn::Cat, game_top_right},
                {Player::Blue, Pawn::Mouse, game_bottom_right},
            };
        }
    }
    Board board{model_columns, model_rows, variant, std::move(placements)};
    place_padding_walls(board, config);
    return board;
}

// Helper to parse a coordinate from notation (e.g., "e4" -> col 4, row based on board size)
static std::pair<int, int> parse_notation_coords(std::string const& notation, int model_rows) {
    // Column is the letter (a=0, b=1, etc.)
    int col = notation[0] - 'a';
    // Row is the number (1-indexed from bottom in chess notation)
    int official_row = std::stoi(notation.substr(1));
    // Convert to internal row (0-indexed from top)
    int internal_row = model_rows - official_row;
    return {col, internal_row};
}

// Helper to format a coordinate as notation
static std::string format_notation_coords(int col, int row, int game_rows) {
    char col_char = 'a' + col;
    int official_row = game_rows - row;
    return std::string(1, col_char) + std::to_string(official_row);
}

std::string transform_move_notation(
    std::string const& model_notation,
    Cell cat_pos,
    Cell mouse_pos,
    PaddingConfig const& config) {

    if (!config.needs_padding()) {
        return model_notation;
    }

    std::string result;
    std::string remaining = model_notation;

    while (!remaining.empty()) {
        // Add separator if not first component
        if (!result.empty()) {
            result += '.';
        }

        // Find the next component (separated by '.')
        size_t dot_pos = remaining.find('.');
        std::string component = (dot_pos == std::string::npos)
            ? remaining
            : remaining.substr(0, dot_pos);
        remaining = (dot_pos == std::string::npos)
            ? ""
            : remaining.substr(dot_pos + 1);

        // Parse the component type and coordinates
        if (component[0] == 'D' || component[0] == 'C' || component[0] == 'M' ||
            component[0] == 'E') {
            // Pawn move: D/C/M/E followed by coordinates
            char pawn_type = component[0];
            std::string coords = component.substr(1);

            auto [model_col, model_row] = parse_notation_coords(coords, config.model_rows);

            // Transform to game coordinates
            auto game_cell = transform_to_game(Cell{model_col, model_row}, config);

            if (game_cell) {
                result += pawn_type;
                result += format_notation_coords(game_cell->column, game_cell->row, config.game_rows);
            } else {
                /*
                The pawn is out in the padding, so its cell has no name in the game.
                This is training-shaped behaviour: it belongs to a board whose Classic
                goals sit on the model's bottom corners, where a pawn walks out along
                the open bottom row and the nearest game corner is the honest reading.

                A served board should never arrive here. place_padding_walls seals its
                edge, because both of its homes are on the game board, so no pawn can
                leave. The clamp is kept for the boards that do need it, not as cover
                for a served position.
                */
                if (config.variant == Variant::Classic) {
                    // Map to the appropriate game corner
                    int game_col, game_row;
                    if (model_col < config.col_offset) {
                        game_col = 0;
                    } else if (model_col >= config.col_offset + config.game_columns) {
                        game_col = config.game_columns - 1;
                    } else {
                        game_col = model_col - config.col_offset;
                    }
                    game_row = config.game_rows - 1;  // Bottom row of game

                    result += pawn_type;
                    result += format_notation_coords(game_col, game_row, config.game_rows);
                } else {
                    // For Standard, this shouldn't happen
                    result += component;
                }
            }
        } else if (component[0] == '>' || component[0] == '^') {
            // Wall placement: > for vertical, ^ for horizontal
            char wall_type = component[0];
            std::string coords = component.substr(1);

            auto [model_col, model_row] = parse_notation_coords(coords, config.model_rows);

            // Transform to game coordinates
            auto game_cell = transform_to_game(Cell{model_col, model_row}, config);

            if (game_cell) {
                result += wall_type;
                result += format_notation_coords(game_cell->column, game_cell->row, config.game_rows);
            } else {
                /*
                Out of reach for a serving board: place_padding_walls seals the game
                board's edge unless a goal sits in the padding, so no wall the search
                can pick lands out here.

                It says so loudly rather than silently if that ever stops holding. A
                component sent unchanged still names a MODEL column, and this branch
                saying nothing is why players met ">k1" on an eight-column board for as
                long as they did (board a74a9963).
                */
                XLOGF(ERR, "Wall {} is off the game board; sending it unchanged", component);
                result += component;
            }
        } else {
            // Unknown format, keep as-is
            result += component;
        }
    }

    return result;
}

// ============================================================================
// Validation
// ============================================================================

ValidationResult validate_bgs_config(
    json const& bgs_config,
    int model_rows,
    int model_columns) {

    // Check required fields exist
    if (!bgs_config.contains("variant") ||
        !bgs_config.contains("boardWidth") ||
        !bgs_config.contains("boardHeight") ||
        !bgs_config.contains("initialState")) {
        return {false, "BgsConfig missing required fields"};
    }

    // Check variant (classic and standard supported)
    std::string variant = bgs_config["variant"].get<std::string>();
    auto parsed_variant = parse_variant(variant);
    if (!parsed_variant) {
        return {false,
                "Deep-wallwars only supports Classic, Standard, and Animal Cycle rules (not '" +
                    variant + "')"};
    }

    json const& initial_state = bgs_config["initialState"];
    if (initial_state.contains("turn")) {
        json const& turn = initial_state["turn"];
        if (!turn.is_object() || !turn.contains("playerId") ||
            !turn["playerId"].is_number_integer() ||
            (turn["playerId"] != 1 && turn["playerId"] != 2) ||
            !turn.contains("actionsTaken") || !turn["actionsTaken"].is_array() ||
            turn["actionsTaken"].size() > 1) {
            return {false,
                    "initialState.turn requires playerId 1 or 2 and zero or one actionsTaken"};
        }

        if (!turn["actionsTaken"].empty()) {
            json const& action = turn["actionsTaken"][0];
            if (!action.is_object() || !action.contains("type") ||
                !action["type"].is_string()) {
                return {false, "initialState.turn action is missing its type"};
            }
            std::string const type = action["type"].get<std::string>();
            if (type == "dog" || type == "cat" || type == "mouse" || type == "elephant") {
                if (!action.contains("source") || !is_protocol_cell(action["source"]) ||
                    !action.contains("target") || !is_protocol_cell(action["target"])) {
                    return {false, "A spent pawn action requires source and target cells"};
                }
            } else if (type == "wall") {
                if (!action.contains("target") || !is_protocol_cell(action["target"]) ||
                    !action.contains("wallOrientation") ||
                    !action["wallOrientation"].is_string() ||
                    (action["wallOrientation"] != "vertical" &&
                     action["wallOrientation"] != "horizontal")) {
                    return {false,
                            "A spent wall action requires a target cell and wallOrientation"};
                }
            }
            if (type != "dog" && type != "cat" && type != "mouse" &&
                type != "elephant" && type != "wall") {
                return {false, "Unsupported initialState.turn action type '" + type + "'"};
            }
        }
    }

    // Check board dimensions (must be at least 4x4 and at most model dimensions)
    int width = bgs_config["boardWidth"].get<int>();
    int height = bgs_config["boardHeight"].get<int>();

    if (width < 4 || height < 4) {
        return {false, "Board dimensions must be at least 4x4"};
    }

    if (width > model_columns || height > model_rows) {
        return {false, "Board dimensions (" + std::to_string(width) + "x" +
                           std::to_string(height) + ") exceed model dimensions (" +
                           std::to_string(model_columns) + "x" +
                           std::to_string(model_rows) + ")"};
    }

    return {true, ""};
}

std::tuple<Board, Turn, PaddingConfig> convert_bgs_config_to_board(
    json const& bgs_config,
    int model_rows,
    int model_columns) {

    int game_width = bgs_config["boardWidth"].get<int>();
    int game_height = bgs_config["boardHeight"].get<int>();
    std::string const external_variant = bgs_config["variant"].get<std::string>();
    auto parsed_variant = parse_variant(external_variant);
    Variant variant = parsed_variant.value_or(Variant::Classic);

    // Create padding configuration
    PaddingConfig padding_config = create_padding_config(
        model_rows, model_columns, game_height, game_width, variant);

    json const& initial_state = bgs_config["initialState"];

    // Parse pawn positions based on variant
    // V3 format uses "p1"/"p2" instead of "1"/"2"
    Cell red_cat_game, blue_cat_game, red_secondary_game, blue_secondary_game;

    if (variant == Variant::Classic) {
        // Classic has cat and home positions
        json const& pawns = initial_state["pawns"];
        red_cat_game = parse_cell(pawns["p1"]["cat"]);
        blue_cat_game = parse_cell(pawns["p2"]["cat"]);
        // Home positions stored in "home" field for classic
        red_secondary_game = parse_cell(pawns["p1"]["home"]);
        blue_secondary_game = parse_cell(pawns["p2"]["home"]);
    } else if (variant == Variant::Standard) {
        // Standard has cat and mouse positions
        json const& pawns = initial_state["pawns"];
        red_cat_game = parse_cell(pawns["p1"]["cat"]);
        blue_cat_game = parse_cell(pawns["p2"]["cat"]);
        red_secondary_game = parse_cell(pawns["p1"]["mouse"]);
        blue_secondary_game = parse_cell(pawns["p2"]["mouse"]);
    }

    if (variant == Variant::AnimalCycle) {
        json const& pawns = initial_state["pawns"];
        Board board(model_columns, model_rows, variant,
                    {{Player::Red, Pawn::Cat,
                      transform_to_model(parse_cell(pawns["p1"]["cat"]), padding_config)},
                     {Player::Red, Pawn::Elephant,
                      transform_to_model(parse_cell(pawns["p1"]["elephant"]), padding_config)},
                     {Player::Blue, Pawn::Mouse,
                      transform_to_model(parse_cell(pawns["p2"]["mouse"]), padding_config)},
                     {Player::Blue, Pawn::Dog,
                      transform_to_model(parse_cell(pawns["p2"]["dog"]), padding_config)}});
        place_padding_walls(board, padding_config);
        for (auto const& wall_json : initial_state["walls"]) {
            Wall model_wall = transform_to_model(parse_wall(wall_json), padding_config);
            if (board.is_blocked(model_wall)) {
                throw std::runtime_error("Authored wall overlaps padding or another authored wall");
            }
            board.place_wall(wall_json.value("playerId", 1) == 1 ? Player::Red : Player::Blue,
                             model_wall);
        }
        Turn turn{Player::Red, Turn::First};
        if (initial_state.contains("turn")) {
            auto const& setup_turn = initial_state["turn"];
            turn.player = setup_turn["playerId"].get<int>() == 1 ? Player::Red : Player::Blue;
            turn.action = setup_turn["actionsTaken"].empty() ? Turn::First : Turn::Second;
        }
        return {std::move(board), turn, padding_config};
    }

    // Transform to model coordinates
    Cell red_cat = transform_to_model(red_cat_game, padding_config);
    Cell blue_cat = transform_to_model(blue_cat_game, padding_config);
    Cell red_secondary = transform_to_model(red_secondary_game, padding_config);
    Cell blue_secondary = transform_to_model(blue_secondary_game, padding_config);

    // Create the board with model dimensions
    Pawn const secondary_pawn =
        variant == Variant::Classic ? Pawn::Home : Pawn::Mouse;
    Board board(model_columns, model_rows, variant,
                {{Player::Red, Pawn::Cat, red_cat},
                 {Player::Red, secondary_pawn, red_secondary},
                 {Player::Blue, Pawn::Cat, blue_cat},
                 {Player::Blue, secondary_pawn, blue_secondary}});

    // Place padding walls
    place_padding_walls(board, padding_config);

    // Place initial walls from the config
    json const& walls_array = initial_state["walls"];
    for (auto const& wall_json : walls_array) {
        Wall game_wall = parse_wall(wall_json);
        Wall model_wall = transform_to_model(game_wall, padding_config);
        if (board.is_blocked(model_wall)) {
            throw std::runtime_error(
                "Authored wall overlaps padding or another authored wall");
        }
        // Board has no neutral owner representation. Ownerless setup walls use
        // Red internally for model input; ownership never leaves this BGS.
        int player_id = wall_json.value("playerId", 1);
        Player wall_owner = (player_id == 1) ? Player::Red : Player::Blue;
        board.place_wall(wall_owner, model_wall);
    }

    Turn turn{Player::Red, Turn::First};
    if (initial_state.contains("turn")) {
        json const& setup_turn = initial_state["turn"];
        turn.player = setup_turn["playerId"].get<int>() == 1
            ? Player::Red
            : Player::Blue;
        turn.action = setup_turn["actionsTaken"].empty()
            ? Turn::First
            : Turn::Second;
    }

    return {board, turn, padding_config};
}

// Parse a single notation part (e.g., "Ce4", "Md5", ">f3", "^e4")
// Returns 1 or 2 actions for pawn moves (depending on distance), 1 for walls
static std::vector<Action> parse_notation_part(
    std::string_view part_str,
    Board const& board,
    Player player,
    PaddingConfig const& padding_config) {

    if (part_str.empty()) {
        return {};
    }

    char type_char = part_str[0];
    std::string coords(part_str.substr(1));

    if (coords.size() < 2) {
        return {};
    }

    // Parse column letter (a-z) and row number
    char col_char = coords[0];
    int game_col = col_char - 'a';

    /*
    The row must consume the REST of the part, not just its leading digits.

    This used to be std::stoi(coords.substr(1)), and std::stoi stops at the first
    non-digit without reporting that it stopped. So "Ca2Mh1" parsed as "Ca2" and
    the "Mh1" was silently dropped - the function returned one action where the
    caller had asked for two. That is the inbound direction: handle_apply_move
    feeds the human's move through here into the bot's search tree, so a
    truncating parse leaves the engine searching a position the real game is not
    in, with no error anywhere. Production never hit it only because the server
    always emits the "." separator, which is a property of today's caller rather
    than a guarantee of this parser.

    from_chars reports where it stopped, so trailing characters are a parse
    failure instead of a silent truncation. It also does not throw, which is why
    the try/catch is gone rather than merely narrowed.
    */
    std::string_view const row_text = std::string_view(coords).substr(1);
    int official_row = 0;
    auto const [parse_end, parse_ec] =
        std::from_chars(row_text.data(), row_text.data() + row_text.size(), official_row);
    if (parse_ec != std::errc{} || parse_end != row_text.data() + row_text.size()) {
        return {};
    }
    int game_row = padding_config.game_rows - official_row;

    // Transform game coordinates to model coordinates
    Cell game_cell{game_col, game_row};
    Cell model_cell = transform_to_model(game_cell, padding_config);

    if (type_char == 'D' || type_char == 'C' || type_char == 'M' || type_char == 'E') {
        // Pawn move - find path from current position to target (1 or 2 steps)
        Pawn pawn = type_char == 'D' ? Pawn::Dog
                  : type_char == 'C' ? Pawn::Cat
                  : type_char == 'M' ? Pawn::Mouse
                                     : Pawn::Elephant;
        if (!board.has_pawn(player, pawn) || !board.pawn_is_movable(pawn)) return {};
        Cell current_pos = board.pawn_position(player, pawn);
        auto path = find_path(current_pos, model_cell, board, player, pawn);

        std::vector<Action> actions;
        if (path.size() == 1) {
            actions.push_back(PawnMove{pawn, path[0]});
        } else if (path.size() == 2 && board.variant() == Variant::AnimalCycle) {
            actions.push_back(PawnMove{pawn, path[0], path[1]});
        } else {
            for (Direction dir : path) actions.push_back(PawnMove{pawn, dir});
        }
        return actions;
    } else if (type_char == '>') {
        // Vertical wall (blocks rightward movement)
        return {Wall{model_cell, Wall::Right}};
    } else if (type_char == '^') {
        // Horizontal wall (blocks downward movement from row above)
        // API horizontal wall notation: "^e4" means wall above cell e4
        // In deep-wallwars, this is a Down wall at (col, row-1)
        Cell adjusted_cell{model_cell.column, model_cell.row - 1};
        return {Wall{adjusted_cell, Wall::Down}};
    }

    return {};
}

std::optional<std::vector<Action>> parse_move_notation(
    std::string const& notation,
    Board const& board,
    Turn turn,
    PaddingConfig const& padding_config) {

    // Handle empty/pass move notation
    if (notation == "---") {
        return std::vector<Action>{};
    }

    // Split notation by '.' to get parts (e.g., "Cb2.Mh7" or "Cb2.>d4")
    std::vector<std::string> parts;
    std::string::size_type start = 0;
    std::string::size_type pos = 0;
    while ((pos = notation.find('.', start)) != std::string::npos) {
        parts.push_back(notation.substr(start, pos - start));
        start = pos + 1;
    }
    parts.push_back(notation.substr(start));

    if (parts.empty()) {
        XLOGF(ERR, "Empty move notation");
        return std::nullopt;
    }

    // Collect all actions from all parts
    std::vector<Action> all_actions;
    Board current_board = board;

    for (const auto& part : parts) {
        auto actions = parse_notation_part(part, current_board, turn.player, padding_config);
        if (actions.empty()) {
            XLOGF(ERR, "Failed to parse notation part: {}", part);
            return std::nullopt;
        }

        for (const auto& action : actions) {
            auto const* pawn_move = std::get_if<PawnMove>(&action);
            auto legal = current_board.legal_actions(turn.player);
            if ((!pawn_move || !pawn_move->second_dir) &&
                std::ranges::find(legal, action) == legal.end()) {
                throw std::runtime_error("Move action is not legal");
            }
            all_actions.push_back(action);
            // Update board state for subsequent parsing
            current_board.do_action(turn.player, action);
            if (current_board.variant() == Variant::AnimalCycle &&
                current_board.winner(Turn{turn.player, Turn::Second}) != Winner::Undecided) {
                return all_actions;
            }
        }
    }

    return all_actions;
}

}  // namespace engine_adapter
