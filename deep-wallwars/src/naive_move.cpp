#include "naive_move.hpp"

#include <algorithm>
#include <ranges>

namespace naive {

folly::coro::Task<std::optional<Action>> best_action(
    EvaluationFunction const& policy,
    Board const& board,
    Turn turn,
    std::optional<PreviousPosition> previous_position) {

    Evaluation eval = co_await policy(board, turn, previous_position);

    if (eval.edges.empty()) {
        co_return std::nullopt;
    }

    co_return std::ranges::max_element(eval.edges, {}, [](TreeEdge const& te) {
               return te.prior;
           })->action;
}

folly::coro::Task<std::optional<Move>> best_move(
    EvaluationFunction const& policy,
    Board const& board,
    Turn turn,
    std::optional<PreviousPosition> previous_position) {

    // Assumes `turn.action == Turn::First`, because a turn that has already spent an action needs
    // ONE more, not two - the caller asks for `best_action` in that case. Same convention as
    // MCTS::peek_best_move, which reads the two actions off a First-action root.
    auto action1 = co_await best_action(policy, board, turn, previous_position);
    if (!action1) {
        co_return std::nullopt;
    }

    // Built BEFORE the action is applied, because it records where the pawn came FROM. This is what
    // stops the second action from undoing the first: the policy drops the backtrack when it is told
    // about it. Only pawn moves can be undone, so a wall leaves this empty - the same rule
    // MCTS::initialize_child applies when it descends a level.
    std::optional<PreviousPosition> second_previous_position;
    if (auto const* pawn_move = std::get_if<PawnMove>(&*action1)) {
        second_previous_position = PreviousPosition{
            pawn_move->pawn, board.pawn_position(turn.player, pawn_move->pawn)};
    }

    Board after_first = board;
    after_first.do_action(turn.player, *action1);

    if (after_first.winner() != Winner::Undecided) {
        // The game is over, so the second action cannot matter - but the protocol still wants a
        // complete turn. Same behaviour as MCTS::peek_best_move here.
        std::vector<Wall> const legal_walls = after_first.legal_walls();
        if (legal_walls.empty()) {
            co_return std::nullopt;
        }
        co_return Move{*action1, legal_walls[0]};
    }

    auto action2 = co_await best_action(policy, after_first, turn.next(), second_previous_position);
    if (!action2) {
        co_return std::nullopt;
    }

    co_return Move{*action1, *action2};
}

}  // namespace naive
