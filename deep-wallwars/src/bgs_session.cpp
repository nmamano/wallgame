#include "bgs_session.hpp"

#include <folly/executors/CPUThreadPoolExecutor.h>
#include <folly/experimental/coro/BlockingWait.h>
#include <folly/hash/Hash.h>
#include <folly/logging/xlog.h>

#include <algorithm>

namespace bgs {

// ============================================================================
// SessionManager Implementation
// ============================================================================

SessionManager::SessionManager(EvaluationFunction eval_fn, BgsEngineConfig config)
    : m_eval_fn{std::move(eval_fn)}, m_config{config} {}

std::uint32_t SessionManager::generate_seed(std::string const& bgs_id) const {
    // Hash the bgs_id and combine with base seed for reproducibility
    return static_cast<std::uint32_t>(
        folly::hash::fnv32(bgs_id) ^ m_config.base_seed);
}

std::pair<bool, std::string> SessionManager::create_session(
    std::string const& bgs_id,
    std::string const& bot_id,
    json const& bgs_config) {

    // Validate the config first
    auto validation = engine_adapter::validate_bgs_config(
        bgs_config, m_config.model_rows, m_config.model_columns);
    if (!validation.valid) {
        return {false, validation.error_message};
    }

    std::unique_lock lock(m_sessions_mutex);

    // Check if session already exists
    if (m_sessions.contains(bgs_id)) {
        return {false, "Session " + bgs_id + " already exists"};
    }

    // Check session limit
    if (m_sessions.size() >= static_cast<size_t>(BgsEngineConfig::kMaxSessions)) {
        return {false, "Maximum session limit reached (" +
                           std::to_string(BgsEngineConfig::kMaxSessions) + ")"};
    }

    // Convert config to board
    auto [board, turn, padding_config] = engine_adapter::convert_bgs_config_to_board(
        bgs_config, m_config.model_rows, m_config.model_columns);

    // Create MCTS with configured options
    MCTS::Options mcts_opts;
    mcts_opts.starting_turn = turn;
    mcts_opts.seed = generate_seed(bgs_id);
    mcts_opts.max_parallelism = m_config.max_parallel_samples;

    auto session = std::make_unique<BgsSession>();
    session->bgs_id = bgs_id;
    session->mcts = std::make_unique<MCTS>(m_eval_fn, std::move(board), mcts_opts);
    session->ply = 0;
    session->padding_config = padding_config;
    session->game_rows = bgs_config["boardHeight"].get<int>();
    session->game_columns = bgs_config["boardWidth"].get<int>();

    m_sessions[bgs_id] = std::move(session);

    XLOGF(INFO, "Created BGS session {} for bot {}", bgs_id, bot_id);
    return {true, ""};
}

std::pair<bool, std::string> SessionManager::end_session(std::string const& bgs_id) {
    std::unique_lock lock(m_sessions_mutex);

    auto it = m_sessions.find(bgs_id);
    if (it == m_sessions.end()) {
        return {false, "Session " + bgs_id + " not found"};
    }

    // The unique_ptr destructor will clean up the MCTS tree
    m_sessions.erase(it);

    XLOGF(INFO, "Ended BGS session {}", bgs_id);
    return {true, ""};
}

BgsSession* SessionManager::get_session(std::string const& bgs_id) {
    std::shared_lock lock(m_sessions_mutex);
    auto it = m_sessions.find(bgs_id);
    return it != m_sessions.end() ? it->second.get() : nullptr;
}

bool SessionManager::has_session(std::string const& bgs_id) const {
    std::shared_lock lock(m_sessions_mutex);
    return m_sessions.contains(bgs_id);
}

int SessionManager::active_session_count() const {
    std::shared_lock lock(m_sessions_mutex);
    return static_cast<int>(m_sessions.size());
}

// ============================================================================
// Response Helpers
// ============================================================================

static json create_session_started_response(
    std::string const& bgs_id,
    bool success,
    std::string const& error = "") {
    return json{
        {"type", "game_session_started"},
        {"bgsId", bgs_id},
        {"success", success},
        {"error", error}
    };
}

static json create_session_ended_response(
    std::string const& bgs_id,
    bool success,
    std::string const& error = "") {
    return json{
        {"type", "game_session_ended"},
        {"bgsId", bgs_id},
        {"success", success},
        {"error", error}
    };
}

static json create_evaluate_response(
    std::string const& bgs_id,
    int ply,
    std::string const& best_move,
    float evaluation,
    bool success,
    std::string const& error = "") {
    return json{
        {"type", "evaluate_response"},
        {"bgsId", bgs_id},
        {"ply", ply},
        {"bestMove", best_move},
        {"evaluation", evaluation},
        {"success", success},
        {"error", error}
    };
}

static json create_move_applied_response(
    std::string const& bgs_id,
    int ply,
    bool success,
    std::string const& error = "") {
    return json{
        {"type", "move_applied"},
        {"bgsId", bgs_id},
        {"ply", ply},
        {"success", success},
        {"error", error}
    };
}

// ============================================================================
// Request Handlers
// ============================================================================

folly::coro::Task<json> handle_start_game_session(
    SessionManager& manager,
    std::string const& bgs_id,
    std::string const& bot_id,
    json const& bgs_config) {

    auto [success, error] = manager.create_session(bgs_id, bot_id, bgs_config);
    co_return create_session_started_response(bgs_id, success, error);
}

folly::coro::Task<json> handle_end_game_session(
    SessionManager& manager,
    std::string const& bgs_id) {

    auto [success, error] = manager.end_session(bgs_id);
    co_return create_session_ended_response(bgs_id, success, error);
}

folly::coro::Task<json> handle_evaluate_position(
    SessionManager& manager,
    BgsEngineConfig const& config,
    std::string const& bgs_id,
    int expected_ply) {

    BgsSession* session = manager.get_session(bgs_id);
    if (!session) {
        co_return create_evaluate_response(
            bgs_id, expected_ply, "", 0.0f, false, "Session not found");
    }

    // Lock this session for the duration of the evaluation
    std::lock_guard<std::mutex> session_lock(session->request_mutex);

    // Validate ply
    if (session->ply != expected_ply) {
        co_return create_evaluate_response(
            bgs_id, session->ply, "", 0.0f, false,
            "Ply mismatch: expected " + std::to_string(expected_ply) +
                ", got " + std::to_string(session->ply));
    }

    // Run MCTS sampling - this is the potentially long operation
    co_await session->mcts->sample(config.samples_per_move);

    // Get evaluation BEFORE getting the move (important!)
    // root_value() returns from current player's perspective
    float raw_eval = session->mcts->root_value();

    // Get best move without committing (uses peek_best_move)
    auto move_opt = session->mcts->peek_best_move();
    if (!move_opt) {
        co_return create_evaluate_response(
            bgs_id, session->ply, "", 0.0f, false, "No legal move available");
    }

    // Determine current player based on ply
    Player current_player = (session->ply % 2 == 0) ? Player::Red : Player::Blue;

    // Get current pawn positions for notation
    Board const& board = session->mcts->current_board();
    Cell cat_pos = board.position(current_player);
    Cell mouse_pos = board.mouse(current_player);

    // Convert move to standard notation (in model coordinates)
    std::string model_notation = move_opt->standard_notation(
        cat_pos, mouse_pos, board.rows());

    // Transform notation from model to game coordinates
    std::string game_notation = engine_adapter::transform_move_notation(
        model_notation, cat_pos, mouse_pos, session->padding_config);

    // Convert evaluation to P1's perspective (negate if P2's turn)
    float evaluation = (current_player == Player::Red) ? raw_eval : -raw_eval;
    evaluation = std::clamp(evaluation, -1.0f, 1.0f);

    XLOGF(DBG, "BGS {} ply {}: best move {} eval {:.3f}",
          bgs_id, session->ply, game_notation, evaluation);

    co_return create_evaluate_response(
        bgs_id, session->ply, game_notation, evaluation, true);
}

folly::coro::Task<json> handle_apply_move(
    SessionManager& manager,
    std::string const& bgs_id,
    int expected_ply,
    std::string const& move_notation) {

    BgsSession* session = manager.get_session(bgs_id);
    if (!session) {
        co_return create_move_applied_response(
            bgs_id, expected_ply, false, "Session not found");
    }

    // Lock this session
    std::lock_guard<std::mutex> session_lock(session->request_mutex);

    // Validate ply
    if (session->ply != expected_ply) {
        co_return create_move_applied_response(
            bgs_id, session->ply, false,
            "Ply mismatch: expected " + std::to_string(expected_ply) +
                ", got " + std::to_string(session->ply));
    }

    // Determine current player based on ply
    Player current_player = (session->ply % 2 == 0) ? Player::Red : Player::Blue;
    Turn turn{current_player, Turn::First};

    // Parse the move notation
    auto move_opt = engine_adapter::parse_move_notation(
        move_notation, session->mcts->current_board(), turn, session->padding_config);

    if (!move_opt) {
        co_return create_move_applied_response(
            bgs_id, session->ply, false,
            "Failed to parse move notation: " + move_notation);
    }

    // Apply the move using force_move (preserves explored subtree)
    try {
        session->mcts->force_move(*move_opt);
    } catch (std::exception const& e) {
        co_return create_move_applied_response(
            bgs_id, session->ply, false,
            "Failed to apply move: " + std::string(e.what()));
    }

    // Increment ply
    session->ply++;

    XLOGF(DBG, "BGS {} applied move {}, now at ply {}",
          bgs_id, move_notation, session->ply);

    co_return create_move_applied_response(bgs_id, session->ply, true);
}

folly::coro::Task<json> handle_bgs_request(
    SessionManager& manager,
    BgsEngineConfig const& config,
    json const& request) {

    std::string type = request["type"].get<std::string>();
    std::string bgs_id = request["bgsId"].get<std::string>();

    if (type == "start_game_session") {
        std::string bot_id = request["botId"].get<std::string>();
        json const& bgs_config = request["config"];
        co_return co_await handle_start_game_session(manager, bgs_id, bot_id, bgs_config);

    } else if (type == "end_game_session") {
        co_return co_await handle_end_game_session(manager, bgs_id);

    } else if (type == "evaluate_position") {
        int expected_ply = request["expectedPly"].get<int>();
        co_return co_await handle_evaluate_position(manager, config, bgs_id, expected_ply);

    } else if (type == "apply_move") {
        int expected_ply = request["expectedPly"].get<int>();
        std::string move = request["move"].get<std::string>();
        co_return co_await handle_apply_move(manager, bgs_id, expected_ply, move);

    } else {
        XLOGF(ERR, "Unknown BGS request type: {}", type);
        co_return json{
            {"type", "error"},
            {"bgsId", bgs_id},
            {"error", "Unknown request type: " + type}
        };
    }
}

}  // namespace bgs
