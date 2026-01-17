#include "engine_adapter.hpp"

#include <folly/executors/CPUThreadPoolExecutor.h>
#include <folly/experimental/coro/BlockingWait.h>
#include <folly/logging/xlog.h>

#include <algorithm>
#include <iostream>
#include <sstream>
#include <stdexcept>

namespace engine_adapter {

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

    if (variant == Variant::Standard) {
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
    if (config.variant == Variant::Standard) {
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

        // Block left boundary (vertical walls) - EXCEPT bottom row for Classic
        if (config.col_offset > 0) {
            for (int row = config.row_offset; row < config.model_rows; ++row) {
                if (row == config.model_rows - 1) {
                    continue;
                }
                Wall wall{Cell{config.col_offset - 1, row}, Wall::Right};
                if (!board.is_blocked(wall)) {
                    board.place_wall(Player::Red, wall);
                }
            }
        }

        // Block right boundary (vertical walls) - EXCEPT bottom row for Classic
        int right_boundary_col = config.col_offset + config.game_columns - 1;
        if (right_boundary_col < config.model_columns - 1) {
            for (int row = config.row_offset; row < config.model_rows; ++row) {
                if (row == config.model_rows - 1) {
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
                if (row == config.model_rows - 1) {
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
        if (component[0] == 'C' || component[0] == 'M') {
            // Pawn move: C/M followed by coordinates
            char pawn_type = component[0];
            std::string coords = component.substr(1);

            auto [model_col, model_row] = parse_notation_coords(coords, config.model_rows);

            // Transform to game coordinates
            auto game_cell = transform_to_game(Cell{model_col, model_row}, config);

            if (game_cell) {
                result += pawn_type;
                result += format_notation_coords(game_cell->column, game_cell->row, config.game_rows);
            } else {
                // Cell is in padding area - this can happen for Classic variant
                // when a pawn moves toward the goal corner outside the game area
                // In this case, we keep the notation but map to the game boundary
                // Actually, for Classic variant, the goals are at the model corners,
                // so we need to map to the game corner
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
                // Wall in padding area - keep original (shouldn't happen in valid games)
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

ValidationResult validate_request(json const& state_json, int model_rows, int model_columns) {
    // Check variant (classic and standard supported)
    std::string variant = state_json["config"]["variant"].get<std::string>();
    auto parsed_variant = parse_variant(variant);
    if (!parsed_variant || (*parsed_variant != Variant::Classic &&
                            *parsed_variant != Variant::Standard)) {
        return {false,
                "Deep-wallwars only supports the 'classic' and 'standard' variants (not '" +
                    variant + "')"};
    }

    // Check board dimensions (must be at least 4x4 and at most model dimensions)
    int width = state_json["config"]["boardWidth"].get<int>();
    int height = state_json["config"]["boardHeight"].get<int>();

    if (width < 4 || height < 4) {
        return {false, "Board dimensions must be at least 4x4 (got " +
                std::to_string(width) + "x" + std::to_string(height) + ")"};
    }

    if (width > model_columns || height > model_rows) {
        return {false, "This engine supports boards up to " +
                std::to_string(model_columns) + "x" + std::to_string(model_rows) +
                " (got " + std::to_string(width) + "x" + std::to_string(height) + ")"};
    }

    return {true, ""};
}

// ============================================================================
// State Conversion
// ============================================================================

// Parse a Cell from the official API format [row, col]
Cell parse_cell(json const& cell_json, int rows) {
    int official_row = cell_json[0].get<int>();
    int col = cell_json[1].get<int>();

    // Official API: row 0 is top
    // Deep-wallwars: row 0 is top (same)
    // So no conversion needed for rows in this case
    return Cell{col, official_row};
}

// Parse a Wall from the official API format
// API: {cell: [row, col], orientation: "vertical"|"horizontal"}
// Deep-wallwars vertical wall (Right): blocks movement to the right
// Deep-wallwars horizontal wall (Down): blocks movement downward
Wall parse_wall(json const& wall_json, int rows) {
    Cell cell = parse_cell(wall_json["cell"], rows);
    std::string orientation = wall_json["orientation"].get<std::string>();

    if (orientation == "vertical") {
        // Vertical wall blocks movement to the right
        return Wall{cell, Wall::Right};
    } else {
        // Horizontal wall blocks movement downward
        // API: horizontal wall above cell -> blocks (row-1, col) <-> (row, col)
        // Deep-wallwars: Down wall at (col, row) blocks (col, row) <-> (col, row+1)
        // So API horizontal wall "above" cell (r, c) is a Down wall at (c, r-1)
        return Wall{Cell{cell.column, cell.row - 1}, Wall::Down};
    }
}

std::tuple<Board, Turn, PaddingConfig> convert_state_to_board(
    json const& state_json,
    int model_rows,
    int model_columns) {

    int game_width = state_json["config"]["boardWidth"].get<int>();
    int game_height = state_json["config"]["boardHeight"].get<int>();
    std::string variant_str = state_json["config"]["variant"].get<std::string>();
    auto parsed_variant = parse_variant(variant_str);
    Variant variant = parsed_variant.value_or(Variant::Classic);

    // Create padding configuration
    PaddingConfig padding_config = create_padding_config(
        model_rows, model_columns, game_height, game_width, variant);

    // Parse pawn positions (in game coordinates)
    // API uses PlayerId (1 or 2), deep-wallwars uses Player (Red or Blue)
    // We map Player 1 -> Red, Player 2 -> Blue
    json const& pawns = state_json["pawns"];

    Cell red_cat_game = parse_cell(pawns["1"]["cat"], game_height);
    Cell blue_cat_game = parse_cell(pawns["2"]["cat"], game_height);
    Cell red_mouse_game = parse_cell(pawns["1"]["mouse"], game_height);
    Cell blue_mouse_game = parse_cell(pawns["2"]["mouse"], game_height);

    // Transform to model coordinates
    Cell red_cat = transform_to_model(red_cat_game, padding_config);
    Cell blue_cat = transform_to_model(blue_cat_game, padding_config);
    Cell red_mouse;
    Cell blue_mouse;
    if (variant == Variant::Classic) {
        // Classic goals are at the model corners.
        red_mouse = Cell{0, model_rows - 1};
        blue_mouse = Cell{model_columns - 1, model_rows - 1};
    } else {
        red_mouse = transform_to_model(red_mouse_game, padding_config);
        blue_mouse = transform_to_model(blue_mouse_game, padding_config);
    }

    // Create the board with model dimensions
    Board board(model_columns, model_rows, red_cat, red_mouse, blue_cat, blue_mouse, variant);

    // Place padding walls
    place_padding_walls(board, padding_config);

    // Place game walls (transformed to model coordinates)
    json const& walls_array = state_json["walls"];
    for (auto const& wall_json : walls_array) {
        Wall game_wall = parse_wall(wall_json, game_height);
        Wall model_wall = transform_to_model(game_wall, padding_config);
        int player_id = wall_json.value("playerId", 0);
        Player wall_owner = (player_id == 1) ? Player::Red : Player::Blue;
        board.place_wall(wall_owner, model_wall);
    }

    // Determine current turn
    int current_player_id = state_json["turn"].get<int>();

    Player current_player = (current_player_id == 1) ? Player::Red : Player::Blue;

    // Assume we're at the start of that player's turn (First action)
    Turn turn{current_player, Turn::First};

    return {board, turn, padding_config};
}

// ============================================================================
// Move Generation
// ============================================================================

std::optional<MoveResult> find_best_move(
    Board const& board,
    Turn turn,
    EvaluationFunction const& eval_fn,
    EngineConfig const& config,
    PaddingConfig const& padding_config) {

    XLOGF(DBG, "Finding best move for player {} at turn action {}",
          turn.player == Player::Red ? "Red" : "Blue",
          turn.action == Turn::First ? "First" : "Second");

    // Create MCTS instance
    MCTS::Options mcts_opts;
    mcts_opts.starting_turn = turn;
    mcts_opts.seed = config.seed;
    mcts_opts.max_parallelism = 4;  // Reasonable default

    MCTS mcts(eval_fn, board, mcts_opts);

    // We need a thread pool to run the coroutine
    folly::CPUThreadPoolExecutor thread_pool(4);

    // Run MCTS sampling
    folly::coro::blockingWait(mcts.sample(config.samples).scheduleOn(&thread_pool));

    // IMPORTANT: Capture evaluation BEFORE committing!
    // commit_to_action() advances the root to a child node, which changes
    // whose perspective root_value() returns from. We must capture it while
    // the root is still at the original position (current player's perspective).
    float raw_evaluation = mcts.root_value();

    // Now commit to actions to get the move
    auto action_1 = mcts.commit_to_action();
    if (!action_1) {
        XLOG(ERR, "MCTS returned no first action - no legal moves available");
        return std::nullopt;
    }

    std::optional<Move> move_opt;
    if (mcts.current_board().winner() != Winner::Undecided) {
        // First action won the game, just pick any legal wall for second action
        auto legal_walls = mcts.current_board().legal_walls();
        if (legal_walls.empty()) {
            XLOG(ERR, "Game won but no legal walls available");
            return std::nullopt;
        }
        move_opt = Move{*action_1, legal_walls[0]};
    } else {
        // Sample and commit for second action
        folly::coro::blockingWait(mcts.sample(config.samples).scheduleOn(&thread_pool));
        auto action_2 = mcts.commit_to_action();
        if (!action_2) {
            XLOG(ERR, "MCTS returned no second action");
            return std::nullopt;
        }
        move_opt = Move{*action_1, *action_2};
    }

    // Get the evaluation from MCTS root value and clamp to [-1, +1]
    // MCTS returns value from current turn player's perspective (turn.player).
    // Engine API requires P1's perspective, so negate if it's P2's turn.
    float evaluation = (turn.player == Player::Red) ? raw_evaluation : -raw_evaluation;
    evaluation = std::clamp(evaluation, -1.0f, 1.0f);

    // Get current position of the player's pawn (in model coordinates)
    Cell current_pos = board.position(turn.player);
    Cell current_mouse = board.mouse(turn.player);

    // Convert to standard notation (in model coordinates)
    std::string model_notation =
        move_opt->standard_notation(current_pos, current_mouse, board.rows());

    // Transform notation from model coordinates to game coordinates
    std::string notation = transform_move_notation(
        model_notation, current_pos, current_mouse, padding_config);

    XLOGF(INFO, "Best move: {} (model: {}), evaluation: {}", notation, model_notation, evaluation);
    return MoveResult{notation, evaluation};
}

// ============================================================================
// Draw Evaluation
// ============================================================================

bool should_accept_draw(
    Board const& board,
    Turn turn,
    int my_player_id,
    EvaluationFunction const& eval_fn,
    EngineConfig const& config) {

    XLOGF(DBG, "Evaluating position to decide on draw offer");

    // Create MCTS instance to evaluate the position
    MCTS::Options mcts_opts;
    mcts_opts.starting_turn = turn;
    mcts_opts.seed = config.seed;
    mcts_opts.max_parallelism = 4;

    MCTS mcts(eval_fn, board, mcts_opts);

    // Run some samples to get a position evaluation
    // Use fewer samples than for move generation since this is just an evaluation
    int eval_samples = std::min(config.samples / 2, 200);

    folly::CPUThreadPoolExecutor thread_pool(4);
    folly::coro::blockingWait(mcts.sample(eval_samples).scheduleOn(&thread_pool));

    float root_value = mcts.root_value();

    XLOGF(INFO, "Position evaluation: {} (from perspective of current player)", root_value);

    // root_value is from the perspective of the current player
    // If the current player is us and root_value is negative, we're losing
    Player my_player = (my_player_id == 1) ? Player::Red : Player::Blue;

    if (turn.player == my_player) {
        // It's our turn, so root_value is from our perspective
        // Accept draw if we're losing (negative value)
        bool accept = root_value < 0.0f;
        XLOGF(INFO, "Draw decision: {} (our turn, value={})",
              accept ? "accept" : "decline", root_value);
        return accept;
    } else {
        // It's opponent's turn, so root_value is from their perspective
        // Accept draw if opponent is winning (positive value for them = bad for us)
        bool accept = root_value > 0.0f;
        XLOGF(INFO, "Draw decision: {} (opponent's turn, value={})",
              accept ? "accept" : "decline", root_value);
        return accept;
    }
}

// ============================================================================
// Request Handling
// ============================================================================

json handle_engine_request(
    json const& request,
    EvaluationFunction const& eval_fn,
    EngineConfig const& config) {

    int engine_api_version = request["engineApiVersion"].get<int>();
    std::string request_id = request["requestId"].get<std::string>();
    std::string kind = request["kind"].get<std::string>();
    json const& state_json = request["state"];
    int my_player_id = request["playerId"].get<int>();

    XLOGF(INFO, "Handling {} request (id: {})", kind, request_id);

    // Validate version
    if (engine_api_version != 2) {
        XLOGF(ERR, "Unsupported engine API version: {}", engine_api_version);
        std::cerr << "Error: Unsupported engine API version " << engine_api_version << "\n";
        return json{
            {"engineApiVersion", 2},
            {"requestId", request_id},
            {"response", {{"action", "resign"}}}
        };
    }

    int model_rows = config.model_rows;
    int model_columns = config.model_columns;

    // Validate request compatibility
    ValidationResult validation = validate_request(
        state_json, model_rows, model_columns);
    if (!validation.valid) {
        XLOGF(WARN, "Request validation failed: {}", validation.error_message);
        std::cerr << "Error: " << validation.error_message << "\n";

        // Return appropriate response based on request kind
        if (kind == "move") {
            return json{
                {"engineApiVersion", 2},
                {"requestId", request_id},
                {"response", {{"action", "resign"}}}
            };
        } else {
            return json{
                {"engineApiVersion", 2},
                {"requestId", request_id},
                {"response", {{"action", "decline-draw"}}}
            };
        }
    }

    // Convert state (with padding support)
    auto [board, turn, padding_config] = convert_state_to_board(
        state_json, model_rows, model_columns);

    // Handle request based on kind
    if (kind == "move") {
        auto move_result = find_best_move(board, turn, eval_fn, config, padding_config);

        if (!move_result) {
            XLOG(WARN, "No legal move found, resigning");
            std::cerr << "Warning: No legal move found\n";
            return json{
                {"engineApiVersion", 2},
                {"requestId", request_id},
                {"response", {{"action", "resign"}}}
            };
        }

        return json{
            {"engineApiVersion", 2},
            {"requestId", request_id},
            {"response", {
                {"action", "move"},
                {"moveNotation", move_result->notation},
                {"evaluation", move_result->evaluation}
            }}
        };
    } else if (kind == "draw") {
        // Note: In V2, draws are auto-declined by the client, but we handle them anyway
        bool accept = should_accept_draw(board, turn, my_player_id, eval_fn, config);

        return json{
            {"engineApiVersion", 2},
            {"requestId", request_id},
            {"response", {
                {"action", accept ? "accept-draw" : "decline-draw"}
            }}
        };
    } else {
        XLOGF(ERR, "Unknown request kind: {}", kind);
        std::cerr << "Error: Unknown request kind '" << kind << "'\n";
        return json{
            {"engineApiVersion", 2},
            {"requestId", request_id},
            {"response", {{"action", "resign"}}}
        };
    }
}

// ============================================================================
// V3 Bot Game Session (BGS) Support
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
    if (!parsed_variant || (*parsed_variant != Variant::Classic &&
                            *parsed_variant != Variant::Standard)) {
        return {false,
                "Deep-wallwars only supports the 'classic' and 'standard' variants (not '" +
                    variant + "')"};
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
    std::string variant_str = bgs_config["variant"].get<std::string>();
    auto parsed_variant = parse_variant(variant_str);
    Variant variant = parsed_variant.value_or(Variant::Classic);

    // Create padding configuration
    PaddingConfig padding_config = create_padding_config(
        model_rows, model_columns, game_height, game_width, variant);

    json const& initial_state = bgs_config["initialState"];

    // Parse pawn positions based on variant
    // V3 format uses "p1"/"p2" instead of "1"/"2"
    Cell red_cat_game, blue_cat_game, red_mouse_game, blue_mouse_game;

    if (variant == Variant::Classic) {
        // Classic has cat and home positions
        json const& pawns = initial_state["pawns"];
        red_cat_game = parse_cell(pawns["p1"]["cat"], game_height);
        blue_cat_game = parse_cell(pawns["p2"]["cat"], game_height);
        // Home positions stored in "home" field for classic
        red_mouse_game = parse_cell(pawns["p1"]["home"], game_height);
        blue_mouse_game = parse_cell(pawns["p2"]["home"], game_height);
    } else {
        // Standard has cat and mouse positions
        json const& pawns = initial_state["pawns"];
        red_cat_game = parse_cell(pawns["p1"]["cat"], game_height);
        blue_cat_game = parse_cell(pawns["p2"]["cat"], game_height);
        red_mouse_game = parse_cell(pawns["p1"]["mouse"], game_height);
        blue_mouse_game = parse_cell(pawns["p2"]["mouse"], game_height);
    }

    // Transform to model coordinates
    Cell red_cat = transform_to_model(red_cat_game, padding_config);
    Cell blue_cat = transform_to_model(blue_cat_game, padding_config);
    Cell red_mouse, blue_mouse;

    if (variant == Variant::Classic) {
        // Classic goals are at the model corners
        red_mouse = Cell{0, model_rows - 1};
        blue_mouse = Cell{model_columns - 1, model_rows - 1};
    } else {
        red_mouse = transform_to_model(red_mouse_game, padding_config);
        blue_mouse = transform_to_model(blue_mouse_game, padding_config);
    }

    // Create the board with model dimensions
    Board board(model_columns, model_rows, red_cat, red_mouse, blue_cat, blue_mouse, variant);

    // Place padding walls
    place_padding_walls(board, padding_config);

    // Place initial walls from the config
    json const& walls_array = initial_state["walls"];
    for (auto const& wall_json : walls_array) {
        Wall game_wall = parse_wall(wall_json, game_height);
        Wall model_wall = transform_to_model(game_wall, padding_config);
        // V3 walls have playerId field (1 or 2)
        int player_id = wall_json.value("playerId", 1);
        Player wall_owner = (player_id == 1) ? Player::Red : Player::Blue;
        board.place_wall(wall_owner, model_wall);
    }

    // V3: Always starts at P1's turn (ply 0), First action
    Turn turn{Player::Red, Turn::First};

    return {board, turn, padding_config};
}

// Helper to parse a single action from notation (e.g., "Ce4", "Md5", ">f3", "^e4")
static std::optional<Action> parse_single_action(
    std::string_view action_str,
    Board const& board,
    Player player,
    PaddingConfig const& padding_config) {

    if (action_str.empty()) {
        return std::nullopt;
    }

    char type_char = action_str[0];
    std::string coords(action_str.substr(1));

    if (coords.size() < 2) {
        return std::nullopt;
    }

    // Parse column letter (a-z) and row number
    char col_char = coords[0];
    int game_col = col_char - 'a';
    int game_row = 0;
    try {
        game_row = std::stoi(coords.substr(1)) - 1;  // 1-indexed to 0-indexed
    } catch (...) {
        return std::nullopt;
    }

    // Transform game coordinates to model coordinates
    Cell game_cell{game_col, game_row};
    Cell model_cell = transform_to_model(game_cell, padding_config);

    if (type_char == 'C') {
        // Cat move
        return PawnMove{Pawn::Cat, model_cell};
    } else if (type_char == 'M') {
        // Mouse move
        return PawnMove{Pawn::Mouse, model_cell};
    } else if (type_char == '>') {
        // Vertical wall (blocks rightward movement)
        return Wall{model_cell, Wall::Right};
    } else if (type_char == '^') {
        // Horizontal wall (blocks downward movement from row above)
        // API horizontal wall notation: "^e4" means wall above cell e4
        // In deep-wallwars, this is a Down wall at (col, row-1)
        Cell adjusted_cell{model_cell.column, model_cell.row - 1};
        return Wall{adjusted_cell, Wall::Down};
    }

    return std::nullopt;
}

std::optional<Move> parse_move_notation(
    std::string const& notation,
    Board const& board,
    Turn turn,
    PaddingConfig const& padding_config) {

    // Split notation by '.' to get two actions
    auto dot_pos = notation.find('.');
    if (dot_pos == std::string::npos) {
        XLOGF(ERR, "Invalid move notation (no separator): {}", notation);
        return std::nullopt;
    }

    std::string action1_str = notation.substr(0, dot_pos);
    std::string action2_str = notation.substr(dot_pos + 1);

    auto action1 = parse_single_action(action1_str, board, turn.player, padding_config);
    if (!action1) {
        XLOGF(ERR, "Failed to parse first action: {}", action1_str);
        return std::nullopt;
    }

    auto action2 = parse_single_action(action2_str, board, turn.player, padding_config);
    if (!action2) {
        XLOGF(ERR, "Failed to parse second action: {}", action2_str);
        return std::nullopt;
    }

    return Move{*action1, *action2};
}

}  // namespace engine_adapter
