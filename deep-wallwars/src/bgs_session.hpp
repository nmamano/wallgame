#pragma once

#include <folly/experimental/coro/Task.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <mutex>
#include <shared_mutex>
#include <string>
#include <unordered_map>

#include "engine_adapter.hpp"
#include "mcts.hpp"

namespace bgs {

using json = nlohmann::json;

// ============================================================================
// Configuration
// ============================================================================

struct BgsEngineConfig {
    int samples_per_move = 1000;      // MCTS samples per evaluate_position
    int max_parallel_samples = 4;     // Parallelism within a single MCTS
    std::uint32_t base_seed = 42;     // Base seed for reproducibility
    int model_rows = 8;
    int model_columns = 8;

    static constexpr int kMaxSessions = 256;
};

// ============================================================================
// Bot Game Session
// ============================================================================

/**
 * Represents a single Bot Game Session (BGS).
 *
 * Each BGS maintains:
 * - A persistent MCTS tree that's reused across moves
 * - The current ply (position in game)
 * - Padding configuration for coordinate transforms
 *
 * Sessions are created via start_game_session and destroyed via end_game_session.
 * evaluate_position samples the tree without modifying it.
 * apply_move advances the tree using force_move.
 */
struct BgsSession {
    std::string bgs_id;
    std::unique_ptr<MCTS> mcts;
    int ply = 0;  // 0 = initial position, increments after each move
    engine_adapter::PaddingConfig padding_config;
    int game_rows;
    int game_columns;

    // Per-session mutex for sequential request handling within this BGS
    // The V3 protocol guarantees only one pending request per BGS at a time,
    // but this mutex ensures safety if requests arrive before responses.
    std::mutex request_mutex;
};

// ============================================================================
// Session Manager
// ============================================================================

/**
 * Manages all active Bot Game Sessions.
 *
 * Thread-safe: uses a shared_mutex to allow concurrent reads and exclusive writes
 * to the session map. Individual session operations acquire the session's mutex.
 */
class SessionManager {
public:
    SessionManager(EvaluationFunction eval_fn, BgsEngineConfig config);

    /**
     * Create a new BGS.
     * @param bgs_id Unique session identifier (provided by server)
     * @param bot_id Which bot this session is for
     * @param bgs_config Configuration with variant, board size, initial state
     * @return {success, error_message}
     */
    std::pair<bool, std::string> create_session(
        std::string const& bgs_id,
        std::string const& bot_id,
        json const& bgs_config);

    /**
     * End and cleanup a BGS.
     * @param bgs_id Session to end
     * @return {success, error_message}
     */
    std::pair<bool, std::string> end_session(std::string const& bgs_id);

    /**
     * Get a session by ID (for operations).
     * @return Pointer to session, or nullptr if not found
     */
    BgsSession* get_session(std::string const& bgs_id);

    /**
     * Check if a session exists.
     */
    bool has_session(std::string const& bgs_id) const;

    /**
     * Get the number of active sessions.
     */
    int active_session_count() const;

private:
    EvaluationFunction m_eval_fn;
    BgsEngineConfig m_config;

    mutable std::shared_mutex m_sessions_mutex;
    std::unordered_map<std::string, std::unique_ptr<BgsSession>> m_sessions;

    // Generate a seed for a session based on bgs_id
    std::uint32_t generate_seed(std::string const& bgs_id) const;
};

// ============================================================================
// Request Handlers (Coroutines)
// ============================================================================

/**
 * Handle start_game_session request.
 * Creates a new BGS with the given configuration.
 */
folly::coro::Task<json> handle_start_game_session(
    SessionManager& manager,
    std::string const& bgs_id,
    std::string const& bot_id,
    json const& bgs_config);

/**
 * Handle end_game_session request.
 * Cleans up the session and frees resources.
 */
folly::coro::Task<json> handle_end_game_session(
    SessionManager& manager,
    std::string const& bgs_id);

/**
 * Handle evaluate_position request.
 * Samples the MCTS tree and returns best move + evaluation.
 * Does NOT modify the tree (uses peek methods).
 */
folly::coro::Task<json> handle_evaluate_position(
    SessionManager& manager,
    BgsEngineConfig const& config,
    std::string const& bgs_id,
    int expected_ply);

/**
 * Handle apply_move request.
 * Advances the MCTS tree to the new position.
 */
folly::coro::Task<json> handle_apply_move(
    SessionManager& manager,
    std::string const& bgs_id,
    int expected_ply,
    std::string const& move_notation);

/**
 * Route a V3 request to the appropriate handler.
 * @param request JSON request with "type" field
 * @return Coroutine that produces the JSON response
 */
folly::coro::Task<json> handle_bgs_request(
    SessionManager& manager,
    BgsEngineConfig const& config,
    json const& request);

}  // namespace bgs
