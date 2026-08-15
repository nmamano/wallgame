#pragma once

#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <tuple>

#include "gamestate.hpp"
#include "mcts.hpp"

namespace engine_adapter {

using json = nlohmann::json;

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

// Create a self-play/training board for a smaller effective game embedded in
// the model frame: cats at the game-space corners transformed to model
// coordinates, padding walls placed. Goal semantics match serving
// (convert_bgs_config_to_board): Classic goals sit at the MODEL bottom
// corners (the padding leaves the bottom row open as the path to them);
// Standard mice are transformed game-space corners. Equal dims returns the
// standard board unchanged.
Board make_padded_training_board(int model_columns, int model_rows, int game_columns,
                                 int game_rows, Variant variant);

// Transform move notation from model coordinates to game coordinates
std::string transform_move_notation(
    std::string const& model_notation,
    Cell cat_pos,   // Current cat position in model coords
    Cell mouse_pos, // Current mouse position in model coords
    PaddingConfig const& config);

// ============================================================================
// Bot Game Session (BGS) Support
// ============================================================================

// Validates a BgsConfig for compatibility with deep-wallwars
// - Supports Classic and Standard variants
// - Supports boards from 4x4 up to model dimensions
ValidationResult validate_bgs_config(
    json const& bgs_config,
    int model_rows,
    int model_columns);

// Converts a BgsConfig JSON to a deep-wallwars Board at the supplied position.
// BgsConfig format: {variant, boardWidth, boardHeight, initialState}
// initialState is authoritative for pawns/homes, walls, and optional turn.
// A missing turn means P1 with no spent action. actionsTaken supports exactly
// [] or one complete protocol action. A spent pawn action uses its source cell
// to preserve the no-immediate-return rule; its target is validated but the
// supplied board already contains the resulting position. A spent wall only
// selects the second action. This describes the current turn seed, not an
// equivalent reconstruction of prior history, repetition state, or evaluation
// provenance.
std::tuple<Board, Turn, PaddingConfig> convert_bgs_config_to_board(
    json const& bgs_config,
    int model_rows,
    int model_columns);

// Parse a move from standard notation into a list of actions
// Transforms coordinates from game space to model space using padding
// Standard notation format: "Ce4.Md5" or "Ce4.>f3" (pawn moves and walls)
// Supports 1 or more actions (standard variant allows single-action moves)
// Returns nullopt if the notation is invalid
std::optional<std::vector<Action>> parse_move_notation(
    std::string const& notation,
    Board const& board,
    Turn turn,
    PaddingConfig const& padding_config);

}  // namespace engine_adapter
