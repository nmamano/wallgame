#include "bgs_session.hpp"
#include "engine_adapter.hpp"
#include "mcts.hpp"
#include "simple_policy.hpp"

#include <catch2/catch_test_macros.hpp>
#include <folly/experimental/coro/BlockingWait.h>
#include <nlohmann/json.hpp>

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

        // Add pawn moves
        for (auto dir : board.legal_directions(turn.player, Pawn::Cat)) {
            Cell target = board.position(turn.player);
            target = target.neighbor(dir);
            edges.emplace_back(PawnMove{Pawn::Cat, target}, 0.5f);
        }
        for (auto dir : board.legal_directions(turn.player, Pawn::Mouse)) {
            Cell target = board.mouse(turn.player);
            target = target.neighbor(dir);
            edges.emplace_back(PawnMove{Pawn::Mouse, target}, 0.3f);
        }

        // Add a few walls
        auto walls = board.legal_walls();
        for (size_t i = 0; i < std::min(walls.size(), size_t{5}); ++i) {
            edges.emplace_back(walls[i], 0.1f);
        }

        co_return Evaluation{0.0f, std::move(edges)};
    }
};

// ============================================================================
// Helper: Create standard BgsConfig JSON
// ============================================================================

static json make_standard_config(int width = 8, int height = 8) {
    json config;
    config["variant"] = "standard";
    config["boardWidth"] = width;
    config["boardHeight"] = height;
    config["initialState"]["pawns"]["p1"]["cat"] = {height - 1, 0};
    config["initialState"]["pawns"]["p1"]["mouse"] = {height - 1, width - 1};
    config["initialState"]["pawns"]["p2"]["cat"] = {0, width - 1};
    config["initialState"]["pawns"]["p2"]["mouse"] = {0, 0};
    config["initialState"]["walls"] = json::array();
    return config;
}

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

    // Standard notation: "Ca2.Mh1" (cat to a2, mouse to h1)
    auto move = parse_move_notation("Ca2.Mh1", board, turn, padding);

    REQUIRE(move.has_value());
    // First action should be a pawn move (cat)
    CHECK(std::holds_alternative<PawnMove>(move->first));
    // Second action should be a pawn move (mouse)
    CHECK(std::holds_alternative<PawnMove>(move->second));
}

TEST_CASE("parse_move_notation - Pawn move and wall", "[BGS Move Parsing]") {
    auto config = make_standard_config(8, 8);
    auto [board, turn, padding] = convert_bgs_config_to_board(config, 8, 8);

    // Standard notation: "Ca2.>b3" (cat move, then vertical wall)
    auto move = parse_move_notation("Ca2.>b3", board, turn, padding);

    REQUIRE(move.has_value());
    CHECK(std::holds_alternative<PawnMove>(move->first));
    CHECK(std::holds_alternative<Wall>(move->second));
}

TEST_CASE("parse_move_notation - Invalid notation", "[BGS Move Parsing]") {
    auto config = make_standard_config(8, 8);
    auto [board, turn, padding] = convert_bgs_config_to_board(config, 8, 8);

    // Missing separator
    auto move1 = parse_move_notation("Ca2Mh1", board, turn, padding);
    CHECK_FALSE(move1.has_value());

    // Empty string
    auto move2 = parse_move_notation("", board, turn, padding);
    CHECK_FALSE(move2.has_value());
}

// ============================================================================
// Tests: MCTS peek_best_action
// ============================================================================

TEST_CASE("peek_best_action - Before sampling returns nullopt", "[BGS MCTS]") {
    Board board{5, 5};
    MCTS mcts(TestPolicy{}, std::move(board));

    // Before any sampling, there's no explored action
    auto action = mcts.peek_best_action();
    // Note: After construction, root node has edges but no children explored
    // peek_best_action checks for explored children
    CHECK_FALSE(action.has_value());
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

    BgsSession* session = manager.get_session("session_1");
    REQUIRE(session != nullptr);
    CHECK(session->bgs_id == "session_1");
    CHECK(session->ply == 0);

    // Non-existent returns nullptr
    CHECK(manager.get_session("non_existent") == nullptr);
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
