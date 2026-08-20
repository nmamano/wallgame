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

folly::coro::Task<std::vector<Action>> best_turn(
    EvaluationFunction const& policy,
    Board const& board,
    Turn turn,
    std::optional<PreviousPosition> previous_position) {

    // Assumes `turn.action == Turn::First`, because a turn that has already spent an action needs
    // ONE more, not two - the caller asks for `best_action` in that case. Same convention as
    // MCTS::peek_best_move, which reads the two actions off a First-action root.
    auto action1 = co_await best_action(policy, board, turn, previous_position);
    if (!action1) {
        // Nothing legal to do at all, which the rules answer with a pass.
        co_return std::vector<Action>{};
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

    if (turn_must_end_after_action(after_first, turn.player)) {
        // The capture is made, so the turn simply stops here. An earlier version appended an
        // arbitrary legal wall to fill a second slot the protocol was believed to require, and
        // refused outright when no wall was left; a one-action turn is the honest answer and it
        // cannot refuse.
        //
        // The predicate is SHARED with the BGS handler and the search on purpose. This used to be a
        // bare `reached_goal`, which is blind to an Animal Cycle capture, and the handler papered
        // over that by re-testing the first action itself. It no longer does, so a private copy of
        // this question here would let the naive fallback append a second action after a winning
        // Animal Cycle capture and walk away from the win.
        co_return std::vector<Action>{*action1};
    }

    auto action2 = co_await best_action(policy, after_first, turn.next(), second_previous_position);
    if (!action2) {
        // Nothing legal is left after the first action, so the turn is one action long.
        co_return std::vector<Action>{*action1};
    }

    co_return std::vector<Action>{*action1, *action2};
}

}  // namespace naive
