#include "analysis_tool.hpp"

#include <folly/experimental/coro/BlockingWait.h>
#include <gflags/gflags.h>

#include <atomic>
#include <chrono>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

DECLARE_int32(analyze_chunk);
DECLARE_int32(analyze_max_parallelism);
DECLARE_int32(analyze_moves);
DECLARE_int32(analyze_pv_actions);
DECLARE_int32(analyze_pv_min_visits);
DECLARE_int32(analyze_samples);
DECLARE_uint32(seed);

namespace {

Board make_short_turn_board() {
    return Board{5,
                 5,
                 Variant::Standard,
                 {{Player::Red, Pawn::Cat, {3, 2}},
                  {Player::Red, Pawn::Mouse, {0, 0}},
                  {Player::Blue, Pawn::Cat, {3, 4}},
                  {Player::Blue, Pawn::Mouse, {0, 4}}}};
}

EvaluationFunction short_turn_policy() {
    return [](Board const& board, Turn turn,
              std::optional<PreviousPosition>) -> folly::coro::Task<Evaluation> {
        std::vector<TreeEdge> edges;
        if (turn.player == Player::Red && turn.action == Turn::First &&
            board.pawn_position(Player::Red, Pawn::Cat) == Cell{3, 2}) {
            edges.emplace_back(PawnMove{Pawn::Cat, Direction::Right}, 1.0f);
        } else if (turn.player == Player::Blue && turn.action == Turn::First &&
                   board.pawn_position(Player::Red, Pawn::Cat) == Cell{4, 2}) {
            edges.emplace_back(PawnMove{Pawn::Cat, Direction::Left}, 1.0f);
        }
        co_return Evaluation{0.0f, std::move(edges)};
    };
}

void configure_short_analysis() {
    FLAGS_analyze_chunk = 1;
    FLAGS_analyze_max_parallelism = 1;
    FLAGS_analyze_moves = 2;
    FLAGS_analyze_pv_actions = 0;
    FLAGS_analyze_pv_min_visits = 1;
    FLAGS_analyze_samples = 1;
    FLAGS_seed = 42;
}

std::vector<nlohmann::json> parse_jsonl(std::string const& text) {
    std::vector<nlohmann::json> records;
    std::istringstream lines{text};
    for (std::string line; std::getline(lines, line);) {
        if (!line.empty()) {
            records.push_back(nlohmann::json::parse(line));
        }
    }
    return records;
}

}  // namespace

TEST_CASE("analyze_game advances after a legal one-action turn", "[Analysis Tool]") {
    configure_short_analysis();
    EvaluationFunction const policy = short_turn_policy();
    std::ostringstream out;

    folly::coro::blockingWait(analyze_game(policy, policy, false, make_short_turn_board(), out));

    auto const records = parse_jsonl(out.str());
    REQUIRE(records.size() == 2);
    CHECK(records[0].at("player") == "red");
    CHECK(records[0].at("cat") == nlohmann::json{{"col", 3}, {"row", 2}});
    CHECK(records[1].at("player") == "blue");
    // This edge exists only when Red's cat reached the exact destination [row 2, column 4].
    REQUIRE(records[1].at("edges").size() == 1);
    CHECK(records[1].at("edges")[0].at("action") == "Cat:Left");
}

TEST_CASE("analyze_position emits a one-action best turn", "[Analysis Tool]") {
    configure_short_analysis();
    AnalysisTask const task{.board = make_short_turn_board(),
                            .turn = {Player::Red, Turn::First},
                            .game_id = "short-turn",
                            .move_index = 0,
                            .game_rows = 5,
                            .game_columns = 5};
    std::ostringstream out;
    std::mutex out_mutex;
    std::atomic<int> completed{0};

    folly::coro::blockingWait(analyze_position(short_turn_policy(), task, 0, out, out_mutex,
                                               completed, 1,
                                               std::chrono::steady_clock::now()));

    auto const records = parse_jsonl(out.str());
    REQUIRE(records.size() == 1);
    REQUIRE(records[0].contains("best_turn"));
    REQUIRE(records[0].at("best_turn").size() == 1);
    CHECK(records[0].at("best_turn")[0] == "Cat:Right");
}
