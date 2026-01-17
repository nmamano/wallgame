#pragma once

#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <tuple>

#include "gamestate.hpp"
#include "mcts.hpp"

namespace engine_adapter {

using json = nlohmann::json;

// ============================================================================
// Types matching the official custom-bot client Engine API v2
// ============================================================================

struct EngineConfig {
    std::string model_path;
    int think_time_seconds;
    int samples = 500;              // MCTS samples per action
    std::uint32_t seed = 42;
    int model_rows = 8;
    int model_columns = 8;
};

struct ValidationResult {
    bool valid;
    std::string error_message;  // Only populated if !valid
};

// ============================================================================
// Padding Support
// ============================================================================

// Configuration for embedding smaller game boards within larger model boards
struct PaddingConfig {
    int model_rows;
    int model_columns;
    int game_rows;
    int game_columns;
    Variant variant;
    int row_offset;  // Rows of padding before game area
    int col_offset;  // Columns of padding before game area

    bool needs_padding() const {
        return game_rows != model_rows || game_columns != model_columns;
    }
};

// Create padding configuration based on model and game dimensions
// - Standard variant: embed at top-left (offset 0, 0)
// - Classic variant: embed at bottom, centered horizontally (left-biased)
PaddingConfig create_padding_config(
    int model_rows, int model_columns,
    int game_rows, int game_columns,
    Variant variant);

// Transform game coordinates to model coordinates
Cell transform_to_model(Cell game_cell, PaddingConfig const& config);
Wall transform_to_model(Wall game_wall, PaddingConfig const& config);

// Transform model coordinates to game coordinates
// Returns nullopt if the cell is in the padding area (outside game bounds)
std::optional<Cell> transform_to_game(Cell model_cell, PaddingConfig const& config);

// Place walls in the padding area to prevent movement into padding cells
// For Classic variant, leaves bottom row vertical walls open (path to goal)
void place_padding_walls(Board& board, PaddingConfig const& config);

// Transform move notation from model coordinates to game coordinates
std::string transform_move_notation(
    std::string const& model_notation,
    Cell cat_pos,   // Current cat position in model coords
    Cell mouse_pos, // Current mouse position in model coords
    PaddingConfig const& config);

// ============================================================================
// State Conversion Functions
// ============================================================================

// Validates that the request is compatible with deep-wallwars capabilities
// - Supports Classic and Standard variants
// - Supports boards from 4x4 up to model dimensions
ValidationResult validate_request(json const& state_json, int model_rows, int model_columns);

// Converts a SerializedGameState JSON object to a deep-wallwars Board
// Uses padding to embed smaller game boards within the model dimensions
// Precondition: validate_request(state_json, model_rows, model_columns) must return valid=true
// Returns: {Board, Turn, PaddingConfig} representing the current game state
std::tuple<Board, Turn, PaddingConfig> convert_state_to_board(
    json const& state_json,
    int model_rows,
    int model_columns);

// ============================================================================
// Engine Functions
// ============================================================================

// Result of finding the best move: (move notation, evaluation)
struct MoveResult {
    std::string notation;
    float evaluation;
};

// Runs MCTS to find the best move for the current position
// Returns the move in standard notation (e.g., "Ce4.Md5.>f3") and position evaluation
// The notation is transformed from model coordinates to game coordinates using padding_config
// Evaluation is returned from P1's perspective (+1 = P1 winning, -1 = P2 winning)
// Returns std::nullopt if no legal move is available
std::optional<MoveResult> find_best_move(
    Board const& board,
    Turn turn,
    EvaluationFunction const& eval_fn,
    EngineConfig const& config,
    PaddingConfig const& padding_config);

// Evaluates the position and returns true if the engine should accept a draw
// Accepts if the engine's position is worse (negative evaluation from engine's perspective)
bool should_accept_draw(
    Board const& board,
    Turn turn,
    int my_player_id,
    EvaluationFunction const& eval_fn,
    EngineConfig const& config);

// ============================================================================
// Request Handling (V2)
// ============================================================================

// Processes an engine request (move or draw) and returns the JSON response
json handle_engine_request(
    json const& request,
    EvaluationFunction const& eval_fn,
    EngineConfig const& config);

// ============================================================================
// V3 Bot Game Session (BGS) Support
// ============================================================================

// Validates a V3 BgsConfig for compatibility with deep-wallwars
// - Supports Classic and Standard variants
// - Supports boards from 4x4 up to model dimensions
ValidationResult validate_bgs_config(
    json const& bgs_config,
    int model_rows,
    int model_columns);

// Converts a V3 BgsConfig JSON to a deep-wallwars Board at the initial position
// BgsConfig format: {variant, boardWidth, boardHeight, initialState}
// initialState contains pawns and walls in the V3 format
// Returns: {Board, Turn, PaddingConfig} at ply 0 (P1's turn, First action)
std::tuple<Board, Turn, PaddingConfig> convert_bgs_config_to_board(
    json const& bgs_config,
    int model_rows,
    int model_columns);

// Parse a move from standard notation into the internal Move type
// Transforms coordinates from game space to model space using padding
// Standard notation format: "Ce4.Md5" or "Ce4.>f3" (pawn moves and walls)
// Returns nullopt if the notation is invalid
std::optional<Move> parse_move_notation(
    std::string const& notation,
    Board const& board,
    Turn turn,
    PaddingConfig const& padding_config);

}  // namespace engine_adapter
