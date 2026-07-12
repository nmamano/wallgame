#include "play.hpp"

#include <folly/executors/CPUThreadPoolExecutor.h>
#include <folly/experimental/coro/BlockingWait.h>

#include <catch2/catch_test_macros.hpp>
#include <vector>

#include "simple_policy.hpp"

// Regression tests for the training-data corruption fixed in 2026-07:
// previously both MCTS trees wrote game_<index>.csv (second write truncated
// the first), leaving blue decisions with real visit distributions but red
// decisions with fast-forwarded one-hot labels. Now every decision is
// recorded from the tree that searched it, and the callback fires once.

namespace {

int interior_wall_count(Board const& board) {
    int count = 0;
    for (int c = 0; c < board.columns(); ++c) {
        for (int r = 0; r < board.rows(); ++r) {
            if (c + 1 < board.columns() && board.is_blocked(Wall{Cell{c, r}, Wall::Right})) {
                ++count;
            }
            if (r + 1 < board.rows() && board.is_blocked(Wall{Cell{c, r}, Wall::Down})) {
                ++count;
            }
        }
    }
    return count;
}

int sampled_edge_count(NodeInfo const& info) {
    int count = 0;
    for (auto const& edge : info.edges) {
        if (edge.num_samples > 0) {
            ++count;
        }
    }
    return count;
}

}  // namespace

TEST_CASE("training_play records searched decisions exactly once per game",
          "[TrainingRecords]") {
    Board board{5, 5};

    int calls = 0;
    std::vector<NodeInfo> captured;

    TrainingPlayOptions opts{
        .model1 = SimplePolicy{1.0, 1.5, 0.75},
        .model2 = SimplePolicy{1.0, 1.5, 0.75},
        .samples = 32,
        .max_parallel_games = 1,
        .max_parallel_samples = 4,
        .move_limit = 100,
        .temperature = 1,
        .on_complete =
            [&](std::vector<NodeInfo> const& records, Board const&, int) {
                ++calls;
                captured = records;
            },
        .seed = 7,
    };

    folly::CPUThreadPoolExecutor pool(2);
    folly::coro::blockingWait(training_play(board, 1, opts).scheduleOn(&pool));

    // The callback fires exactly once per game (no double-write).
    REQUIRE(calls == 1);
    REQUIRE(!captured.empty());

    // The first record is the INITIAL position: red to move, red cat at its
    // start, zero interior walls (board-edge blocking is not a placed wall).
    NodeInfo const& first = captured.front();
    CHECK(first.turn.player == Player::Red);
    CHECK(first.turn.action == Turn::First);
    CHECK(first.board.position(Player::Red) == Cell{0, 0});
    CHECK(interior_wall_count(first.board) == 0);

    // With a healthy sample count the first decision's label is a visit
    // DISTRIBUTION over multiple actions, not a forced one-hot.
    CHECK(sampled_edge_count(first) > 1);

    // Records cover decisions of BOTH players (each from its own searching
    // tree), and every record carries at least one sampled edge.
    bool has_red = false;
    bool has_blue = false;
    for (auto const& record : captured) {
        has_red = has_red || record.turn.player == Player::Red;
        has_blue = has_blue || record.turn.player == Player::Blue;
        CHECK(sampled_edge_count(record) >= 1);
    }
    CHECK(has_red);
    CHECK(has_blue);
}
