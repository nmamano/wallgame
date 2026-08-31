#pragma once

#include <filesystem>
#include <iosfwd>
#include <vector>

#include "gamestate.hpp"
#include "mcts.hpp"

struct TrainingGame;

struct ModelOutput {
    std::vector<float> prior;
    float value;
};

using ModelInput = std::vector<float>;

inline constexpr int kUniversalModelInputChannels = 16;
inline constexpr int kUniversalMovePriorChannels = 8;

// Stable universal policy layout: right walls, down walls, then four directions for each of the
// current player's two movable-pawn slots. Classic uses only the first slot; its second slot stays
// zero. Pass has no logit.
std::size_t universal_policy_index(Board const& board, Turn turn, Action const& action);
std::vector<bool> legal_policy_mask(NodeInfo const& node_info);

// Converts current position in the MCTS tree into the output that we would have expected from the
// ML model. The value is the outcome-first target supplied by the completed game contract.
ModelOutput convert_to_model_output(NodeInfo const& node_info, float value_target);

// Outcome-first value from `player`'s perspective. Only completed nonterminal player turns count
// toward distance; a terminal action in the current turn therefore keeps magnitude 1.
float training_value_target(Winner winner, Player player, int completed_turn_distance);

// Converts current board state into a vector of [0, 1] floats so it can be used for ML models.
// The universal contract is 16 planes. Eight-channel legacy ResNets remain readable by explicit
// request; nine-channel universal models must be migrated before use.
ModelInput convert_to_model_input(Board const& board, Turn turn,
                                  int num_channels = kUniversalModelInputChannels);

// Print a single training data point (input, expected output) to `out_stream`. These will be read
// in from Python for training.
void print_training_data_point(std::ostream& out_stream, ModelInput const& input,
                               ModelOutput const& model_output);

class TrainingDataPrinter {
public:
    explicit TrainingDataPrinter(std::filesystem::path directory);

    // Writes one game's combined decision records (see CompletionCallback in
    // play.hpp) to game_<index>.csv. Called exactly once per game; every
    // record's policy label is the searching tree's visit distribution.
    void operator()(TrainingGame const& game, int index) const;

private:
    std::filesystem::path m_directory;
};
