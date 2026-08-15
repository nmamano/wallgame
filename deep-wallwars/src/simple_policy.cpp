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

    auto add_pawn_moves = [&](Pawn pawn, Cell goal, bool prefer_closer) {
        Cell const pos = board.pawn_position(turn.player, pawn);
        int const dist = board.distance(pos, goal);

        for (Direction dir : board.legal_directions(turn.player, pawn)) {
            if (is_backtrack(pawn, pos.step(dir))) {
                continue;
            }

            int const new_dist = board.distance(pos.step(dir), goal);
            float prior = 1;

            if (prefer_closer) {
                if (new_dist < dist) prior = m_good_move_bias;
                else if (new_dist > dist) prior = m_bad_move_bias;
            } else {
                if (new_dist > dist) prior = m_good_move_bias;
                else if (new_dist < dist) prior = m_bad_move_bias;
            }

            if (prior > 0) {
                edges.emplace_back(PawnMove{pawn, dir}, prior);
                total_prior += prior;
            }
        }
    };

    if (board.variant() == Variant::AnimalCycle) {
        auto pawns = board.movable_pawns(turn.player);
        for (Pawn pawn : pawns) {
            Player opponent = other_player(turn.player);
            Cell target = pawn == Pawn::Dog ? board.pawn_position(opponent, Pawn::Cat)
                        : pawn == Pawn::Cat ? board.pawn_position(opponent, Pawn::Mouse)
                        : pawn == Pawn::Mouse ? board.pawn_position(opponent, Pawn::Elephant)
                                              : board.pawn_position(opponent, Pawn::Dog);
            add_pawn_moves(pawn, target, true);
        }
    } else {
        add_pawn_moves(Pawn::Cat, board.goal(turn.player), true);
        if (board.allows_mouse_moves()) {
            add_pawn_moves(Pawn::Mouse, board.position(other_player(turn.player)), false);
        }
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

    co_return Evaluation(board.score_for(turn.player, turn), std::move(edges));
}
