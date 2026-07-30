#pragma once

#include <folly/experimental/coro/Task.h>

#include <optional>

#include "mcts.hpp"

/*
Picking a move from a policy's priors ALONE, with no tree search at all.

This exists for the losing-move fallback in the BGS adapter (board task b4c2b191). When the search
says a position is completely lost, every line loses, so the visit counts are ranking moves that all
have the same outcome - and the move that comes out can look absurd to a human, which is what Nil
reported. Playing a simple "walk toward the goal" policy instead loses in a way that reads as
stubborn rather than broken.

Two things make this a POLICY ARGMAX rather than a hand-rolled walker, and both are deliberate:

  - A turn is TWO actions, and after the first one the second is sometimes only "undo what you just
    did", which is illegal. An argmax over the priors the policy itself produced for the resulting
    position cannot emit an illegal action, whereas a hand-rolled "step toward the goal" can.
  - `SimplePolicy` already knows the rules that make a move naive-but-legal: it excludes the
    backtrack action given a `PreviousPosition`, and it only ever emits legal directions and walls.

Nothing here touches MCTS or the tree. These functions are pure with respect to the caller's search
state, so using them cannot perturb a session that later goes back to searching.
*/
namespace naive {

// The policy's own preferred action - the highest prior it reports for this position.
// Returns nullopt only when the policy reports no actions at all, which is a position with nothing
// legal to do.
folly::coro::Task<std::optional<Action>> best_action(
    EvaluationFunction const& policy,
    Board const& board,
    Turn turn,
    std::optional<PreviousPosition> previous_position);

// A complete turn: `best_action` twice, with the second call made on the position the FIRST action
// produced, so the second action is legal after the first rather than merely legal at the start.
//
// If the first action wins the game, the second is an arbitrary legal wall, matching what
// MCTS::peek_best_move does in the same situation - the game is already over, so the second action
// cannot matter, but the protocol still wants a complete turn.
folly::coro::Task<std::optional<Move>> best_move(
    EvaluationFunction const& policy,
    Board const& board,
    Turn turn,
    std::optional<PreviousPosition> previous_position);

}  // namespace naive
