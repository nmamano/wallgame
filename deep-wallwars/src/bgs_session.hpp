#pragma once

#include <folly/experimental/coro/Mutex.h>
#include <folly/experimental/coro/Task.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <mutex>  // std::unique_lock / std::lock_guard over m_sessions_mutex
#include <optional>
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
    int max_parallel_samples = 32;    // Parallelism within a single MCTS
    std::uint32_t base_seed = 42;     // Base seed for reproducibility
    int model_rows = 8;
    int model_columns = 8;

    // Fraction of Dirichlet noise mixed into the ROOT priors of every session in this process.
    // Taken from MCTS's own default rather than repeating the number, so an engine started without
    // the flag searches exactly as it did before this field existed. Zero means the root priors are
    // the policy head untouched, which is what a 1-sample "policy only" search needs; anything above
    // zero leaves that fraction of the root prior as noise.
    float root_noise_factor = MCTS::Options{}.noise_factor;

    // When set, and the search scores the position this bad or worse FROM THE MOVER'S OWN
    // PERSPECTIVE, the move is taken from the naive policy instead of from the tree (board task
    // b4c2b191). In a completely lost position every line loses, so the visit counts are ranking moves
    // with identical outcomes and the one that comes out can look absurd to a human.
    //
    // EMPTY MEANS OFF, and it is an optional rather than a number for a reason worth keeping. The
    // first version of this defaulted to -1.0 and called that "effectively off" - which was wrong,
    // because `MCTS::root_value()` legitimately reaches exactly -1.0 when every sample ends in a loss.
    // So the feature would have fired for Superhuman and Easy Bot in exactly the positions where it
    // was claimed to be disabled, contradicting both the config guard and the docs. There is no
    // numeric value that means "off"; only the absence of a value does.
    //
    // Production sets it for PuzzleBot ONLY. The scale is not calibrated and carries a large
    // board-size-dependent offset (a symmetric opening reads -0.83 on 8x8 and +0.76 on 12x10), so the
    // number cannot be reasoned about in the abstract - see the measurement in plans/engine-cluster.md.
    std::optional<float> losing_fallback_eval;

    // The threshold production uses when the fallback IS enabled, sized against the real puzzle corpus
    // (the 36 kept puzzles put the bot between -0.757 and -0.992, median -0.912). Lives here so the
    // engine flag's default and this document agree by construction.
    static constexpr float kDefaultLosingFallbackEval = -0.9f;

    // Parameters for the naive policy used by that fallback: cat moves biased toward the goal, mouse
    // moves away from the opponent's cat, walls taking the rest. Same defaults as SimplePolicy's own
    // flags, which is what "naive" means here.
    float naive_move_prior = 0.3f;
    float naive_good_move_bias = 1.5f;
    float naive_bad_move_bias = 0.75f;

    // Offline verification only. Adds exact model inputs, legal policy indices,
    // and selected indices to evaluate responses. Production leaves this off.
    bool policy_probe_details = false;

    // Offline causal experiment only. Both default OFF, so production behavior is unchanged.
    bool search_diagnostics = false;
    bool terminal_after_first_action_shortcut = false;

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

    // Per-session lock for sequential request handling within this BGS.
    // The V3 protocol guarantees only one pending request per BGS at a time,
    // but this lock keeps us safe if requests arrive before responses.
    //
    // Coroutine-aware ON PURPOSE, not a std::mutex. Handlers hold this across a
    // co_await - MCTS::sample() suspends - and a folly Task may resume on a
    // different worker than the one that suspended it. Unlocking a std::mutex
    // from a thread that does not own it is undefined behaviour, and a
    // std::mutex would also block a whole worker while the search runs.
    folly::coro::Mutex request_mutex;
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
     *
     * Returns a SHARED pointer, not a raw one, so that holding the result keeps
     * the session alive for as long as the caller needs it. A raw pointer would
     * outlive the internal shared_lock: end_session could erase the map entry
     * and free the MCTS tree while an in-flight handler was still sampling it.
     *
     * @return The session, or nullptr if not found
     */
    std::shared_ptr<BgsSession> get_session(std::string const& bgs_id);

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
    std::unordered_map<std::string, std::shared_ptr<BgsSession>> m_sessions;

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
