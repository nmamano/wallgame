#include "mcts.hpp"

#include <folly/Executor.h>
#include <folly/executors/GlobalExecutor.h>
#include <folly/executors/QueuedImmediateExecutor.h>
#include <folly/experimental/coro/BlockingWait.h>
#include <folly/experimental/coro/Sleep.h>

#include <atomic>
#include <catch2/catch_test_macros.hpp>
#include <memory>

#include "simple_policy.hpp"

namespace {
Board standard_board(int columns, int rows, Cell red_cat, Cell red_mouse, Cell blue_cat,
                     Cell blue_mouse) {
    return Board{columns,
                 rows,
                 Variant::Standard,
                 {{Player::Red, Pawn::Cat, red_cat},
                  {Player::Red, Pawn::Mouse, red_mouse},
                  {Player::Blue, Pawn::Cat, blue_cat},
                  {Player::Blue, Pawn::Mouse, blue_mouse}}};
}
}  // namespace

// For testing, only generates moves downwards
struct DownPolicy {
    std::shared_ptr<int> samples = std::make_shared<int>(0);

    folly::coro::Task<Evaluation> operator()(Board const& board, Turn turn,
                                             std::optional<PreviousPosition>) {
        ++*samples;
        if (board.is_blocked(Wall{board.position(turn.player), Direction::Down})) {
            co_return Evaluation{0, {}};
        }
        co_return Evaluation{0, {TreeEdge(PawnMove{Pawn::Cat, Direction::Down}, 1.0)}};
    };
};

TEST_CASE("Basic Initialization", "[MCTS]") {
    Board board{4, 4};
    MCTS mcts{SimplePolicy{1.0, 1.0, 1.0}, std::move(board)};

    CHECK(mcts.root_value() == 0.0);
    CHECK(mcts.root_samples() == 1);
    CHECK(mcts.wasted_inferences() == 0);
}

TEST_CASE("Single sample", "[MCTS]") {
    Board board{4, 4};
    MCTS mcts{SimplePolicy{1.0, 1.0, 1.0}, std::move(board)};

    folly::coro::blockingWait(mcts.sample(1));

    CHECK(mcts.root_value() > 0.0);
    CHECK(mcts.root_samples() == 2);
    CHECK(mcts.wasted_inferences() == 0);
}

TEST_CASE("Commit to action", "[MCTS]") {
    Board board{4, 4};
    MCTS mcts{DownPolicy{}, std::move(board)};

    CHECK_FALSE(mcts.commit_to_action());
    CHECK_FALSE(mcts.commit_to_action(0.2));

    folly::coro::blockingWait(mcts.sample(1));

    auto action = mcts.commit_to_action();
    CHECK(std::get<PawnMove>(*action).dir == Direction::Down);
    CHECK(mcts.current_board().position(Player::Red) == Cell{0, 1});
}

TEST_CASE("Force action", "[MCTS]") {
    Board board{4, 4};
    MCTS mcts{DownPolicy{}, std::move(board)};

    SECTION("No previous sample") {}
    SECTION("Previous sample") {
        folly::coro::blockingWait(mcts.sample(1));
    }

    mcts.force_action(PawnMove{Pawn::Cat, Direction::Down});
    CHECK(mcts.root_samples() == 1);
    CHECK(mcts.current_board().position(Player::Red) == Cell{0, 1});
}

TEST_CASE("Sample many", "[MCTS]") {
    Board board{4, 4};
    DownPolicy policy;
    MCTS mcts{policy, std::move(board)};

    folly::coro::blockingWait(mcts.sample(1000));

    CHECK(mcts.wasted_inferences() == 0);
    CHECK(mcts.root_samples() == 1001);
    CHECK(*policy.samples == 6);
}

struct SlowDownPolicy {
    std::shared_ptr<std::atomic<int>> samples = std::make_shared<std::atomic<int>>(0);

    folly::coro::Task<Evaluation> operator()(Board const& board, Turn turn,
                                             std::optional<PreviousPosition>) {
        ++*samples;
        co_await folly::coro::sleep(std::chrono::milliseconds{250});
        Evaluation result;

        if (board.is_blocked(Wall{board.position(turn.player), Direction::Down})) {
            result = Evaluation{0, {}};
        } else {
            result = Evaluation{0, {TreeEdge(PawnMove{Pawn::Cat, Direction::Down}, 1.0)}};
        }
        co_return result;
    };
};

TEST_CASE("Sample slow in parallel", "[MCTS]") {
    Board board{4, 4};
    SlowDownPolicy policy;
    MCTS mcts{policy, std::move(board), {.max_parallelism = 5}};

    folly::coro::blockingWait(mcts.sample(16));

    CHECK(mcts.wasted_inferences() == 12);
    CHECK(mcts.root_samples() == 17);
    CHECK(*policy.samples > 3);
}

// Offers exactly ONE action, so these tests are about what the move-assembly code does with a first
// action rather than about which action the search happens to prefer.
struct OnlyPolicy {
    Pawn pawn;
    Direction dir;

    folly::coro::Task<Evaluation> operator()(Board const& board, Turn turn,
                                             std::optional<PreviousPosition>) {
        std::vector<TreeEdge> edges;
        if (!board.is_blocked(Wall{board.pawn_position(turn.player, pawn), dir})) {
            edges.emplace_back(PawnMove{pawn, dir}, 1.0);
        }
        co_return Evaluation{0, std::move(edges)};
    };
};

// Replaying an opponent's move must apply BOTH actions even when the first one lands a pawn on the
// cell where it could be taken, because a capture is judged only when the turn ends. Stopping there
// left the tree a turn behind the real game, after which every later move was refused (board task
// 8911a6d5).
TEST_CASE("force_move walks a mouse past a cat", "[MCTS]") {
    Board board = standard_board(5, 5, {0, 0}, {2, 2}, {3, 2}, {4, 4});
    MCTS mcts{SimplePolicy{1.0, 1.0, 1.0}, std::move(board)};

    mcts.force_move(
        Move{PawnMove{Pawn::Mouse, Direction::Right}, PawnMove{Pawn::Mouse, Direction::Right}});

    CHECK(mcts.current_board().mouse(Player::Red) == Cell{4, 2});
    CHECK(mcts.current_turn() == Turn{Player::Blue, Turn::First});
    CHECK(mcts.current_board().winner() == Winner::Undecided);
}

// The mover's OWN capture does still finish the turn with a wall. The cat has to stay on the mouse
// for the capture to count at the turn boundary, and a wall is the one action that leaves it there.
TEST_CASE("peek_best_move finishes a capture with a wall", "[MCTS]") {
    // Red's cat one step left of Blue's mouse, and stepping right is its only action.
    Board board = standard_board(5, 5, {2, 2}, {0, 0}, {4, 4}, {3, 2});
    MCTS mcts{OnlyPolicy{Pawn::Cat, Direction::Right}, std::move(board)};

    folly::coro::blockingWait(mcts.sample(2));
    auto move = mcts.peek_best_move();

    REQUIRE(move);
    CHECK(std::get<PawnMove>(move->first).pawn == Pawn::Cat);
    CHECK(std::holds_alternative<Wall>(move->second));
}

/*
A turn whose first action has NOTHING legal after it is a one-action turn, not a dead end.

This is the shape that made the engine answer "No legal move available" in a real game on
2026-08-20: every legal move at that position was a single cat step, one of them winning, and the
two-action assembly reported the whole turn impossible. The rules allow a turn of one action, so the
first action must survive the second one's absence.

`peek_best_move` still answers nullopt here, and that is correct - it promises a complete two-action
`Move` to callers that need one. The point is that it is no longer the only way to ask.
*/
TEST_CASE("peek_best_second_action reports no second action without losing the first", "[MCTS]") {
    // Red's mouse one step from the right edge, and stepping right is its only action - so once it
    // has stepped there is nothing legal left to do.
    Board board = standard_board(5, 5, {0, 0}, {3, 2}, {0, 4}, {4, 4});
    MCTS mcts{OnlyPolicy{Pawn::Mouse, Direction::Right}, std::move(board)};

    folly::coro::blockingWait(mcts.sample(2));

    auto action1 = mcts.peek_best_action();
    REQUIRE(action1);
    CHECK(std::get<PawnMove>(*action1).pawn == Pawn::Mouse);

    // There is genuinely no second action...
    CHECK_FALSE(mcts.peek_best_second_action(*action1).has_value());
    // ...and asking for a complete two-action move is what cannot be answered. Before the fix this
    // was the ONLY question the BGS handler asked, so the first action was thrown away with it.
    CHECK_FALSE(mcts.peek_best_move().has_value());
}

// The mirror case must NOT take that shortcut. Our own mouse stepping onto the enemy cat decides
// nothing, so filling the rest of the turn with a wall would strand the mouse on the cat and hand
// the game over at the turn boundary.
TEST_CASE("peek_best_move walks a mouse past a cat instead of stranding it", "[MCTS]") {
    // Red's mouse one step left of Blue's cat, and stepping right is its only action.
    Board board = standard_board(5, 5, {0, 0}, {2, 2}, {3, 2}, {4, 4});
    MCTS mcts{OnlyPolicy{Pawn::Mouse, Direction::Right}, std::move(board)};

    folly::coro::blockingWait(mcts.sample(2));
    auto move = mcts.peek_best_move();

    REQUIRE(move);
    CHECK(std::get<PawnMove>(move->first).pawn == Pawn::Mouse);
    REQUIRE(std::holds_alternative<PawnMove>(move->second));
    CHECK(std::get<PawnMove>(move->second).pawn == Pawn::Mouse);
}
