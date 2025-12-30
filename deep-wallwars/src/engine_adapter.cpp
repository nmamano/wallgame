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
// Validation
// ============================================================================

ValidationResult validate_request(json const& state_json) {
    // Check variant (only Classic supported)
    std::string variant = state_json["config"]["variant"].get<std::string>();
    if (variant != "classic") {
        return {false, "Deep-wallwars only supports the 'classic' variant (not '" + variant + "')"};
    }

    // Check board dimensions (only 8x8 supported)
    int width = state_json["config"]["boardWidth"].get<int>();
    int height = state_json["config"]["boardHeight"].get<int>();

    if (width != 8 || height != 8) {
        return {false, "Deep-wallwars only supports 8x8 boards (got " +
                std::to_string(width) + "x" + std::to_string(height) + ")"};
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

std::pair<Board, Turn> convert_state_to_board(json const& state_json) {
    int width = state_json["config"]["boardWidth"].get<int>();
    int height = state_json["config"]["boardHeight"].get<int>();

    // Parse pawn positions
    // API uses PlayerId (1 or 2), deep-wallwars uses Player (Red or Blue)
    // We map Player 1 -> Red, Player 2 -> Blue
    json const& pawns = state_json["pawns"];

    Cell red_cat = parse_cell(pawns["1"]["cat"], height);
    Cell blue_cat = parse_cell(pawns["2"]["cat"], height);

    // Classic variant: mice are stationary, so the opponent's mouse is the goal.
    json const& initial_pawns = state_json["initialState"]["pawns"];
    Cell red_goal = parse_cell(initial_pawns["2"]["mouse"], height);
    Cell blue_goal = parse_cell(initial_pawns["1"]["mouse"], height);

    // Create the board
    Board board(width, height, red_cat, red_goal, blue_cat, blue_goal);

    // Place walls
    json const& walls_array = state_json["walls"];
    for (auto const& wall_json : walls_array) {
        Wall wall = parse_wall(wall_json, height);
        int player_id = wall_json.value("playerId", 0);
        Player wall_owner = (player_id == 1) ? Player::Red : Player::Blue;
        board.place_wall(wall_owner, wall);
    }

    // Determine current turn
    int current_player_id = state_json["turn"].get<int>();
    int move_count = state_json["moveCount"].get<int>();

    Player current_player = (current_player_id == 1) ? Player::Red : Player::Blue;

    // Each "move" in the API is a full move (two actions)
    // The turn has two parts: First and Second
    // If we've completed N moves, we're on move N+1
    // The moveCount tells us how many moves are complete
    // If it's odd, we're on the second action; if even, on the first action
    // Actually, looking at the API more carefully:
    // - Each player makes a full move (potentially two actions)
    // - moveCount is the number of completed full moves
    // - So if moveCount=0, we're on the first player's first action
    // - After the first player's move, moveCount=1
    //
    // Actually, I need to look at the history to understand this better.
    // Let me simplify: since deep-wallwars tracks Turn (player + action),
    // and the API tells us whose turn it is, I'll assume we're at the start
    // of that player's turn (First action).

    Turn turn{current_player, Turn::First};

    return {board, turn};
}

// ============================================================================
// Move Generation
// ============================================================================

std::optional<std::string> find_best_move(
    Board const& board,
    Turn turn,
    EvaluationFunction const& eval_fn,
    EngineConfig const& config) {

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

    // Run MCTS sampling and get the best move
    auto move_opt = folly::coro::blockingWait(
        mcts.sample_and_commit_to_move(config.samples).scheduleOn(&thread_pool));

    if (!move_opt) {
        XLOG(ERR, "MCTS returned no move - no legal moves available");
        return std::nullopt;
    }

    // Get current position of the player's pawn
    Cell current_pos = board.position(turn.player);

    // Convert to standard notation
    std::string notation = move_opt->standard_notation(current_pos, board.rows());

    XLOGF(INFO, "Best move: {}", notation);
    return notation;
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
    int my_player_id = request["seat"]["playerId"].get<int>();

    XLOGF(INFO, "Handling {} request (id: {})", kind, request_id);

    // Validate version
    if (engine_api_version != 1) {
        XLOGF(ERR, "Unsupported engine API version: {}", engine_api_version);
        std::cerr << "Error: Unsupported engine API version " << engine_api_version << "\n";
        return json{
            {"engineApiVersion", 1},
            {"requestId", request_id},
            {"response", {{"action", "resign"}}}
        };
    }

    // Validate request compatibility
    ValidationResult validation = validate_request(state_json);
    if (!validation.valid) {
        XLOGF(WARN, "Request validation failed: {}", validation.error_message);
        std::cerr << "Error: " << validation.error_message << "\n";

        // Return appropriate response based on request kind
        if (kind == "move") {
            return json{
                {"engineApiVersion", 1},
                {"requestId", request_id},
                {"response", {{"action", "resign"}}}
            };
        } else {
            return json{
                {"engineApiVersion", 1},
                {"requestId", request_id},
                {"response", {{"action", "decline-draw"}}}
            };
        }
    }

    // Convert state
    auto [board, turn] = convert_state_to_board(state_json);

    // Handle request based on kind
    if (kind == "move") {
        auto move_notation = find_best_move(board, turn, eval_fn, config);

        if (!move_notation) {
            XLOG(WARN, "No legal move found, resigning");
            std::cerr << "Warning: No legal move found\n";
            return json{
                {"engineApiVersion", 1},
                {"requestId", request_id},
                {"response", {{"action", "resign"}}}
            };
        }

        return json{
            {"engineApiVersion", 1},
            {"requestId", request_id},
            {"response", {
                {"action", "move"},
                {"moveNotation", *move_notation}
            }}
        };
    } else if (kind == "draw") {
        bool accept = should_accept_draw(board, turn, my_player_id, eval_fn, config);

        return json{
            {"engineApiVersion", 1},
            {"requestId", request_id},
            {"response", {
                {"action", accept ? "accept-draw" : "decline-draw"}
            }}
        };
    } else {
        XLOGF(ERR, "Unknown request kind: {}", kind);
        std::cerr << "Error: Unknown request kind '" << kind << "'\n";
        return json{
            {"engineApiVersion", 1},
            {"requestId", request_id},
            {"response", {{"action", "resign"}}}
        };
    }
}

}  // namespace engine_adapter
