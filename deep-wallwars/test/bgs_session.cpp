#include "bgs_session.hpp"
#include "bgs_test_support.hpp"
#include "engine_adapter.hpp"
#include "mcts.hpp"
#include "simple_policy.hpp"
#include "state_conversions.hpp"

#include <catch2/catch_test_macros.hpp>
#include <folly/experimental/coro/BlockingWait.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <ranges>

using json = nlohmann::json;
using namespace bgs;
using namespace engine_adapter;

// ============================================================================
// Test Policy - Simple deterministic policy for testing
// ============================================================================

struct TestPolicy {
    folly::coro::Task<Evaluation> operator()(
        Board const& board,
        Turn turn,
        std::optional<PreviousPosition>) {

        // Get legal actions and return them all with equal prior
        std::vector<TreeEdge> edges;

        // Add pawn moves (PawnMove takes direction, not target cell)
        for (auto dir : board.legal_directions(turn.player, Pawn::Cat)) {
            edges.emplace_back(PawnMove{Pawn::Cat, dir}, 0.5f);
        }
        for (auto dir : board.legal_directions(turn.player, Pawn::Mouse)) {
            edges.emplace_back(PawnMove{Pawn::Mouse, dir}, 0.3f);
        }

        // Add a few walls
        auto walls = board.legal_walls();
        for (size_t i = 0; i < std::min(walls.size(), size_t{5}); ++i) {
            edges.emplace_back(walls[i], 0.1f);
        }

        co_return Evaluation{0.0f, std::move(edges)};
    }
};

/**
 * A policy whose priors are all DISTINCT, with the highest one deliberately last.
 *
 * TestPolicy gives every cat move the same 0.5, so a test built on it cannot tell
 * "returns the highest-prior action" apart from "returns the first edge in the
 * list" - and picking the first edge is exactly the mistake the prior fallback
 * could make. Priors ascend along the action list here, so the two answers differ.
 *
 * The value is constant, which keeps the fallback tests about priors only.
 */
struct RankedPolicy {
    folly::coro::Task<Evaluation> operator()(
        Board const& board,
        Turn turn,
        std::optional<PreviousPosition>) {

        std::vector<TreeEdge> edges;
        int rank = 0;
        auto next_prior = [&rank] { return 0.001f * static_cast<float>(++rank); };

        for (auto dir : board.legal_directions(turn.player, Pawn::Cat)) {
            edges.emplace_back(PawnMove{Pawn::Cat, dir}, next_prior());
        }
        for (auto dir : board.legal_directions(turn.player, Pawn::Mouse)) {
            edges.emplace_back(PawnMove{Pawn::Mouse, dir}, next_prior());
        }
        for (Wall wall : board.legal_walls()) {
            edges.emplace_back(wall, next_prior());
        }

        co_return Evaluation{0.0f, std::move(edges)};
    }
};

// Options with the root Dirichlet noise turned OFF. Needed wherever a test states
// what the highest-prior action is: add_root_noise() rewrites the root priors, and
// the test cannot see the perturbed values, so with noise on there is nothing to
// compare against. This is also the setting Easy Bot runs in production.
static MCTS::Options noiseless_opts() {
    MCTS::Options opts;
    opts.noise_factor = 0;
    return opts;
}

// Highest-prior action the policy itself reports for `board`. An INDEPENDENT
// statement of what the fallback should return - it asks the policy directly
// rather than reading anything MCTS computed.
template <typename Policy>
static Action policy_best_action(Policy policy, Board const& board, Turn turn) {
    Evaluation eval = folly::coro::blockingWait(policy(board, turn, std::nullopt));
    REQUIRE_FALSE(eval.edges.empty());
    return std::ranges::max_element(eval.edges, {}, [](TreeEdge const& te) {
               return te.prior;
           })->action;
}

// `is_legal_action` and `make_standard_config` live in test/bgs_test_support.hpp, because
// test/naive_move.cpp needs the same two and a second copy of either would drift.
using bgs_test::is_legal_action;
using bgs_test::make_standard_config;

static json make_classic_config(int width = 8, int height = 8) {
    json config;
    config["variant"] = "classic";
    config["boardWidth"] = width;
    config["boardHeight"] = height;
    config["initialState"]["pawns"]["p1"]["cat"] = {height - 1, 0};
    config["initialState"]["pawns"]["p1"]["home"] = {height - 1, width - 1};
    config["initialState"]["pawns"]["p2"]["cat"] = {0, width - 1};
    config["initialState"]["pawns"]["p2"]["home"] = {0, 0};
    config["initialState"]["walls"] = json::array();
    return config;
}

// ============================================================================
// Tests: validate_bgs_config
// ============================================================================

TEST_CASE("validate_bgs_config - Valid standard config", "[BGS Validation]") {
    auto config = make_standard_config(6, 6);
    auto result = validate_bgs_config(config, 8, 8);
    CHECK(result.valid);
    CHECK(result.error_message.empty());
}

TEST_CASE("validate_bgs_config - Valid classic config", "[BGS Validation]") {
    auto config = make_classic_config(5, 5);
    auto result = validate_bgs_config(config, 8, 8);
    CHECK(result.valid);
}

TEST_CASE("validate_bgs_config - Board too large", "[BGS Validation]") {
    auto config = make_standard_config(10, 10);
    auto result = validate_bgs_config(config, 8, 8);
    CHECK_FALSE(result.valid);
    CHECK(result.error_message.find("exceed") != std::string::npos);
}

TEST_CASE("validate_bgs_config - Board too small", "[BGS Validation]") {
    auto config = make_standard_config(3, 3);
    auto result = validate_bgs_config(config, 8, 8);
    CHECK_FALSE(result.valid);
    CHECK(result.error_message.find("4x4") != std::string::npos);
}

TEST_CASE("validate_bgs_config - Unsupported variant", "[BGS Validation]") {
    auto config = make_standard_config();
    config["variant"] = "survival";
    auto result = validate_bgs_config(config, 8, 8);
    CHECK_FALSE(result.valid);
    CHECK(result.error_message.find("survival") != std::string::npos);
}

TEST_CASE("validate_bgs_config - actionsTaken is one current-turn seed", "[BGS Validation]") {
    auto config = make_standard_config();
    config["initialState"]["turn"] = {
        {"playerId", 1},
        {"actionsTaken",
         json::array({
             json{{"type", "wall"},
                  {"target", {2, 2}},
                  {"wallOrientation", "vertical"}},
             json{{"type", "wall"},
                  {"target", {3, 3}},
                  {"wallOrientation", "horizontal"}},
         })}};
    auto too_many = validate_bgs_config(config, 8, 8);
    CHECK_FALSE(too_many.valid);
    CHECK(too_many.error_message.find("zero or one") != std::string::npos);

    config["initialState"]["turn"]["actionsTaken"] = json::array({
        json{{"type", "cat"}, {"target", {6, 0}}},
    });
    auto missing_source = validate_bgs_config(config, 8, 8);
    CHECK_FALSE(missing_source.valid);
    CHECK(missing_source.error_message.find("source and target") != std::string::npos);
}

// ============================================================================
// Tests: convert_bgs_config_to_board
// ============================================================================

TEST_CASE("convert_bgs_config_to_board - Standard variant", "[BGS Config]") {
    auto config = make_standard_config(6, 6);
    auto [board, turn, padding] = convert_bgs_config_to_board(config, 8, 8);

    CHECK(turn.player == Player::Red);
    CHECK(turn.action == Turn::First);
    CHECK(board.rows() == 8);  // Model dimensions
    CHECK(board.columns() == 8);
    CHECK(padding.game_rows == 6);
    CHECK(padding.game_columns == 6);
}

TEST_CASE("convert_bgs_config_to_board - Classic variant", "[BGS Config]") {
    auto config = make_classic_config(5, 5);
    auto [board, turn, padding] = convert_bgs_config_to_board(config, 8, 8);

    CHECK(turn.player == Player::Red);
    CHECK(board.variant() == Variant::Classic);
    // Classic embeds at bottom, centered
    CHECK(padding.row_offset == 3);  // 8 - 5 = 3
}

TEST_CASE("BGS rules aliases preserve one explicit Classic position", "[BGS Config]") {
    // Puzzle 8 has both homes on the center cell. This is the smallest fixture
    // that proves an ordinary Classic request does not replace supplied homes
    // with model-frame corners.
    auto ordinary = make_classic_config(5, 5);
    ordinary["initialState"]["pawns"]["p1"]["cat"] = {4, 1};
    ordinary["initialState"]["pawns"]["p2"]["cat"] = {0, 3};
    ordinary["initialState"]["pawns"]["p1"]["home"] = {2, 2};
    ordinary["initialState"]["pawns"]["p2"]["home"] = {2, 2};
    ordinary["initialState"]["turn"] = {
        {"playerId", 1}, {"actionsTaken", json::array()}};

    auto legacy_authored = ordinary;
    legacy_authored["variant"] = "custom-setup-classic";

    auto const [ordinary_board, ordinary_turn, ordinary_padding] =
        convert_bgs_config_to_board(ordinary, 8, 8);
    auto const [legacy_board, legacy_turn, legacy_padding] =
        convert_bgs_config_to_board(legacy_authored, 8, 8);

    CHECK(ordinary_board == legacy_board);
    CHECK(ordinary_turn == legacy_turn);
    CHECK(ordinary_padding.variant == legacy_padding.variant);
    CHECK(convert_to_model_input(ordinary_board, ordinary_turn) ==
          convert_to_model_input(legacy_board, legacy_turn));
    CHECK(ordinary_board.legal_actions(ordinary_turn.player) ==
          legacy_board.legal_actions(legacy_turn.player));

    Cell const model_center = transform_to_model(Cell{2, 2}, ordinary_padding);
    CHECK(ordinary_board.goal(Player::Red) == model_center);
    CHECK(ordinary_board.goal(Player::Blue) == model_center);
}

TEST_CASE("BGS rules aliases preserve one explicit Standard position", "[BGS Config]") {
    // This non-opening state represents both a Random Start sent under the
    // ordinary rules name and a historical authored setup sent under a legacy
    // name. Input provenance must not change the engine position.
    auto ordinary = make_standard_config(6, 6);
    ordinary["initialState"]["pawns"]["p1"]["cat"] = {4, 2};
    ordinary["initialState"]["pawns"]["p1"]["mouse"] = {5, 4};
    ordinary["initialState"]["pawns"]["p2"]["cat"] = {1, 3};
    ordinary["initialState"]["pawns"]["p2"]["mouse"] = {0, 1};
    ordinary["initialState"]["walls"] = json::array({
        {{"cell", {3, 3}}, {"orientation", "vertical"}},
    });
    ordinary["initialState"]["turn"] = {
        {"playerId", 2},
        {"actionsTaken", json::array({
             json{{"type", "cat"}, {"source", {1, 2}}, {"target", {1, 3}}},
         })}};

    auto legacy_authored = ordinary;
    legacy_authored["variant"] = "custom-setup-standard";
    auto legacy_random = ordinary;
    legacy_random["variant"] = "freestyle";

    auto const [ordinary_board, ordinary_turn, ordinary_padding] =
        convert_bgs_config_to_board(ordinary, 8, 8);
    for (json const* equivalent : {&legacy_authored, &legacy_random}) {
        auto const [alias_board, alias_turn, alias_padding] =
            convert_bgs_config_to_board(*equivalent, 8, 8);
        CHECK(alias_board == ordinary_board);
        CHECK(alias_turn == ordinary_turn);
        CHECK(alias_padding.variant == ordinary_padding.variant);
        CHECK(convert_to_model_input(alias_board, alias_turn) ==
              convert_to_model_input(ordinary_board, ordinary_turn));
        CHECK(alias_board.legal_actions(alias_turn.player) ==
              ordinary_board.legal_actions(ordinary_turn.player));
    }
    CHECK(ordinary_turn == Turn{Player::Blue, Turn::Second});
}

TEST_CASE("BGS mid-turn seed preserves no-immediate-return across aliases", "[BGS Session]") {
    auto ordinary = make_standard_config(6, 6);
    ordinary["initialState"]["pawns"]["p2"]["cat"] = {1, 3};
    ordinary["initialState"]["turn"] = {
        {"playerId", 2},
        {"actionsTaken", json::array({
             json{{"type", "cat"}, {"source", {1, 2}}, {"target", {1, 3}}},
         })}};
    auto legacy = ordinary;
    legacy["variant"] = "custom-setup-standard";

    auto root_actions = [](json const& config, std::string const& session_id) {
        BgsEngineConfig engine_config;
        engine_config.model_rows = 8;
        engine_config.model_columns = 8;
        SessionManager manager(SimplePolicy{1.0f, 1.0f, 1.0f}, engine_config);
        auto const [created, error] = manager.create_session(session_id, "bot", config);
        INFO(error);
        REQUIRE(created);

        std::vector<Action> actions;
        NodeInfo const root = manager.get_session(session_id)->mcts->root_info();
        for (EdgeInfo const& edge : root.edges) {
            actions.push_back(edge.action);
        }
        return actions;
    };

    auto const ordinary_actions = root_actions(ordinary, "ordinary_midturn");
    auto const legacy_actions = root_actions(legacy, "legacy_midturn");
    CHECK(ordinary_actions == legacy_actions);
    CHECK(std::ranges::find(ordinary_actions,
                            Action{PawnMove{Pawn::Cat, Direction::Left}}) ==
          ordinary_actions.end());
}

TEST_CASE("BGS aliases preserve fixed-seed evaluation and move", "[BGS Session]") {
    auto ordinary = make_standard_config(6, 6);
    ordinary["initialState"]["pawns"]["p1"]["cat"] = {4, 2};
    ordinary["initialState"]["pawns"]["p1"]["mouse"] = {5, 4};
    ordinary["initialState"]["pawns"]["p2"]["cat"] = {1, 3};
    ordinary["initialState"]["pawns"]["p2"]["mouse"] = {0, 1};
    ordinary["initialState"]["turn"] = {
        {"playerId", 2},
        {"actionsTaken", json::array({
             json{{"type", "cat"}, {"source", {1, 2}}, {"target", {1, 3}}},
         })}};
    auto legacy = ordinary;
    legacy["variant"] = "custom-setup-standard";

    auto evaluate = [](json const& config) {
        BgsEngineConfig engine_config;
        engine_config.model_rows = 8;
        engine_config.model_columns = 8;
        engine_config.samples_per_move = 8;
        engine_config.root_noise_factor = 0.0f;
        SessionManager manager(RankedPolicy{}, engine_config);
        auto const [created, error] = manager.create_session("same_seed", "bot", config);
        INFO(error);
        REQUIRE(created);
        return folly::coro::blockingWait(
            handle_evaluate_position(manager, engine_config, "same_seed", 0));
    };

    json const ordinary_response = evaluate(ordinary);
    json const legacy_response = evaluate(legacy);
    REQUIRE(ordinary_response["success"] == true);
    CHECK(legacy_response == ordinary_response);
}

TEST_CASE("convert_bgs_config_to_board - No padding needed", "[BGS Config]") {
    auto config = make_standard_config(8, 8);
    auto [board, turn, padding] = convert_bgs_config_to_board(config, 8, 8);

    CHECK_FALSE(padding.needs_padding());
    CHECK(padding.row_offset == 0);
    CHECK(padding.col_offset == 0);
}

TEST_CASE("convert_bgs_config_to_board - With initial walls", "[BGS Config]") {
    auto config = make_standard_config(6, 6);
    config["initialState"]["walls"] = json::array({
        {{"cell", {2, 2}}, {"orientation", "vertical"}, {"playerId", 1}},
        {{"cell", {3, 3}}, {"orientation", "horizontal"}, {"playerId", 2}}
    });

    auto [board, turn, padding] = convert_bgs_config_to_board(config, 8, 8);

    // Board should have walls placed
    // The exact wall positions depend on padding transformation
    CHECK(board.rows() == 8);
}

// ============================================================================
// Tests: parse_move_notation
// ============================================================================

TEST_CASE("parse_move_notation - Cat and mouse move", "[BGS Move Parsing]") {
    auto config = make_standard_config(8, 8);
    auto [board, turn, padding] = convert_bgs_config_to_board(config, 8, 8);

    // P1 cat starts at a1 [7,0], mouse at h1 [7,7] (standard 8x8 setup).
    // Internal rows grow downward and official rows grow upward, so
    // cell_notation([7,0], 8) is "a1" - NOT "a8", which is what these cases
    // claimed until 2026-07-30 and why they fed the parser a cell six rows away.
    // Valid adjacent moves: cat to a2 (up), mouse to h2 (up).
    auto move = parse_move_notation("Ca2.Mh2", board, turn, padding);

    REQUIRE(move.has_value());
    REQUIRE(move->size() == 2);
    // First action should be a pawn move (cat)
    CHECK(std::holds_alternative<PawnMove>((*move)[0]));
    // Second action should be a pawn move (mouse)
    CHECK(std::holds_alternative<PawnMove>((*move)[1]));
}

TEST_CASE("parse_move_notation - Pawn move and wall", "[BGS Move Parsing]") {
    auto config = make_standard_config(8, 8);
    auto [board, turn, padding] = convert_bgs_config_to_board(config, 8, 8);

    // P1 cat starts at a1 [7,0], valid adjacent move is a2 (up).
    // Then place a vertical wall at b3.
    auto move = parse_move_notation("Ca2.>b3", board, turn, padding);

    REQUIRE(move.has_value());
    REQUIRE(move->size() == 2);
    CHECK(std::holds_alternative<PawnMove>((*move)[0]));
    CHECK(std::holds_alternative<Wall>((*move)[1]));
}

TEST_CASE("parse_move_notation - Double pawn move (cat moves twice)", "[BGS Move Parsing]") {
    auto config = make_standard_config(8, 8);
    auto [board, turn, padding] = convert_bgs_config_to_board(config, 8, 8);

    // P1 cat starts at a1 [7,0]. "Cb2" means cat ends at b2 [6,1].
    // This is 2 steps away (manhattan distance 2), so cat uses both actions.
    // Path: a1 -> b1 (right) -> b2 (up), or a1 -> a2 (up) -> b2 (right)
    auto move = parse_move_notation("Cb2", board, turn, padding);

    REQUIRE(move.has_value());
    REQUIRE(move->size() == 2);
    // Both actions should be cat pawn moves
    CHECK(std::holds_alternative<PawnMove>((*move)[0]));
    CHECK(std::holds_alternative<PawnMove>((*move)[1]));

    auto first_move = std::get<PawnMove>((*move)[0]);
    auto second_move = std::get<PawnMove>((*move)[1]);
    CHECK(first_move.pawn == Pawn::Cat);
    CHECK(second_move.pawn == Pawn::Cat);

    // Verify the directions lead to the correct destination
    // The path is horizontal-first: Right then Up
    CHECK(first_move.dir == Direction::Right);
    CHECK(second_move.dir == Direction::Up);
}

TEST_CASE("parse_move_notation - Double pawn move straight line", "[BGS Move Parsing]") {
    auto config = make_standard_config(8, 8);
    auto [board, turn, padding] = convert_bgs_config_to_board(config, 8, 8);

    // P1 cat starts at a1 [7,0]. "Ca3" means cat ends at a3 [5,0].
    // This is 2 steps up (same column), so cat uses both actions moving up twice.
    auto move = parse_move_notation("Ca3", board, turn, padding);

    REQUIRE(move.has_value());
    REQUIRE(move->size() == 2);
    auto first_move = std::get<PawnMove>((*move)[0]);
    auto second_move = std::get<PawnMove>((*move)[1]);

    CHECK(first_move.pawn == Pawn::Cat);
    CHECK(second_move.pawn == Pawn::Cat);
    CHECK(first_move.dir == Direction::Up);
    CHECK(second_move.dir == Direction::Up);
}

TEST_CASE("parse_move_notation - Invalid notation", "[BGS Move Parsing]") {
    auto config = make_standard_config(8, 8);
    auto [board, turn, padding] = convert_bgs_config_to_board(config, 8, 8);

    // THIS CASE IS NOT STALE - unlike the four above, its expectation is right
    // and the parser is wrong. Diagnosed 2026-07-30.
    //
    // parse_notation_part reads the row with std::stoi(coords.substr(1)), and
    // std::stoi stops at the first non-digit WITHOUT reporting that it did. So
    // "Ca2Mh1" parses as "Ca2" and the "Mh1" is silently discarded: the call
    // returns ONE action where the caller asked for two. Measured, not inferred -
    // a probe printed the parsed action list for each of these.
    //
    // It matters because this is the INBOUND path. handle_apply_move feeds the
    // human's move through here into the bot's search tree, so a notation that
    // truncates instead of failing leaves the engine searching a position the
    // real game is not in. Production is safe only because the server always
    // emits the "." separator, which is a property of today's caller rather
    // than of this parser.
    //
    // Fix belongs in src/engine_adapter.cpp (reject unless the coordinate
    // substring is fully consumed), so it ships with an engine rebuild.
    auto move1 = parse_move_notation("Ca2Mh1", board, turn, padding);
    CHECK_FALSE(move1.has_value());

    // The same defect with the trailing junk made obvious.
    auto move3 = parse_move_notation("Ca2xyz", board, turn, padding);
    CHECK_FALSE(move3.has_value());

    // Empty string
    auto move2 = parse_move_notation("", board, turn, padding);
    CHECK_FALSE(move2.has_value());
}

// ============================================================================
// Tests: MCTS peek_best_action
// ============================================================================

// REWRITTEN, and the old assertion is the point of the rewrite. This case used to
// assert that peek_best_action returns nullopt before sampling - the exact
// behaviour board task 945fe1ef removes. Reporting "no action" while the policy
// priors were sitting right there is what made low sample counts unusable, so the
// case now pins the fallback instead of the failure. Recorded loudly because a
// quietly-edited assertion is how a regression hides.
TEST_CASE("peek_best_action - Before sampling falls back to the policy's best action",
          "[BGS MCTS]") {
    Board board{5, 5};
    MCTS mcts(RankedPolicy{}, board, noiseless_opts());

    // After construction the root has edges but no expanded children, so there is
    // no visit evidence - the answer has to come from the priors.
    Action const expected =
        policy_best_action(RankedPolicy{}, board, Turn{Player::Red, Turn::First});

    auto action = mcts.peek_best_action();
    REQUIRE(action.has_value());
    CHECK(*action == expected);
    CHECK(is_legal_action(board, Player::Red, *action));
}

TEST_CASE("peek_best_action - After sampling returns action", "[BGS MCTS]") {
    Board board{5, 5};
    MCTS mcts(TestPolicy{}, std::move(board));

    // Sample to explore the tree
    folly::coro::blockingWait(mcts.sample(20));

    auto action = mcts.peek_best_action();
    REQUIRE(action.has_value());
}

TEST_CASE("peek_best_action - Does not modify tree", "[BGS MCTS]") {
    Board board{5, 5};
    MCTS mcts(TestPolicy{}, std::move(board));

    folly::coro::blockingWait(mcts.sample(50));

    int samples_before = mcts.root_samples();
    Board const& board_before = mcts.current_board();

    // Call peek multiple times
    auto action1 = mcts.peek_best_action();
    auto action2 = mcts.peek_best_action();
    auto action3 = mcts.peek_best_action();

    int samples_after = mcts.root_samples();
    Board const& board_after = mcts.current_board();

    // Tree should be unchanged
    CHECK(samples_before == samples_after);
    CHECK(&board_before == &board_after);  // Same board object

    // Should return same action
    REQUIRE(action1.has_value());
    CHECK(action1 == action2);
    CHECK(action2 == action3);
}

// ============================================================================
// Tests: MCTS peek_best_move
// ============================================================================

TEST_CASE("peek_best_move - Returns two actions", "[BGS MCTS]") {
    Board board{5, 5};
    MCTS mcts(TestPolicy{}, std::move(board));

    folly::coro::blockingWait(mcts.sample(100));

    auto move = mcts.peek_best_move();
    REQUIRE(move.has_value());

    // Move should have two actions
    // (first and second are always present in Move struct)
}

TEST_CASE("peek_best_move - Does not modify tree", "[BGS MCTS]") {
    Board board{5, 5};
    MCTS mcts(TestPolicy{}, std::move(board));

    folly::coro::blockingWait(mcts.sample(100));

    int samples_before = mcts.root_samples();

    auto move1 = mcts.peek_best_move();
    auto move2 = mcts.peek_best_move();

    int samples_after = mcts.root_samples();

    CHECK(samples_before == samples_after);
    REQUIRE(move1.has_value());
    CHECK(move1->first == move2->first);
}

// ============================================================================
// Tests: the low-sample prior fallback (board task 945fe1ef)
//
// Before this, a move needed an expanded GRANDCHILD - the root's best child had
// to be visited twice - so below roughly a hundred samples the BGS engine
// answered "No legal move available" and Easy Bot could not be run at the single
// sample Nil asked for.
// ============================================================================

TEST_CASE("peek_best_move - Exactly one sample yields a complete legal move", "[BGS MCTS]") {
    Board board{5, 5};
    MCTS mcts(RankedPolicy{}, board, noiseless_opts());

    folly::coro::blockingWait(mcts.sample(1));

    // This is the whole slice: nullopt here was the production failure.
    auto move = mcts.peek_best_move();
    REQUIRE(move.has_value());

    // Legal IN SEQUENCE, checked against the Board rather than the policy's own
    // edge list, because the interesting failure is a second action that is legal
    // at the root and illegal once the first action has been played.
    CHECK(is_legal_action(board, Player::Red, move->first));

    Board after_first = board;
    after_first.do_action(Player::Red, move->first);
    CHECK(is_legal_action(after_first, Player::Red, move->second));
}

TEST_CASE("peek_best_move - The second action is read from the position after the first",
          "[BGS MCTS]") {
    Board board{5, 5};
    MCTS mcts(RankedPolicy{}, board, noiseless_opts());

    folly::coro::blockingWait(mcts.sample(1));

    auto move = mcts.peek_best_move();
    REQUIRE(move.has_value());

    // RankedPolicy's best action is its last edge, which is a wall. One sample
    // expands exactly that edge, so the first action places that wall and the
    // second action has to come from the child's OWN priors.
    Board after_first = board;
    after_first.do_action(Player::Red, move->first);

    Action const expected_second =
        policy_best_action(RankedPolicy{}, after_first, Turn{Player::Red, Turn::Second});
    CHECK(move->second == expected_second);

    // And therefore not the root's own best action - the wall it names has just
    // been placed, so a fallback that read the ROOT's priors twice would return an
    // illegal move here.
    Action const root_best =
        policy_best_action(RankedPolicy{}, board, Turn{Player::Red, Turn::First});
    CHECK(move->first == root_best);
    CHECK_FALSE(move->second == root_best);
}

TEST_CASE("peek_best_move - With zero samples there is still no second position", "[BGS MCTS]") {
    Board board{5, 5};
    MCTS mcts(RankedPolicy{}, board, noiseless_opts());

    // DELIBERATE boundary, not an oversight. peek_best_action can fall back
    // because the root's own priors exist, but the second action needs the
    // position AFTER the first one, and that node does not exist until a sample
    // creates it. Manufacturing it here would mean evaluating and inserting a
    // node - a mutation, which is precisely what a peek must not do. The
    // requirement is a complete move at exactly ONE sample, above.
    CHECK(mcts.peek_best_action().has_value());
    CHECK_FALSE(mcts.peek_best_move().has_value());
}

TEST_CASE("peek_best_move - A deep search is still decided by visits, not priors", "[BGS MCTS]") {
    Board board{5, 5};
    MCTS mcts(TestPolicy{}, board, noiseless_opts());

    folly::coro::blockingWait(mcts.sample(1000));

    auto move = mcts.peek_best_move();
    REQUIRE(move.has_value());

    // principal_variation() walks the most-visited path, which IS the selection
    // peek_best_move made before the fallback existed, and it is code this change
    // does not touch. So this states the old behaviour from an independent place
    // rather than comparing the new implementation against itself.
    auto pv = mcts.principal_variation(2, 0.05f, 1);
    REQUIRE(pv.size() == 2);
    CHECK(move->first == pv[0].action);
    CHECK(move->second == pv[1].action);

    // Both steps have real visit evidence, so the fallback provably did not fire:
    // any expanded edge outranks an unexpanded one on visit count, and if the
    // fallback had fired anyway it would have had to agree with the visit
    // selection above to get here.
    CHECK(pv[0].child_visits > 0);
    CHECK(pv[1].child_visits > 0);

    // Concrete pin. "Cc5" is not this implementation's output written down: the
    // same case was compiled and run against the PRE-CHANGE mcts.cpp (d9d4ab4) on
    // 2026-07-30 and produced "Cc5" there too, so at a high sample count the
    // fallback provably did not move the engine's choice.
    Board const& root_board = mcts.current_board();
    CHECK(move->standard_notation(root_board.position(Player::Red),
                                  root_board.mouse(Player::Red),
                                  root_board.rows()) == "Cc5");
}

// ============================================================================
// Tests: SessionManager
// ============================================================================

TEST_CASE("SessionManager - Create session", "[BGS Session]") {
    BgsEngineConfig cfg;
    cfg.model_rows = 8;
    cfg.model_columns = 8;
    SessionManager manager(TestPolicy{}, cfg);

    auto config = make_standard_config(6, 6);
    auto [success, error] = manager.create_session("session_1", "bot_1", config);

    CHECK(success);
    CHECK(error.empty());
    CHECK(manager.has_session("session_1"));
    CHECK(manager.active_session_count() == 1);
}

TEST_CASE("SessionManager - root_noise_factor reaches the session's search", "[BGS Session]") {
    // The only externally visible proof that --root_noise_factor is wired through
    // BgsEngineConfig into MCTS::Options. Dropping that one assignment would leave
    // Easy Bot searching a root that is a quarter Dirichlet noise while every
    // config and doc claimed it was policy-only, and nothing else would notice.
    auto root_priors = [](float noise) {
        BgsEngineConfig cfg;
        cfg.model_rows = 8;
        cfg.model_columns = 8;
        cfg.root_noise_factor = noise;
        SessionManager manager(RankedPolicy{}, cfg);

        auto config = make_standard_config(6, 6);
        auto [success, error] = manager.create_session("session_noise", "bot_1", config);
        REQUIRE(success);

        std::vector<float> priors;
        for (EdgeInfo const& edge : manager.get_session("session_noise")->mcts->root_info().edges) {
            priors.push_back(edge.prior);
        }
        return priors;
    };

    std::vector<float> const noiseless = root_priors(0.0f);
    std::vector<float> const noisy = root_priors(0.25f);

    REQUIRE(noiseless.size() > 1);
    REQUIRE(noiseless.size() == noisy.size());

    // RankedPolicy hands out 0.001, 0.002, ... in edge order, so "untouched" is
    // something the test can state on its own instead of asking MCTS what it kept.
    for (std::size_t i = 0; i < noiseless.size(); ++i) {
        CHECK(std::fabs(noiseless[i] - 0.001f * static_cast<float>(i + 1)) < 1e-6f);
    }

    CHECK(noiseless != noisy);
}

TEST_CASE("SessionManager - Create duplicate session fails", "[BGS Session]") {
    BgsEngineConfig cfg;
    cfg.model_rows = 8;
    cfg.model_columns = 8;
    SessionManager manager(TestPolicy{}, cfg);

    auto config = make_standard_config(6, 6);
    manager.create_session("session_1", "bot_1", config);

    auto [success, error] = manager.create_session("session_1", "bot_1", config);

    CHECK_FALSE(success);
    CHECK(error.find("already exists") != std::string::npos);
}

TEST_CASE("SessionManager - End session", "[BGS Session]") {
    BgsEngineConfig cfg;
    cfg.model_rows = 8;
    cfg.model_columns = 8;
    SessionManager manager(TestPolicy{}, cfg);

    auto config = make_standard_config(6, 6);
    manager.create_session("session_1", "bot_1", config);

    auto [success, error] = manager.end_session("session_1");

    CHECK(success);
    CHECK_FALSE(manager.has_session("session_1"));
    CHECK(manager.active_session_count() == 0);
}

TEST_CASE("SessionManager - End non-existent session fails", "[BGS Session]") {
    BgsEngineConfig cfg;
    cfg.model_rows = 8;
    cfg.model_columns = 8;
    SessionManager manager(TestPolicy{}, cfg);

    auto [success, error] = manager.end_session("non_existent");

    CHECK_FALSE(success);
    CHECK(error.find("not found") != std::string::npos);
}

TEST_CASE("SessionManager - Get session", "[BGS Session]") {
    BgsEngineConfig cfg;
    cfg.model_rows = 8;
    cfg.model_columns = 8;
    SessionManager manager(TestPolicy{}, cfg);

    auto config = make_standard_config(6, 6);
    manager.create_session("session_1", "bot_1", config);

    std::shared_ptr<BgsSession> session = manager.get_session("session_1");
    REQUIRE(session != nullptr);
    CHECK(session->bgs_id == "session_1");
    CHECK(session->ply == 0);

    // Non-existent returns nullptr
    CHECK(manager.get_session("non_existent") == nullptr);

    // The lifetime contract: a caller holding the session keeps it alive past
    // end_session, so an in-flight handler cannot end up reading a freed MCTS
    // tree. end_session still makes the lookup fail immediately.
    CHECK(manager.end_session("session_1").first);
    CHECK(manager.get_session("session_1") == nullptr);
    CHECK(session->bgs_id == "session_1");
}

TEST_CASE("SessionManager - Multiple sessions", "[BGS Session]") {
    BgsEngineConfig cfg;
    cfg.model_rows = 8;
    cfg.model_columns = 8;
    SessionManager manager(TestPolicy{}, cfg);

    auto config = make_standard_config(6, 6);
    manager.create_session("session_1", "bot_1", config);
    manager.create_session("session_2", "bot_1", config);
    manager.create_session("session_3", "bot_2", config);

    CHECK(manager.active_session_count() == 3);
    CHECK(manager.has_session("session_1"));
    CHECK(manager.has_session("session_2"));
    CHECK(manager.has_session("session_3"));

    manager.end_session("session_2");
    CHECK(manager.active_session_count() == 2);
    CHECK_FALSE(manager.has_session("session_2"));
}

// ============================================================================
// Tests: Request Handlers (Integration)
// ============================================================================

TEST_CASE("handle_start_game_session", "[BGS Handlers]") {
    BgsEngineConfig cfg;
    cfg.model_rows = 8;
    cfg.model_columns = 8;
    SessionManager manager(TestPolicy{}, cfg);

    auto config = make_standard_config(6, 6);
    auto response = folly::coro::blockingWait(
        handle_start_game_session(manager, "test_session", "bot_1", config));

    CHECK(response["type"] == "game_session_started");
    CHECK(response["bgsId"] == "test_session");
    CHECK(response["success"] == true);
    CHECK(response["error"] == "");
}

TEST_CASE("handle_evaluate_position", "[BGS Handlers]") {
    BgsEngineConfig cfg;
    cfg.model_rows = 8;
    cfg.model_columns = 8;
    cfg.samples_per_move = 50;  // Small for faster tests
    SessionManager manager(TestPolicy{}, cfg);

    auto config = make_standard_config(6, 6);
    manager.create_session("test_session", "bot_1", config);

    auto response = folly::coro::blockingWait(
        handle_evaluate_position(manager, cfg, "test_session", 0));

    CHECK(response["type"] == "evaluate_response");
    CHECK(response["bgsId"] == "test_session");
    CHECK(response["ply"] == 0);
    CHECK(response["success"] == true);
    CHECK(response.contains("bestMove"));
    CHECK(response.contains("evaluation"));

    // Evaluation should be in valid range
    float eval = response["evaluation"].get<float>();
    CHECK(eval >= -1.0f);
    CHECK(eval <= 1.0f);
}

TEST_CASE("handle_evaluate_position - Ply mismatch", "[BGS Handlers]") {
    BgsEngineConfig cfg;
    cfg.model_rows = 8;
    cfg.model_columns = 8;
    SessionManager manager(TestPolicy{}, cfg);

    auto config = make_standard_config(6, 6);
    manager.create_session("test_session", "bot_1", config);

    // Request with wrong ply (session is at ply 0)
    auto response = folly::coro::blockingWait(
        handle_evaluate_position(manager, cfg, "test_session", 5));

    CHECK(response["success"] == false);
    CHECK(response["error"].get<std::string>().find("Ply mismatch") != std::string::npos);
}

TEST_CASE("handle_end_game_session", "[BGS Handlers]") {
    BgsEngineConfig cfg;
    cfg.model_rows = 8;
    cfg.model_columns = 8;
    SessionManager manager(TestPolicy{}, cfg);

    auto config = make_standard_config(6, 6);
    manager.create_session("test_session", "bot_1", config);

    auto response = folly::coro::blockingWait(
        handle_end_game_session(manager, "test_session"));

    CHECK(response["type"] == "game_session_ended");
    CHECK(response["success"] == true);
    CHECK_FALSE(manager.has_session("test_session"));
}

// The exact shape of the production freeze in game 99q94y29 (board task 8911a6d5). A human mouse
// walked PAST the bot's cat; the engine judged the capture at the midpoint, broke out of the action
// loop and skipped the end-of-turn reset, so the session sat at Turn::Second forever. Every later
// move came back as "too many actions for the current turn state", which the server read as engine
// failure and turned into a forfeit for the bot.
TEST_CASE("apply_move replays a mouse walking past a cat", "[BGS Handlers]") {
    BgsEngineConfig cfg;
    cfg.model_rows = 8;
    cfg.model_columns = 8;
    SessionManager manager(TestPolicy{}, cfg);

    // An 8x8 game board, so game space and model space coincide and the notation below is literal.
    // P1's mouse on e4 has P2's cat directly to its left on d4.
    json config;
    config["variant"] = "standard";
    config["boardWidth"] = 8;
    config["boardHeight"] = 8;
    config["initialState"]["pawns"]["p1"]["cat"] = {7, 0};
    config["initialState"]["pawns"]["p1"]["mouse"] = {4, 4};
    config["initialState"]["pawns"]["p2"]["cat"] = {4, 3};
    config["initialState"]["pawns"]["p2"]["mouse"] = {0, 7};
    config["initialState"]["walls"] = json::array();

    manager.create_session("walk_past", "bot_1", config);

    // Two steps left: through d4, where P2's cat is standing, and out the other side to c4.
    auto first = folly::coro::blockingWait(handle_apply_move(manager, "walk_past", 0, "Mc4"));
    REQUIRE(first["success"] == true);

    auto session = manager.get_session("walk_past");
    REQUIRE(session);

    // The turn COMPLETED. Before the fix the tree stopped on d4 and stayed on P1's second action.
    CHECK(session->mcts->current_turn() == Turn{Player::Blue, Turn::First});
    CHECK(session->mcts->current_board().mouse(Player::Red) == Cell{2, 4});
    CHECK(session->mcts->current_board().winner() == Winner::Undecided);

    // And the game goes on: P2's reply is accepted rather than refused.
    auto second = folly::coro::blockingWait(handle_apply_move(manager, "walk_past", 1, "Cd6"));
    CHECK(second["success"] == true);
    CHECK(second["error"] == "");
}

// The incident itself, replayed move for move: wallgame.io game 99q94y29, 2026-08-02.
//
// A freestyle 8x8 game (freestyle maps to Variant::Standard) with a custom setup, which is why it
// could not be reconstructed through the engine's external-game ingest - that path assumes a
// standard opening - but a BGS session takes the server's config verbatim, so the real game fits
// here. Config and notation are copied from GET /api/games/99q94y29.
//
// Move 8 is the bot's cat arriving on f6. Move 9 is the human's mouse stepping ONTO f6 and out to
// e6. The engine judged the capture at that midpoint, so it stopped applying the human's turn and
// never reset to the bot's - and from there the session was a turn behind the real game for good.
// Replaying all eleven moves is the check: the old engine reported success for the first ten while
// quietly diverging, then refused move 11 with "too many actions for the current turn state". The
// server read that as engine failure and forfeited the bot, which is the resignation this game
// ended on (board task 8911a6d5).
TEST_CASE("apply_move replays wallgame.io game 99q94y29 to the end", "[BGS Handlers]") {
    BgsEngineConfig cfg;
    cfg.model_rows = 8;
    cfg.model_columns = 8;
    // RankedPolicy rather than TestPolicy: force_action can only replay an action the policy listed
    // as an edge, and TestPolicy offers just the first five walls, so a real game's wall moves are
    // rejected as illegal by the harness rather than by the engine. The real policy head scores
    // every legal action, which is what RankedPolicy does here.
    SessionManager manager(RankedPolicy{}, cfg);

    json config;
    config["variant"] = "freestyle";
    config["boardWidth"] = 8;
    config["boardHeight"] = 8;
    config["initialState"]["pawns"]["p1"]["cat"] = {1, 0};
    config["initialState"]["pawns"]["p1"]["mouse"] = {1, 1};
    config["initialState"]["pawns"]["p2"]["cat"] = {1, 7};
    config["initialState"]["pawns"]["p2"]["mouse"] = {1, 6};
    config["initialState"]["walls"] = json::array({
        {{"cell", {1, 1}}, {"orientation", "horizontal"}},
        {{"cell", {1, 6}}, {"orientation", "horizontal"}},
        {{"cell", {2, 0}}, {"orientation", "horizontal"}},
        {{"cell", {2, 7}}, {"orientation", "horizontal"}},
        {{"cell", {3, 1}}, {"orientation", "horizontal"}},
        {{"cell", {3, 6}}, {"orientation", "horizontal"}},
        {{"cell", {7, 3}}, {"orientation", "horizontal"}},
        {{"cell", {7, 4}}, {"orientation", "horizontal"}},
    });

    auto const created = manager.create_session("g99q94y29", "dw-transformer", config);
    INFO("create_session error: " << created.second);
    REQUIRE(created.first);

    std::vector<std::string> const moves = {
        "Mc7.Md7", "Cg7.>a7", "Md6.Md5", ">c8.>c7", "Me5.Me6", "Ce7",
        "Mf6.Mg6", "Cf6",     "Mf6.Me6", ">f5",     "Md6.Mc6",
    };

    for (std::size_t ply = 0; ply < moves.size(); ++ply) {
        auto response = folly::coro::blockingWait(
            handle_apply_move(manager, "g99q94y29", static_cast<int>(ply), moves[ply]));

        INFO("ply " << ply << " move " << moves[ply] << " error "
                    << response["error"].get<std::string>());
        REQUIRE(response["success"] == true);

        // Every submitted move completes a turn, so the tree owes the OTHER player a fresh one after
        // each. This is the assertion that catches the divergence at move 9 rather than three moves
        // later: the old engine sat on Turn::Second from here on, and only move 11 was big enough to
        // be refused for it.
        auto session = manager.get_session("g99q94y29");
        REQUIRE(session);
        Turn const turn = session->mcts->current_turn();
        CHECK(turn.action == Turn::First);
        CHECK(turn.player == (ply % 2 == 0 ? Player::Blue : Player::Red));
    }
}
