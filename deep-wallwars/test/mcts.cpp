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

struct TwoPriorPolicy {
    folly::coro::Task<Evaluation> operator()(Board const&, Turn,
                                             std::optional<PreviousPosition>) {
        co_return Evaluation{0.25f,
                             {{PawnMove{Pawn::Cat, Direction::Down}, 0.9f},
                              {PawnMove{Pawn::Cat, Direction::Right}, 0.1f}}};
    }
};

struct EmptyPolicy {
    float value;

    folly::coro::Task<Evaluation> operator()(Board const&, Turn,
                                             std::optional<PreviousPosition>) {
        co_return Evaluation{value, {}};
    }
};

// At a Red Turn::Second root, offers one action that ends the game at the turn boundary and one
// action that leaves the same eventual outcome one completed player turn farther away. Child
// evaluation waits briefly so two parallel samples deterministically expand both root actions;
// later samples then exercise the real get_best_edge ordering.
struct TerminalOrderingPolicy {
    Pawn pawn;
    float child_value;

    folly::coro::Task<Evaluation> operator()(Board const&, Turn turn,
                                             std::optional<PreviousPosition>) {
        if (turn == Turn{Player::Red, Turn::Second}) {
            co_return Evaluation{0.0f,
                                 {{PawnMove{pawn, Direction::Right}, 0.5f},
                                  {PawnMove{pawn, Direction::Up}, 0.5f}}};
        }
        co_await folly::coro::sleep(std::chrono::milliseconds{10});
        co_return Evaluation{child_value,
                             {{PawnMove{Pawn::Cat, Direction::Up}, 1.0f}}};
    }
};

TEST_CASE("Basic Initialization", "[MCTS]") {
    Board board{4, 4};
    MCTS mcts{SimplePolicy{1.0, 1.0, 1.0}, std::move(board)};

    CHECK(mcts.root_value() == 0.0);
    CHECK(mcts.root_samples() == 1);
    CHECK(mcts.wasted_inferences() == 0);
}

TEST_CASE("terminal-aware turn discount counts completed nonterminal turns only", "[MCTS]") {
    float const immediate_win = MCTS::backup_value(-1.0f, true, true);
    float const delayed_win = MCTS::backup_value(-1.0f, false, true);
    float const immediate_loss = MCTS::backup_value(1.0f, true, true);
    float const delayed_loss = MCTS::backup_value(1.0f, false, true);

    CHECK(MCTS::backup_value(1.0f, true, false) == 1.0f);
    CHECK(immediate_win == 1.0f);
    CHECK(delayed_win == MCTS::kTerminalTurnDiscount);
    CHECK(immediate_win > delayed_win);
    CHECK(immediate_loss == -1.0f);
    CHECK(delayed_loss == -MCTS::kTerminalTurnDiscount);
    CHECK(delayed_loss > immediate_loss);
    CHECK(MCTS::backup_value(0.0f, true, true) == 0.0f);
    CHECK(MCTS::backup_value(0.0f, false, true) == 0.0f);
}

TEST_CASE("a terminal revealed by an action-less second phase has zero turn distance", "[MCTS]") {
    Board board = standard_board(5, 5, {4, 2}, {0, 0}, {0, 4}, {4, 2});

    SECTION("the originating player wins") {
        MCTS mcts{EmptyPolicy{1.0f}, board,
                  {.noise_factor = 0.0f, .starting_turn = {Player::Red, Turn::Second}}};
        REQUIRE(mcts.root_disposition() == MCTS::RootDisposition::ShortTurnSecond);
        CHECK(folly::coro::blockingWait(mcts.sample(1)) == 1.0f);
    }

    SECTION("the originating player loses") {
        MCTS mcts{EmptyPolicy{-1.0f}, board,
                  {.noise_factor = 0.0f, .starting_turn = {Player::Blue, Turn::Second}}};
        REQUIRE(mcts.root_disposition() == MCTS::RootDisposition::ShortTurnSecond);
        CHECK(folly::coro::blockingWait(mcts.sample(1)) == -1.0f);
    }
}

TEST_CASE("search and PV prefer an immediate win to the same delayed win", "[MCTS]") {
    Board board = standard_board(5, 5, {3, 2}, {0, 0}, {0, 4}, {4, 2});
    MCTS mcts{TerminalOrderingPolicy{Pawn::Cat, -1.0f}, std::move(board),
              {.puct = 0.0f,
               .max_parallelism = 2,
               .noise_factor = 0.0f,
               .starting_turn = {Player::Red, Turn::Second}}};

    folly::coro::blockingWait(mcts.sample(2));
    NodeInfo before = mcts.root_info();
    REQUIRE(before.edges.size() == 2);
    REQUIRE(before.edges[0].num_samples == 1);
    REQUIRE(before.edges[1].num_samples == 1);

    folly::coro::blockingWait(mcts.sample(1));
    NodeInfo after = mcts.root_info();
    CHECK(after.edges[0].num_samples == 2);
    CHECK(after.edges[1].num_samples == 1);

    auto const pv = mcts.principal_variation(1, 0.0f, 1);
    REQUIRE(pv.size() == 1);
    CHECK(pv.front().action == Action{PawnMove{Pawn::Cat, Direction::Right}});
    CHECK(pv.front().q_value == 1.0f);
    CHECK(pv.front().gap == 1.0f - MCTS::kTerminalTurnDiscount);
}

TEST_CASE("search and PV prefer a delayed forced loss to an immediate loss", "[MCTS]") {
    Board board = standard_board(5, 5, {0, 0}, {3, 2}, {4, 2}, {0, 4});
    MCTS mcts{TerminalOrderingPolicy{Pawn::Mouse, 1.0f}, std::move(board),
              {.puct = 0.0f,
               .max_parallelism = 2,
               .noise_factor = 0.0f,
               .starting_turn = {Player::Red, Turn::Second}}};

    folly::coro::blockingWait(mcts.sample(2));
    NodeInfo before = mcts.root_info();
    REQUIRE(before.edges.size() == 2);
    REQUIRE(before.edges[0].num_samples == 1);
    REQUIRE(before.edges[1].num_samples == 1);

    folly::coro::blockingWait(mcts.sample(1));
    NodeInfo after = mcts.root_info();
    CHECK(after.edges[0].num_samples == 1);
    CHECK(after.edges[1].num_samples == 2);

    auto const pv = mcts.principal_variation(1, 0.0f, 1);
    REQUIRE(pv.size() == 1);
    CHECK(pv.front().action == Action{PawnMove{Pawn::Mouse, Direction::Up}});
    CHECK(pv.front().q_value == -MCTS::kTerminalTurnDiscount);
    CHECK(pv.front().gap == 1.0f - MCTS::kTerminalTurnDiscount);
}

TEST_CASE("root evidence keeps model values and priors before search noise", "[MCTS]") {
    MCTS::Options opts;
    opts.noise_factor = 0.5f;
    opts.seed = 20260831;
    MCTS mcts{TwoPriorPolicy{}, Board{4, 4}, opts};
    NodeInfo const root = mcts.root_info();

    CHECK(root.model_value == 0.25f);
    REQUIRE(root.edges.size() == 2);
    CHECK(root.edges[0].model_prior == 0.9f);
    CHECK(root.edges[1].model_prior == 0.1f);
    CHECK((root.edges[0].prior != root.edges[0].model_prior ||
           root.edges[1].prior != root.edges[1].model_prior));
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

TEST_CASE("first-action terminal shortcut is an isolated default-off diagnostic", "[MCTS]") {
    auto make_board = [] {
        return standard_board(5, 5, {2, 2}, {0, 0}, {4, 4}, {3, 2});
    };

    MCTS::Options off_opts;
    off_opts.noise_factor = 0;
    MCTS off{OnlyPolicy{Pawn::Cat, Direction::Right}, make_board(), off_opts};
    folly::coro::blockingWait(off.sample(2));
    CHECK(off.terminal_discoveries().empty());

    MCTS::Options on_opts = off_opts;
    on_opts.collect_search_diagnostics = true;
    on_opts.terminal_after_first_action_shortcut = true;
    MCTS on{OnlyPolicy{Pawn::Cat, Direction::Right}, make_board(), on_opts};
    folly::coro::blockingWait(on.sample(2));
    auto const terminals = on.terminal_discoveries();
    REQUIRE(terminals.size() == 1);
    CHECK(terminals.front().winner == Winner::Red);
    CHECK(terminals.front().depth == 1);
    CHECK(terminals.front().after_action == 1);
    CHECK(terminals.front().shortcut);
}

TEST_CASE("ordinary terminals collect nothing when diagnostics are disabled", "[MCTS]") {
    Board terminal = standard_board(5, 5, {3, 2}, {0, 0}, {4, 4}, {3, 2});
    REQUIRE(terminal.winner() == Winner::Red);
    MCTS mcts{SimplePolicy{1.0, 1.0, 1.0}, std::move(terminal)};
    folly::coro::blockingWait(mcts.sample(2));
    CHECK(mcts.terminal_discoveries().empty());
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


TEST_CASE("an action-less second phase is a legal short turn, not a loss", "[MCTS]") {
    Board board = standard_board(5, 5, {0, 0}, {4, 2}, {0, 4}, {4, 4});
    MCTS mcts{OnlyPolicy{Pawn::Mouse, Direction::Right}, std::move(board),
              {.starting_turn = {Player::Red, Turn::Second}}};

    CHECK(mcts.root_disposition() == MCTS::RootDisposition::ShortTurnSecond);
    CHECK(mcts.advance_short_turn());
    CHECK(mcts.current_turn() == Turn{Player::Blue, Turn::First});
    CHECK_FALSE(mcts.advance_short_turn());
}

TEST_CASE("an action-less first phase remains a decisive no-legal loss", "[MCTS]") {
    Board board = standard_board(5, 5, {0, 0}, {4, 2}, {0, 4}, {4, 4});
    MCTS mcts{OnlyPolicy{Pawn::Mouse, Direction::Right}, std::move(board)};
    CHECK(mcts.root_disposition() == MCTS::RootDisposition::NoLegalFirst);
    folly::coro::blockingWait(mcts.sample(1));
    CHECK(mcts.root_value() < 0.0f);
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
