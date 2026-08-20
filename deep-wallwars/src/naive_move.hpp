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

  - A turn is up to TWO actions, and after the first one the second is sometimes only "undo what you
    just did", which is illegal. An argmax over the priors the policy itself produced for the
    resulting position cannot emit an illegal action, whereas a hand-rolled "step toward the goal"
    can.
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

// The turn the policy would play: `best_action`, and then `best_action` again on the position the
// FIRST action produced, so the second action is legal after the first rather than merely legal at
// the start.
//
// Returns the actions the turn ACTUALLY has, and therefore CANNOT refuse. Any of the three lengths
// is a legal turn under the rules:
//   - two actions, the ordinary case;
//   - ONE action, when the first action already DECIDED the game - see
//     `turn_must_end_after_action`, which is not the same as winning it - or when the position
//     after it has no legal action left because the only candidate would undo the first;
//   - NONE, when the position has no legal first action at all, which the rules answer with a pass.
// A short turn is an ANSWER here, never a failure to build a long one. An earlier version returned
// nullopt in the one-action cases on the belief that "the protocol still wants a complete turn";
// that belief was wrong - see `turn_notation` in gamestate.hpp.
folly::coro::Task<std::vector<Action>> best_turn(
    EvaluationFunction const& policy,
    Board const& board,
    Turn turn,
    std::optional<PreviousPosition> previous_position);

}  // namespace naive
