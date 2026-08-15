#pragma once

#include <filesystem>
#include <iosfwd>
#include <vector>

#include "gamestate.hpp"
#include "mcts.hpp"

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
// ML model. This is used for training. The expected output value is a convex combination of the
// actual winner and the MCTS value.
ModelOutput convert_to_model_output(NodeInfo const& node_info, float score_for_red,
                                    float winner_contribution);

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
    TrainingDataPrinter(std::filesystem::path directory, float winner_contribution = 0.5);

    // Writes one game's combined decision records (see CompletionCallback in
    // play.hpp) to game_<index>.csv. Called exactly once per game; every
    // record's policy label is the searching tree's visit distribution.
    void operator()(std::vector<NodeInfo> const& records, Board const& final_board,
                    int index) const;

private:
    std::filesystem::path m_directory;
    float m_winner_contribution;
};
