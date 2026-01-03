#include "simple_policy.hpp"

SimplePolicy::SimplePolicy(float move_prior, float good_move_bias, float bad_move_bias)
    : m_move_prior{move_prior}, m_good_move_bias{good_move_bias}, m_bad_move_bias{bad_move_bias} {}

folly::coro::Task<Evaluation> SimplePolicy::operator()(Board const& board, Turn turn,
                                                       std::optional<PreviousPosition>
                                                           previous_position) {
    std::vector<Wall> legal_walls;
    if (m_move_prior < 1) {
        legal_walls = board.legal_walls();
    }

    std::vector<TreeEdge> edges;
    edges.reserve(legal_walls.size() + (board.allows_mouse_moves() ? 8 : 4));

    float total_prior = 0;

    auto is_backtrack = [&](Pawn pawn, Cell next_cell) {
        return previous_position && previous_position->pawn == pawn &&
               previous_position->cell == next_cell;
    };

    auto add_cat_moves = [&] {
        Cell const pos = board.position(turn.player);
        Cell const goal = board.goal(turn.player);
        int const dist = board.distance(pos, goal);

        for (Direction dir : board.legal_directions(turn.player, Pawn::Cat)) {
            if (is_backtrack(Pawn::Cat, pos.step(dir))) {
                continue;
            }

            int const new_dist = board.distance(pos.step(dir), goal);
            float prior = 1;

            if (new_dist < dist) {
                prior = m_good_move_bias;
            } else if (new_dist > dist) {
                prior = m_bad_move_bias;
            }

            if (prior > 0) {
                edges.emplace_back(PawnMove{Pawn::Cat, dir}, prior);
                total_prior += prior;
            }
        }
    };

    auto add_mouse_moves = [&] {
        Cell const pos = board.mouse(turn.player);
        Cell const target = board.position(other_player(turn.player));
        int const dist = board.distance(pos, target);

        for (Direction dir : board.legal_directions(turn.player, Pawn::Mouse)) {
            if (is_backtrack(Pawn::Mouse, pos.step(dir))) {
                continue;
            }

            int const new_dist = board.distance(pos.step(dir), target);
            float prior = 1;

            if (new_dist > dist) {
                prior = m_good_move_bias;
            } else if (new_dist < dist) {
                prior = m_bad_move_bias;
            }

            if (prior > 0) {
                edges.emplace_back(PawnMove{Pawn::Mouse, dir}, prior);
                total_prior += prior;
            }
        }
    };

    add_cat_moves();
    if (board.allows_mouse_moves()) {
        add_mouse_moves();
    }

    if (total_prior > 0.0f) {
        for (TreeEdge& te : edges) {
            te.prior *= m_move_prior / total_prior;
        }
    }

    if (!legal_walls.empty()) {
        float wall_prior = (1 - m_move_prior) / legal_walls.size();
        for (Wall wall : legal_walls) {
            edges.emplace_back(wall, wall_prior);
        }
    }

    co_return Evaluation(board.score_for(turn.player), std::move(edges));
}
