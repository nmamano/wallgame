#include "batched_model_policy.hpp"

#include <stdexcept>

BatchedModelPolicy::BatchedModelPolicy(std::shared_ptr<BatchedModel> model)
    : m_model{std::move(model)} {}

folly::coro::Task<Evaluation> BatchedModelPolicy::operator()(
    Board const& board, Turn turn, std::optional<PreviousPosition> previous_position) {
    auto state = convert_to_model_input(board, turn);
    auto inference_result = co_await m_model->inference(std::move(state));

    Evaluation eval;
    eval.value = inference_result.value;

    std::size_t board_size = board.columns() * board.rows();
    std::size_t wall_prior_size = 2 * board_size;
    int required_move_priors = board.move_prior_size();
    int model_move_priors = m_model->move_prior_size();
    if (model_move_priors < required_move_priors) {
        throw std::runtime_error(
            "Model priors do not include required move channels for this variant");
    }
    float total_prior = 0.0;

    auto is_backtrack = [&](Pawn pawn, Cell next_cell) {
        return previous_position && previous_position->pawn == pawn &&
               previous_position->cell == next_cell;
    };

    auto add_pawn_moves = [&](Pawn pawn, Cell pos, int offset) {
        for (Direction dir : board.legal_directions(turn.player, pawn)) {
            Cell next = pos.step(dir);
            if (is_backtrack(pawn, next)) {
                continue;
            }
            float prior = inference_result.prior[offset + int(dir)];
            eval.edges.emplace_back(PawnMove{pawn, dir}, prior);
            total_prior += prior;
        }
    };

    add_pawn_moves(Pawn::Cat, board.position(turn.player), int(wall_prior_size));
    if (board.allows_mouse_moves()) {
        add_pawn_moves(Pawn::Mouse, board.mouse(turn.player), int(wall_prior_size + 4));
    }

    auto const legal_walls = board.legal_walls();

    for (Wall wall : legal_walls) {
        int index =
            int(wall.type) * board.columns() * board.rows() + board.index_from_cell(wall.cell);
        eval.edges.emplace_back(wall, inference_result.prior[index]);
        total_prior += inference_result.prior[index];
    }

    // Renormalize to account for illegal actions.
    for (TreeEdge& edge : eval.edges) {
        edge.prior /= total_prior;
    }

    co_return eval;
}
