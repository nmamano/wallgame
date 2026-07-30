/**
 * The losing-move fallback (board task b4c2b191).
 *
 * Two layers are tested separately: `naive::best_move` picking a move from a policy's priors, and
 * the BGS adapter deciding WHEN to use it.
 */

#include "bgs_session.hpp"
#include "bgs_test_support.hpp"
#include "naive_move.hpp"
#include "simple_policy.hpp"

#include <catch2/catch_test_macros.hpp>
#include <folly/experimental/coro/BlockingWait.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;
using namespace bgs;

// ============================================================================
// Test policies
// ============================================================================

/**
 * Records every call, so a test can assert what the second call was ASKED, not just what came back.
 *
 * The priors make the best action a CAT MOVE - specifically the last legal direction, so that
 * "returns the highest prior" and "returns the first edge" give different answers. A cat move
 * matters because only a pawn move can be undone, and the undo rule is what the recorded
 * `previous_position` exists to enforce.
 */
struct RecordingPolicy {
    struct Call {
        Board board;
        Turn turn;
        std::optional<PreviousPosition> previous_position;
    };

    std::shared_ptr<std::vector<Call>> calls = std::make_shared<std::vector<Call>>();

    folly::coro::Task<Evaluation> operator()(
        Board const& board,
        Turn turn,
        std::optional<PreviousPosition> previous_position) {

        calls->push_back(Call{board, turn, previous_position});

        std::vector<TreeEdge> edges;
        int rank = 0;
        for (auto dir : board.legal_directions(turn.player, Pawn::Cat)) {
            edges.emplace_back(PawnMove{Pawn::Cat, dir}, 0.1f + 0.001f * static_cast<float>(++rank));
        }
        for (Wall wall : board.legal_walls()) {
            edges.emplace_back(wall, 0.001f);
        }

        co_return Evaluation{0.0f, std::move(edges)};
    }
};

/**
 * A fixed value, and priors that prefer WALLS - deliberately the opposite of what SimplePolicy
 * prefers. That is what makes the adapter test discriminating: the search plays walls, the naive
 * policy walks the cat, so the two answers cannot be confused with each other.
 */
struct WallLovingPolicy {
    float value;

    folly::coro::Task<Evaluation> operator()(
        Board const& board,
        Turn turn,
        std::optional<PreviousPosition>) {

        std::vector<TreeEdge> edges;
        for (Wall wall : board.legal_walls()) {
            edges.emplace_back(wall, 0.9f);
        }
        for (auto dir : board.legal_directions(turn.player, Pawn::Cat)) {
            edges.emplace_back(PawnMove{Pawn::Cat, dir}, 0.01f);
        }

        co_return Evaluation{value, std::move(edges)};
    }
};

// ============================================================================
// naive::best_action / best_move
// ============================================================================

TEST_CASE("naive::best_action returns the policy's highest prior, and it is legal", "[naive]") {
    Board board{5, 5};
    RecordingPolicy policy;
    EvaluationFunction fn = policy;

    auto action = folly::coro::blockingWait(
        naive::best_action(fn, board, Turn{Player::Red, Turn::First}, std::nullopt));

    REQUIRE(action.has_value());
    CHECK(bgs_test::is_legal_action(board, Player::Red, *action));

    // The highest prior is the LAST cat direction, so this fails for an implementation that returns
    // the first edge rather than the best one.
    REQUIRE(policy.calls->size() == 1);
    Evaluation const fresh = folly::coro::blockingWait(
        RecordingPolicy{}(board, Turn{Player::Red, Turn::First}, std::nullopt));
    auto const expected = std::ranges::max_element(fresh.edges, {}, [](TreeEdge const& te) {
        return te.prior;
    });
    REQUIRE(expected != fresh.edges.end());
    CHECK(*action == expected->action);
}

TEST_CASE("naive::best_move asks the second question about the position after the first action",
          "[naive]") {
    Board board{5, 5};
    RecordingPolicy policy;
    EvaluationFunction fn = policy;
    Cell const cat_before = board.pawn_position(Player::Red, Pawn::Cat);

    auto move = folly::coro::blockingWait(
        naive::best_move(fn, board, Turn{Player::Red, Turn::First}, std::nullopt));
    REQUIRE(move.has_value());

    REQUIRE(policy.calls->size() == 2);
    auto const& first = (*policy.calls)[0];
    auto const& second = (*policy.calls)[1];

    // The first question is about the position as given, with nothing spent.
    CHECK(first.turn == Turn{Player::Red, Turn::First});
    CHECK_FALSE(first.previous_position.has_value());

    // The second is about the SAME turn, one action later...
    CHECK(second.turn == Turn{Player::Red, Turn::First}.next());

    // ...and it carries where the cat came FROM, which is the whole reason a policy can be trusted
    // not to undo the first action. Computing this AFTER applying the action - the easy mistake -
    // would record the destination instead and the undo would be allowed straight back.
    REQUIRE(second.previous_position.has_value());
    CHECK(second.previous_position->pawn == Pawn::Cat);
    CHECK(second.previous_position->cell == cat_before);

    // And the second position really is the one after the first action.
    CHECK(second.board.pawn_position(Player::Red, Pawn::Cat) != cat_before);

    // Both actions legal IN SEQUENCE, checked against the Board rather than the policy's own list.
    CHECK(bgs_test::is_legal_action(board, Player::Red, move->first));
    Board after_first = board;
    after_first.do_action(Player::Red, move->first);
    CHECK(bgs_test::is_legal_action(after_first, Player::Red, move->second));
}

TEST_CASE("naive::best_move with SimplePolicy walks the cat toward its goal", "[naive]") {
    // This is what "naive" is supposed to MEAN. A move that is merely legal would satisfy the tests
    // above while being useless as a graceful-loss policy.
    Board board{5, 5};
    EvaluationFunction fn = SimplePolicy{0.3f, 1.5f, 0.75f};

    int const distance_before =
        board.distance(board.position(Player::Red), board.goal(Player::Red));

    auto move = folly::coro::blockingWait(
        naive::best_move(fn, board, Turn{Player::Red, Turn::First}, std::nullopt));
    REQUIRE(move.has_value());

    Board after = board;
    after.do_action(Player::Red, move->first);
    CHECK(bgs_test::is_legal_action(after, Player::Red, move->second));
    after.do_action(Player::Red, move->second);

    int const distance_after = after.distance(after.position(Player::Red), after.goal(Player::Red));
    CHECK(distance_after < distance_before);
}

// ============================================================================
// The adapter decision
// ============================================================================

namespace {

// One evaluate against a fresh session. The bgsId is a parameter because the session seed is derived
// from it, so two runs that are meant to be compared must use the SAME id.
json evaluate_once(EvaluationFunction policy, BgsEngineConfig config, std::string const& bgs_id) {
    SessionManager manager(std::move(policy), config);
    auto const bgs_config = bgs_test::make_standard_config(6, 6);
    auto [success, error] = manager.create_session(bgs_id, "bot", bgs_config);
    REQUIRE(success);
    return folly::coro::blockingWait(handle_evaluate_position(manager, config, bgs_id, 0));
}

}  // namespace

TEST_CASE("the losing fallback fires only below the threshold, and changes nothing above it",
          "[naive]") {
    // ONE sample, which is a supported configuration since board task 945fe1ef, and which makes the
    // root value exactly the policy's constant: the root is created with it, and the single sample
    // returns the child's copy of the same number.
    BgsEngineConfig searching;
    searching.samples_per_move = 1;
    REQUIRE_FALSE(searching.losing_fallback_eval.has_value());  // the shipped default: off

    BgsEngineConfig falling_back = searching;
    falling_back.losing_fallback_eval = -0.9f;  // production's PuzzleBot setting

    json const lost_search = evaluate_once(WallLovingPolicy{-0.95f}, searching, "session_lost");
    json const lost_naive = evaluate_once(WallLovingPolicy{-0.95f}, falling_back, "session_lost");
    json const unclear_search = evaluate_once(WallLovingPolicy{-0.5f}, searching, "session_unclear");
    json const unclear_naive =
        evaluate_once(WallLovingPolicy{-0.5f}, falling_back, "session_unclear");

    REQUIRE(lost_search["success"] == true);
    REQUIRE(lost_naive["success"] == true);
    REQUIRE(unclear_search["success"] == true);
    REQUIRE(unclear_naive["success"] == true);

    // Below the threshold the answer CHANGES, and changes in the expected direction: the policy loves
    // walls so the search plays one, while the naive policy walks the cat ("C..." notation). A test
    // where both sources happened to agree would prove nothing at all.
    CHECK(lost_naive["bestMove"] != lost_search["bestMove"]);
    CHECK(lost_naive["bestMove"].get<std::string>().starts_with("C"));
    CHECK_FALSE(lost_search["bestMove"].get<std::string>().starts_with("C"));

    // Above the threshold the response must be IDENTICAL to the one with the fallback off - not
    // merely also legal. Same policy, same bgsId, so the seed and the search are the same too.
    CHECK(unclear_naive == unclear_search);
}

TEST_CASE("the losing fallback is OFF by default even at a CERTAIN loss", "[naive]") {
    // The boundary that made an earlier version of this feature wrong. It defaulted the threshold to
    // -1.0 and called that "effectively off", but `MCTS::root_value()` reaches exactly -1.0 whenever
    // every sample ends in a loss - so with `<=` the fallback fired, and Superhuman and Easy Bot would
    // have played the naive policy in precisely the positions where the config guard and the docs both
    // claimed the feature was disabled. Enablement is a separate state now, and this pins it: at a
    // value of -1.0, the most extreme input there is, disabled must still mean disabled.
    BgsEngineConfig disabled;
    disabled.samples_per_move = 1;
    REQUIRE_FALSE(disabled.losing_fallback_eval.has_value());

    BgsEngineConfig enabled = disabled;
    enabled.losing_fallback_eval = -1.0f;  // the most permissive threshold the flag allows

    json const search = evaluate_once(WallLovingPolicy{-1.0f}, disabled, "session_certain");
    json const naive = evaluate_once(WallLovingPolicy{-1.0f}, enabled, "session_certain");

    REQUIRE(search["success"] == true);
    REQUIRE(naive["success"] == true);

    // Disabled: the search's own answer, which for this wall-loving policy is a wall.
    CHECK_FALSE(search["bestMove"].get<std::string>().starts_with("C"));
    // Explicitly enabled at the same value: the naive walk.
    CHECK(naive["bestMove"].get<std::string>().starts_with("C"));
    CHECK(naive["bestMove"] != search["bestMove"]);
}

TEST_CASE("the losing fallback leaves a turn that has already spent an action to the search",
          "[naive]") {
    // Deliberate scope limit, documented in handle_evaluate_position: the naive policy needs to be
    // told which cell the pawn came from, and that is not recoverable from the tree for a turn
    // already in progress. Such a request can only be the FIRST evaluate of a custom setup which
    // begins mid-turn.
    // A SPENT WALL, not a spent pawn move, on purpose: it is the shortest thing that makes the turn
    // a Second-action one, and it avoids depending on the pawn `source` coordinate convention, which
    // this test has no reason to pin.
    auto config = bgs_test::make_standard_config(6, 6);
    config["variant"] = "custom-setup-standard";
    config["initialState"]["turn"] = {
        {"playerId", 1},
        {"actionsTaken", json::array({json{{"type", "wall"}}})}};

    BgsEngineConfig falling_back;
    falling_back.samples_per_move = 1;
    falling_back.losing_fallback_eval = -0.9f;
    BgsEngineConfig searching = falling_back;
    searching.losing_fallback_eval.reset();

    auto run = [&](BgsEngineConfig const& cfg) {
        SessionManager manager(WallLovingPolicy{-0.95f}, cfg);
        auto [success, error] = manager.create_session("session_second", "bot", config);
        REQUIRE(success);
        return folly::coro::blockingWait(
            handle_evaluate_position(manager, cfg, "session_second", 0));
    };

    json const with_fallback = run(falling_back);
    json const without = run(searching);

    REQUIRE(with_fallback["success"] == true);
    CHECK(with_fallback == without);
}
