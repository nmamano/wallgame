#include "play.hpp"

#include <folly/executors/CPUThreadPoolExecutor.h>
#include <folly/experimental/coro/BlockingWait.h>

#include <catch2/catch_test_macros.hpp>
#include <optional>
#include <map>
#include <vector>

#include "simple_policy.hpp"
#include "state_conversions.hpp"

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

// Offers one action and one only: walk your own mouse left. That makes a self-play game fully
// determined, so a turn can be pointed straight at the cell where a capture would be judged.
struct MouseLeftPolicy {
    folly::coro::Task<Evaluation> operator()(Board const& board, Turn turn,
                                             std::optional<PreviousPosition>) {
        std::vector<TreeEdge> edges;
        Cell const mouse = board.pawn_position(turn.player, Pawn::Mouse);
        if (!board.is_blocked(Wall{mouse, Direction::Left})) {
            edges.emplace_back(PawnMove{Pawn::Mouse, Direction::Left}, 1.0);
        }
        co_return Evaluation{0, std::move(edges)};
    };
};

}  // namespace

TEST_CASE("training_play uses each materialized start position and preserves its provenance",
          "[TrainingRecords][MaterializedStart]") {
    Board standard{12, 10, Variant::Standard,
                   {{Player::Red, Pawn::Cat, {2, 1}},
                    {Player::Red, Pawn::Mouse, {1, 3}},
                    {Player::Blue, Pawn::Cat, {9, 8}},
                    {Player::Blue, Pawn::Mouse, {10, 6}}}};
    standard.place_wall(Player::Red, Wall{Cell{4, 4}, Wall::Right});
    Board animal{12, 10, Variant::AnimalCycle,
                 {{Player::Red, Pawn::Cat, {1, 2}},
                  {Player::Red, Pawn::Elephant, {6, 7}},
                  {Player::Blue, Pawn::Mouse, {7, 1}},
                  {Player::Blue, Pawn::Dog, {2, 6}}}};
    animal.place_wall(Player::Red, Wall{Cell{5, 3}, Wall::Down});

    std::map<int, TrainingGame> completed;
    TrainingPlayOptions opts{
        .model1 = SimplePolicy{1.0, 1.5, 0.75},
        .model2 = SimplePolicy{1.0, 1.5, 0.75},
        .samples = 1,
        .max_parallel_games = 1,
        .max_parallel_samples = 1,
        .move_limit = 1,
        .temperature = 1,
        .start_game = 41,
        .start_positions = {
            {.board = standard,
             .turn = {Player::Red, Turn::First},
             .previous_position = std::nullopt,
             .record_json = R"({"gameIndex":41,"variant":"standard"})"},
            {.board = animal,
             .turn = {Player::Blue, Turn::First},
             .previous_position = std::nullopt,
             .record_json = R"({"gameIndex":42,"variant":"animal-cycle"})"},
        },
        .on_complete = [&](TrainingGame const& game, int index) { completed.emplace(index, game); },
        .seed = 17,
    };
    folly::CPUThreadPoolExecutor pool(2);
    folly::coro::blockingWait(training_play(Board{12, 10}, 2, opts).scheduleOn(&pool));

    REQUIRE(completed.size() == 2);
    REQUIRE(!completed.at(41).decisions.empty());
    REQUIRE(!completed.at(42).decisions.empty());
    CHECK(completed.at(41).decisions.front().node.board == standard);
    CHECK(completed.at(42).decisions.front().node.board == animal);
    CHECK(completed.at(41).decisions.front().node.turn.player == Player::Red);
    CHECK(completed.at(42).decisions.front().node.turn.player == Player::Blue);
    CHECK(completed.at(41).initial_state_record.find("standard") != std::string::npos);
    CHECK(completed.at(42).initial_state_record.find("animal-cycle") != std::string::npos);
}

TEST_CASE("Animal Cycle self-play emits deterministic replayable universal records",
          "[TrainingRecords][AnimalCycle]") {
    std::vector<Board> const starts = {
        Board{5, 5, Variant::AnimalCycle},
        Board{8, 8, Variant::AnimalCycle,
              {{Player::Red, Pawn::Cat, {1, 1}},
               {Player::Red, Pawn::Elephant, {6, 6}},
               {Player::Blue, Pawn::Mouse, {6, 1}},
               {Player::Blue, Pawn::Dog, {1, 6}}}},
        Board{12, 10, Variant::AnimalCycle,
              {{Player::Red, Pawn::Cat, {2, 1}},
               {Player::Red, Pawn::Elephant, {9, 8}},
               {Player::Blue, Pawn::Mouse, {9, 1}},
               {Player::Blue, Pawn::Dog, {2, 8}}}},
    };

    for (Board const& start : starts) {
        auto run = [&]() {
            std::optional<TrainingGame> completed;
            TrainingPlayOptions opts{
                .model1 = SimplePolicy{1.0, 1.5, 0.75},
                .model2 = SimplePolicy{1.0, 1.5, 0.75},
                .samples = 1,
                .max_parallel_games = 1,
                .max_parallel_samples = 1,
                .move_limit = 2,
                .temperature = 1,
                .on_complete = [&](TrainingGame const& game, int) { completed = game; },
                .seed = 20260815,
            };
            folly::CPUThreadPoolExecutor pool(2);
            folly::coro::blockingWait(training_play(start, 1, opts).scheduleOn(&pool));
            REQUIRE(completed);
            return *completed;
        };

        TrainingGame first = run();
        TrainingGame second = run();
        REQUIRE(first.decisions.size() == second.decisions.size());
        CHECK(first.end_reason == TrainingEndReason::MoveLimit);
        CHECK(first.actual_winner == Winner::Undecided);

        Board replay = start;
        for (std::size_t i = 0; i < first.decisions.size(); ++i) {
            auto const& decision = first.decisions[i];
            CHECK(decision.node.board == replay);
            CHECK(decision.chosen_action == second.decisions[i].chosen_action);

            auto const mask = legal_policy_mask(decision.node);
            auto const chosen = universal_policy_index(
                decision.node.board, decision.node.turn, decision.chosen_action);
            REQUIRE(chosen < mask.size());
            CHECK(mask[chosen]);

            auto const input = convert_to_model_input(decision.node.board, decision.node.turn);
            std::size_t const board_size = replay.columns() * replay.rows();
            CHECK(std::all_of(input.begin() + 10 * board_size,
                              input.begin() + 11 * board_size,
                              [](float value) { return value == 1.0f; }));
            CHECK(std::all_of(input.begin() + 11 * board_size, input.end(),
                              [](float value) { return value == 0.0f; }));

            float const score = first.final_board.score_for(Player::Red);
            auto const label = convert_to_model_output(decision.node, score, 1.0f);
            CHECK(label.value == (decision.node.turn.player == Player::Red ? score : -score));

            replay.do_action(decision.node.turn.player, decision.chosen_action);
        }
        CHECK(replay == first.final_board);
    }
}

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
            [&](TrainingGame const& game, int) {
                ++calls;
                for (auto const& decision : game.decisions) captured.push_back(decision.node);
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

// A mouse walking PAST a cat is legal, and self-play has to read that as a turn in progress rather
// than a finished game. Judging the bare position after every single action ended the game at the
// midpoint and wrote a training record labelled with a win nobody scored (board task 8911a6d5).
TEST_CASE("training_play does not end a game at the midpoint of a walk-past",
          "[TrainingRecords]") {
    // Red's mouse sits one step to the right of Blue's cat, and the only action either side has is
    // to walk its own mouse left - so Red's whole turn is: onto the cat, then past it.
    Board board{6,
                6,
                Variant::Standard,
                {{Player::Red, Pawn::Cat, {0, 0}},
                 {Player::Red, Pawn::Mouse, {4, 2}},
                 {Player::Blue, Pawn::Cat, {3, 2}},
                 {Player::Blue, Pawn::Mouse, {5, 5}}}};

    int calls = 0;
    std::vector<NodeInfo> captured;
    std::optional<Board> final_board;

    TrainingPlayOptions opts{
        .model1 = MouseLeftPolicy{},
        .model2 = MouseLeftPolicy{},
        .samples = 4,
        .max_parallel_games = 1,
        .max_parallel_samples = 1,
        .move_limit = 1,
        .temperature = 1,
        .on_complete =
            [&](TrainingGame const& game, int) {
                ++calls;
                for (auto const& decision : game.decisions) captured.push_back(decision.node);
                final_board = game.final_board;
            },
        .seed = 7,
    };

    folly::CPUThreadPoolExecutor pool(2);
    folly::coro::blockingWait(training_play(board, 1, opts).scheduleOn(&pool));

    REQUIRE(calls == 1);

    // Two actions each for Red and Blue, and then the move limit. Before the fix the game ended
    // after Red's FIRST action: one record, and Blue credited with a capture it never completed.
    CHECK(captured.size() == 4);

    REQUIRE(final_board);
    CHECK(final_board->mouse(Player::Red) == Cell{2, 2});
    CHECK(final_board->winner() == Winner::Undecided);
}
