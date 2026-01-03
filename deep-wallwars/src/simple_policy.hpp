#pragma once

#include "mcts.hpp"

/*
Lightweight, non-ML evaluation policy used to drive MCTS when you're not using a
learned model. It builds priors for legal actions with heuristics: cat moves are
biased toward the goal, mouse moves (standard only) are biased away from the
opponent cat, and walls get the remaining probability mass. The value estimate
comes from board.score_for().
*/
class SimplePolicy {
public:
    SimplePolicy(float move_prior, float good_move_bias, float bad_move_bias);

    folly::coro::Task<Evaluation> operator()(Board const& board, Turn turn,
                                             std::optional<PreviousPosition> previous_position);

private:
    float m_move_prior;
    float m_good_move_bias;
    float m_bad_move_bias;
};
