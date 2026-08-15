#include "state_conversions.hpp"

#include "play.hpp"

#include <folly/Overload.h>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <stdexcept>

#include <nlohmann/json.hpp>

std::size_t universal_policy_index(Board const& board, Turn turn, Action const& action) {
    std::size_t const board_size = board.columns() * board.rows();
    return folly::variant_match(
        action,
        [&](PawnMove move) -> std::size_t {
            auto const movable = board.movable_pawns(turn.player);
            auto const pawn = std::find(movable.begin(), movable.end(), move.pawn);
            if (pawn == movable.end()) {
                throw std::invalid_argument("Policy action refers to a non-movable pawn");
            }
            std::size_t const pawn_offset = pawn == movable.begin() ? 0 : 4;
            return 2 * board_size + pawn_offset + static_cast<int>(move.dir);
        },
        [&](Wall wall) -> std::size_t {
            return static_cast<int>(wall.type) * board_size + board.index_from_cell(wall.cell);
        });
}

std::vector<bool> legal_policy_mask(NodeInfo const& node_info) {
    std::size_t const board_size = node_info.board.columns() * node_info.board.rows();
    std::vector<bool> mask(2 * board_size + kUniversalMovePriorChannels);
    for (EdgeInfo const& edge_info : node_info.edges) {
        std::size_t const index =
            universal_policy_index(node_info.board, node_info.turn, edge_info.action);
        if (mask[index]) {
            throw std::invalid_argument("Two legal actions map to the same policy index");
        }
        mask[index] = true;
    }
    return mask;
}

ModelOutput convert_to_model_output(NodeInfo const& node_info, float score_for_red,
                                    float winner_contribution) {
    std::size_t board_size = node_info.board.columns() * node_info.board.rows();
    std::vector<float> priors(2 * board_size + kUniversalMovePriorChannels);
    auto const legal_mask = legal_policy_mask(node_info);

    // Note: the sum of samples in the children is not equal to the sum of samples in the parent
    // because some samples *end* in the parent. *Typically* only one sample does but due to the
    // depth limit, it can happen that more do.
    int total_samples = 0;
    for (EdgeInfo const& edge_info : node_info.edges) {
        total_samples += edge_info.num_samples;
    }
    if (total_samples <= 0) {
        throw std::invalid_argument("Training policy label has no sampled legal action");
    }

    for (EdgeInfo const& edge_info : node_info.edges) {
        if (!edge_info.num_samples) {
            continue;
        }

        float prior = float(edge_info.num_samples) / total_samples;

        std::size_t const index =
            universal_policy_index(node_info.board, node_info.turn, edge_info.action);
        if (!legal_mask[index]) {
            throw std::logic_error("Policy label index is absent from its legal mask");
        }
        priors[index] = prior;
    }

    float const z_value = node_info.turn.player == Player::Red ? score_for_red : -score_for_red;
    float const expected_value =
        (1 - winner_contribution) * node_info.q_value + winner_contribution * z_value;
    return {std::move(priors), expected_value};
}

std::vector<float> convert_to_model_input(Board const& board, Turn turn, int num_channels) {
    if (num_channels != 8 && num_channels != kUniversalModelInputChannels) {
        throw std::invalid_argument(
            "Model input must use the 8-plane legacy or 16-plane universal contract");
    }
    std::size_t board_size = board.columns() * board.rows();
    std::vector<float> state(num_channels * board_size);

    auto blocked_directions = board.blocked_directions();
    std::vector<std::pair<Cell, int>> queue_vec;
    std::fill(state.begin(), state.begin() + 4 * board_size, 1.0f);
    std::array<Cell, 4> landmarks;
    if (board.variant() == Variant::AnimalCycle) {
        landmarks = turn.player == Player::Red
            ? std::array{
                  board.pawn_position(Player::Red, Pawn::Dog),
                  board.pawn_position(Player::Blue, Pawn::Cat),
                  board.pawn_position(Player::Blue, Pawn::Elephant),
                  board.pawn_position(Player::Red, Pawn::Mouse),
              }
            : std::array{
                  board.pawn_position(Player::Blue, Pawn::Cat),
                  board.pawn_position(Player::Red, Pawn::Mouse),
                  board.pawn_position(Player::Red, Pawn::Dog),
                  board.pawn_position(Player::Blue, Pawn::Elephant),
              };
    } else {
        auto const [player_pawn, player_target] = board.model_landmarks(turn.player);
        auto const [opponent_pawn, opponent_target] =
            board.model_landmarks(other_player(turn.player));
        landmarks = {player_pawn, player_target, opponent_pawn, opponent_target};
    }
    for (std::size_t plane = 0; plane < landmarks.size(); ++plane) {
        board.fill_relative_distances(
            landmarks[plane], {state.begin() + plane * board_size, board_size},
            blocked_directions, queue_vec);
    }

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

    if (num_channels == kUniversalModelInputChannels) {
        int variant_plane = 0;
        switch (board.variant()) {
            case Variant::Standard:
                variant_plane = 8;
                break;
            case Variant::Classic:
                variant_plane = 9;
                break;
            case Variant::AnimalCycle:
                variant_plane = 10;
                break;
        }
        std::fill(state.begin() + variant_plane * board_size,
                  state.begin() + (variant_plane + 1) * board_size, 1.0f);
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

void TrainingDataPrinter::operator()(TrainingGame const& game, int index) const {
    float score_for_red = game.final_board.score_for(Player::Red);

    std::ofstream output_file{m_directory / ("game_" + std::to_string(index) + ".csv")};
    nlohmann::json audit = {
        {"actualWinner", game.actual_winner == Winner::Red ? "red"
             : game.actual_winner == Winner::Blue ? "blue"
             : game.actual_winner == Winner::Draw ? "draw" : "undecided"},
        {"endReason", game.end_reason == TrainingEndReason::Terminal ? "terminal"
             : game.end_reason == TrainingEndReason::NoLegalAction ? "no-legal-action"
                                                                    : "move-limit"},
        {"heuristicScoreForRed", score_for_red},
        {"decisions", nlohmann::json::array()},
    };

    for (TrainingDecision const& decision : game.decisions) {
        NodeInfo const& node_info = decision.node;
        ModelInput model_input = convert_to_model_input(node_info.board, node_info.turn);
        ModelOutput model_output =
            convert_to_model_output(node_info, score_for_red, m_winner_contribution);
        print_training_data_point(output_file, model_input, model_output);
        auto const legal_mask = legal_policy_mask(node_info);
        nlohmann::json legal = nlohmann::json::array();
        for (std::size_t policy_index = 0; policy_index < legal_mask.size(); ++policy_index) {
            if (legal_mask[policy_index]) legal.push_back(policy_index);
        }
        audit["decisions"].push_back({
            {"player", node_info.turn.player == Player::Red ? "red" : "blue"},
            {"action", node_info.turn.action == Turn::First ? "first" : "second"},
            {"chosenPolicyIndex",
             universal_policy_index(node_info.board, node_info.turn, decision.chosen_action)},
            {"legalPolicyIndices", std::move(legal)},
            {"valueLabel", model_output.value},
        });
    }

    std::ofstream{m_directory / ("game_" + std::to_string(index) + ".audit.json")}
        << audit.dump(2) << '\n';

    // Note: the terminal position is intentionally NOT emitted. It was never
    // searched, so it has no meaningful policy label; the game outcome already
    // reaches every record through the z-value blend in convert_to_model_output.
}
