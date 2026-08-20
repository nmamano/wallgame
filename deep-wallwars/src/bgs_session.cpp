#include "bgs_session.hpp"

#include <folly/Overload.h>
#include <folly/executors/CPUThreadPoolExecutor.h>
#include <folly/experimental/coro/BlockingWait.h>
#include <folly/hash/Hash.h>
#include <folly/logging/xlog.h>

#include <algorithm>
#include <numeric>

#include "naive_move.hpp"
#include "simple_policy.hpp"

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
    json const& initial_state = bgs_config["initialState"];
    if (turn.action == Turn::Second) {
        json const& spent_action =
            initial_state["turn"]["actionsTaken"][0];
        std::string const action_type =
            spent_action["type"].get<std::string>();
        if (action_type == "dog" || action_type == "cat" || action_type == "mouse" ||
            action_type == "elephant") {
            json const& source = spent_action["source"];
            Cell const game_source{
                source[1].get<int>(),
                source[0].get<int>()};
            Pawn pawn = action_type == "dog" ? Pawn::Dog
                      : action_type == "cat" ? Pawn::Cat
                      : action_type == "mouse" ? Pawn::Mouse
                                               : Pawn::Elephant;
            mcts_opts.starting_previous_position = PreviousPosition{
                pawn,
                engine_adapter::transform_to_model(
                    game_source, padding_config)};
        }
    }
    mcts_opts.seed = generate_seed(bgs_id);
    mcts_opts.max_parallelism = m_config.max_parallel_samples;
    mcts_opts.noise_factor = m_config.root_noise_factor;

    auto session = std::make_shared<BgsSession>();
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

    // Erasing makes every future lookup fail immediately, which is what the
    // protocol wants. The BgsSession itself only dies once the last in-flight
    // handler that pinned it via get_session() has dropped its reference, so a
    // request already in progress finishes coherently instead of reading a
    // freed MCTS tree.
    m_sessions.erase(it);

    XLOGF(INFO, "Ended BGS session {}", bgs_id);
    return {true, ""};
}

std::shared_ptr<BgsSession> SessionManager::get_session(std::string const& bgs_id) {
    std::shared_lock lock(m_sessions_mutex);
    auto it = m_sessions.find(bgs_id);
    return it != m_sessions.end() ? it->second : nullptr;
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

    // Pinned BEFORE we await anything: this shared_ptr is what keeps the
    // session and its MCTS tree alive if end_game_session removes it from the
    // manager while we are suspended in sample().
    std::shared_ptr<BgsSession> session = manager.get_session(bgs_id);
    if (!session) {
        co_return create_evaluate_response(
            bgs_id, expected_ply, "", 0.0f, false, "Session not found");
    }

    // Lock this session for the duration of the evaluation. Suspends rather
    // than blocking a worker, and releases correctly whichever worker resumes
    // us - see the comment on BgsSession::request_mutex.
    auto session_lock = co_await session->request_mutex.co_scoped_lock();

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

    Turn const current_turn = session->mcts->current_turn();
    Player const current_player = current_turn.player;

    // Get current pawn positions for notation
    Board const& board = session->mcts->current_board();
    Cell cat_pos = board.position(current_player);
    Cell mouse_pos = board.variant() == Variant::Classic
        ? board.home(current_player)
        : board.mouse(current_player);

    // In a position the search scores as completely lost, every line loses, so the visit counts are
    // ranking moves whose outcomes are identical - and the move that wins that ranking can look
    // absurd to a human. Take it from the naive policy instead (board task b4c2b191). `raw_eval` is
    // already from the MOVER's perspective, which is the perspective the threshold is written in; the
    // P1-perspective conversion further down is only for the response field.
    //
    // Deliberately limited to a turn with BOTH actions still to play. The naive policy has to be told
    // which cell the mover's pawn came from so it can exclude the undo action, and that information
    // is not recoverable from the tree - TreeNode does not retain it. A request for a turn that has
    // already spent an action keeps the search's move, which costs almost nothing: that can only
    // happen at ply 0 of a custom setup which begins mid-turn, because every later evaluate follows a
    // full applied move and therefore has both actions in hand.
    // An UNSET threshold is off, and nothing else is: root_value() reaches exactly -1.0 in a position
    // where every sample ends in a loss, so no numeric default can mean "disabled".
    bool const use_naive_policy = current_turn.action == Turn::First &&
                                  config.losing_fallback_eval.has_value() &&
                                  raw_eval <= *config.losing_fallback_eval;

    /*
    The actions this turn will actually play - two, one, or none of them.

    The rules let a player take a single action, or no action at all, so EVERY position has an
    answer and this handler never has to refuse. It used to build a fixed two-action Move and report
    the whole turn impossible whenever it could not find a second action. That lost real games: at
    the position reproduced on 2026-08-20 the mover had four legal moves, one of which won outright,
    and every one of them was a single cat move with nothing legal to follow it.

    Nothing below can fail. `turn_notation` writes however many actions are here, and writes the
    pass token `---` for none.
    */
    std::vector<Action> actions;

    if (use_naive_policy) {
        EvaluationFunction naive_policy = SimplePolicy{
            config.naive_move_prior, config.naive_good_move_bias, config.naive_bad_move_bias};
        actions = co_await naive::best_turn(naive_policy, board, current_turn, std::nullopt);
        XLOGF(DBG, "BGS {} ply {}: eval {:.3f} <= losing threshold {:.3f}, playing the naive policy",
              bgs_id, session->ply, raw_eval, *config.losing_fallback_eval);
    } else if (current_turn.action == Turn::Second) {
        // A custom setup may begin after the first action of a turn, and then one action completes
        // it.
        if (auto const action = session->mcts->peek_best_action()) {
            actions.push_back(*action);
        }
    } else if (auto const action1 = session->mcts->peek_best_action()) {
        actions.push_back(*action1);

        // Simulate the first action to see whether it decided the game. A deciding action ENDS the
        // turn: anything written after it either walks the pawn back off the deciding cell or is
        // simply lost, so the turn stops at one action. Note this is not "did we win" - in Animal
        // Cycle the mover can decide the game in the OPPONENT's favour with its own legal action,
        // and the turn must stop after that too.
        //
        // This used to ask `winner(Turn{player, Second})` directly, which answers Undecided for
        // every non-Animal variant by design - so the check was dead for Standard and Classic, and
        // the win was only preserved further down by `peek_best_move` padding the turn with an
        // arbitrary wall. `turn_must_end_after_action` is the question that was meant all along.
        Board test_board = board;
        test_board.do_action(current_player, *action1);
        bool const turn_is_over = turn_must_end_after_action(test_board, current_player);

        // A missing second action is a one-action turn, not a dead end.
        if (!turn_is_over) {
            if (auto const action2 = session->mcts->peek_best_second_action(*action1)) {
                actions.push_back(*action2);
            }
        }
    }

    if (actions.empty()) {
        XLOGF(DBG, "BGS {} ply {}: nothing legal to do, passing", bgs_id, session->ply);
    }

    std::string const model_notation = turn_notation(actions, board, current_player);
    std::string const game_notation = engine_adapter::transform_move_notation(
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

    // Pinned before awaiting the lock, same reason as in evaluate_position.
    std::shared_ptr<BgsSession> session = manager.get_session(bgs_id);
    if (!session) {
        co_return create_move_applied_response(
            bgs_id, expected_ply, false, "Session not found");
    }

    // Lock this session
    auto session_lock = co_await session->request_mutex.co_scoped_lock();

    // Validate ply
    if (session->ply != expected_ply) {
        co_return create_move_applied_response(
            bgs_id, session->ply, false,
            "Ply mismatch: expected " + std::to_string(expected_ply) +
                ", got " + std::to_string(session->ply));
    }

    Turn const turn = session->mcts->current_turn();
    Player const current_player = turn.player;

    // Parse the move notation into a list of actions (supports 1+ actions)
    auto actions_opt = engine_adapter::parse_move_notation(
        move_notation, session->mcts->current_board(), turn, session->padding_config);

    if (!actions_opt) {
        co_return create_move_applied_response(
            bgs_id, session->ply, false,
            "Failed to parse move notation: " + move_notation);
    }

    int const expected_actions =
        turn.action == Turn::First ? 2 : 1;
    int const action_cost = std::accumulate(
        actions_opt->begin(), actions_opt->end(), 0,
        [](int total, Action const& action) {
            auto const* pawn = std::get_if<PawnMove>(&action);
            return total + (pawn && pawn->second_dir ? 2 : 1);
        });
    if (action_cost > expected_actions) {
        co_return create_move_applied_response(
            bgs_id, session->ply, false,
            "Move has too many actions for the current turn state");
    }

    // Apply the actions individually (supports single-action moves)
    try {
        // Both checks read the TURN, not just the position. A capture only counts once the turn
        // ends, so a pawn that walks onto the cell it could be taken on and out the other side
        // decides nothing. Judging it mid-turn used to break out of this loop AND skip the reset
        // below, leaving the tree stuck at Turn::Second while the real game moved on - after which
        // every later move was refused as having too many actions (board task 8911a6d5).
        for (const auto& action : *actions_opt) {
            if (session->mcts->current_board().winner(session->mcts->current_turn()) !=
                Winner::Undecided) {
                break;  // Game already won, skip remaining actions
            }
            auto const* pawn = std::get_if<PawnMove>(&action);
            if (pawn && pawn->second_dir) {
                Board next = session->mcts->current_board();
                next.do_action(current_player, action);
                session->mcts->reset_to_position(
                    std::move(next), session->mcts->current_turn().next().next());
            } else {
                session->mcts->force_action(action);
            }
        }

        // A submitted move always completes the player's turn, even when they
        // voluntarily use fewer than the available actions.
        // Reset the tree to the next player's Turn::First.
        if (action_cost < expected_actions &&
            session->mcts->current_board().winner(session->mcts->current_turn()) ==
                Winner::Undecided) {
            Player next_player = current_player == Player::Red ? Player::Blue : Player::Red;
            session->mcts->reset_to_position(
                session->mcts->current_board(),
                Turn{next_player, Turn::First});
        }
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
