#pragma once

#include <atomic>
#include <chrono>
#include <mutex>
#include <ostream>
#include <string>

#include <folly/experimental/coro/Task.h>

#include "gamestate.hpp"
#include "mcts.hpp"

struct AnalysisTask {
    Board board;
    Turn turn;
    std::string game_id;
    int move_index;
    int game_rows;
    int game_columns;
};

folly::coro::Task<void> analyze_game(EvaluationFunction const& analyze_fn,
                                     EvaluationFunction const& play_fn, bool separate_player,
                                     Board start_board, std::ostream& out);

folly::coro::Task<int> analyze_position(EvaluationFunction const& analyze_fn,
                                        AnalysisTask const& task, int index, std::ostream& out,
                                        std::mutex& out_mutex, std::atomic<int>& completed,
                                        int total,
                                        std::chrono::steady_clock::time_point start);
