#pragma once

#include <nlohmann/json.hpp>
#include <optional>
#include <string>

#include "gamestate.hpp"
#include "mcts.hpp"

namespace engine_adapter {

using json = nlohmann::json;

// ============================================================================
// Types matching the official custom-bot client Engine API v1
// ============================================================================

struct EngineConfig {
    std::string model_path;
    int think_time_seconds;
    int samples = 500;              // MCTS samples per action
    std::uint32_t seed = 42;
};

struct ValidationResult {
    bool valid;
    std::string error_message;  // Only populated if !valid
};

// ============================================================================
// State Conversion Functions
// ============================================================================

// Validates that the request is compatible with deep-wallwars capabilities
// - Only supports Classic variant
// - Only supports 8x8 boards
ValidationResult validate_request(json const& state_json);

// Converts a SerializedGameState JSON object to a deep-wallwars Board
// Precondition: validate_request(state_json) must return valid=true
// Returns: {Board, Turn} representing the current game state
std::pair<Board, Turn> convert_state_to_board(json const& state_json);

// ============================================================================
// Engine Functions
// ============================================================================

// Runs MCTS to find the best move for the current position
// Returns the move in standard notation (e.g., "Ce4.Md5.>f3")
// Returns std::nullopt if no legal move is available
std::optional<std::string> find_best_move(
    Board const& board,
    Turn turn,
    EvaluationFunction const& eval_fn,
    EngineConfig const& config);

// Evaluates the position and returns true if the engine should accept a draw
// Accepts if the engine's position is worse (negative evaluation from engine's perspective)
bool should_accept_draw(
    Board const& board,
    Turn turn,
    int my_player_id,
    EvaluationFunction const& eval_fn,
    EngineConfig const& config);

// ============================================================================
// Request Handling
// ============================================================================

// Processes an engine request (move or draw) and returns the JSON response
json handle_engine_request(
    json const& request,
    EvaluationFunction const& eval_fn,
    EngineConfig const& config);

}  // namespace engine_adapter
