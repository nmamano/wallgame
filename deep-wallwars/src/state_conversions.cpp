#include "state_conversions.hpp"

#include <folly/Overload.h>

#include <filesystem>
#include <fstream>

ModelOutput convert_to_model_output(NodeInfo const& node_info, float score_for_red,
                                    float winner_contribution) {
    std::size_t board_size = node_info.board.columns() * node_info.board.rows();
    std::size_t wall_prior_size = 2 * board_size;
    std::size_t move_prior_size = node_info.board.move_prior_size();
    std::vector<float> priors(wall_prior_size + move_prior_size);

    // Note: the sum of samples in the children is not equal to the sum of samples in the parent
    // because some samples *end* in the parent. *Typically* only one sample does but due to the
    // depth limit, it can happen that more do.
    int total_samples = 0;
    for (EdgeInfo const& edge_info : node_info.edges) {
        total_samples += edge_info.num_samples;
    }

    for (EdgeInfo const& edge_info : node_info.edges) {
        if (!edge_info.num_samples) {
            continue;
        }

        float prior = float(edge_info.num_samples) / total_samples;

        folly::variant_match(
            edge_info.action,
            [&](PawnMove move) {
                auto movable = node_info.board.movable_pawns(node_info.turn.player);
                int pawn_offset = move.pawn == movable[0] ? 0 : 4;
                priors[wall_prior_size + pawn_offset + int(move.dir)] = prior;
            },
            [&](Wall wall) {
                priors[int(wall.type) * board_size +
                       node_info.board.index_from_cell(wall.cell)] = prior;
            });
    }

    float const z_value = node_info.turn.player == Player::Red ? score_for_red : -score_for_red;
    float const expected_value =
        (1 - winner_contribution) * node_info.q_value + winner_contribution * z_value;
    return {std::move(priors), expected_value};
}

std::vector<float> convert_to_model_input(Board const& board, Turn turn, int num_channels) {
    std::size_t board_size = board.columns() * board.rows();
    std::vector<float> state(num_channels * board_size);

    auto blocked_directions = board.blocked_directions();
    std::vector<std::pair<Cell, int>> queue_vec;
    std::fill(state.begin(), state.begin() + 4 * board_size, 1.0f);
    auto const [player_pawn, player_target] = board.model_landmarks(turn.player);
    auto const [opponent_pawn, opponent_target] =
        board.model_landmarks(other_player(turn.player));
    board.fill_relative_distances(player_pawn, {state.begin(), board_size}, blocked_directions,
                                  queue_vec);
    board.fill_relative_distances(player_target, {state.begin() + board_size, board_size},
                                  blocked_directions, queue_vec);

    board.fill_relative_distances(opponent_pawn,
                                  {state.begin() + 2 * board_size, board_size}, blocked_directions,
                                  queue_vec);
    board.fill_relative_distances(opponent_target,
                                  {state.begin() + 3 * board_size, board_size}, blocked_directions,
                                  queue_vec);

    for (int column = 0; column < board.columns(); ++column) {
        for (int row = 0; row < board.rows(); ++row) {
            Cell cell{column, row};
            for (int type = 0; type < 2; ++type) {
                state[(4 + type) * board_size + board.index_from_cell(cell)] =
                    board.is_blocked({cell, Wall::Type(type)});
            }
        }
    }

    if (turn.action == Turn::Second) {
        std::fill(state.begin() + 6 * board_size, state.begin() + 7 * board_size, 1.0);
    }

    // Model needs to know if it is red because of draws
    if (turn.player == Player::Red) {
        std::fill(state.begin() + 7 * board_size, state.begin() + 8 * board_size, 1.0);
    }

    // Plane 8: variant indicator (only for 9-channel universal models)
    if (num_channels >= 9 && board.allows_mouse_moves()) {
        std::fill(state.begin() + 8 * board_size, state.begin() + 9 * board_size, 1.0);
    }

    return state;
}

void print_training_data_point(std::ostream& out_stream, ModelInput const& model_input,
                               ModelOutput const& model_output) {
    auto it = std::ostream_iterator<float>(out_stream, ", ");

    std::copy(model_input.begin(), model_input.end() - 1, it);
    out_stream << model_input.back() << '\n';
    std::copy(model_output.prior.begin(), model_output.prior.end() - 1, it);
    out_stream << model_output.prior.back() << '\n';
    out_stream << model_output.value << "\n\n";
}

TrainingDataPrinter::TrainingDataPrinter(std::filesystem::path directory, float winner_contribution)
    : m_directory{std::move(directory)}, m_winner_contribution{winner_contribution} {
    std::filesystem::create_directory(m_directory);
}

void TrainingDataPrinter::operator()(std::vector<NodeInfo> const& records,
                                     Board const& final_board, int index) const {
    float score_for_red = final_board.score_for(Player::Red);

    std::ofstream output_file{m_directory / ("game_" + std::to_string(index) + ".csv")};

    for (NodeInfo const& node_info : records) {
        ModelInput model_input = convert_to_model_input(node_info.board, node_info.turn);
        ModelOutput model_output =
            convert_to_model_output(node_info, score_for_red, m_winner_contribution);
        print_training_data_point(output_file, model_input, model_output);
    }

    // Note: the terminal position is intentionally NOT emitted. It was never
    // searched, so it has no meaningful policy label; the game outcome already
    // reaches every record through the z-value blend in convert_to_model_output.
}
