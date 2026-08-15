#include <NvInfer.h>
#include <NvInferRuntime.h>
#include <folly/executors/CPUThreadPoolExecutor.h>
#include <folly/experimental/coro/BlockingWait.h>
#include <folly/experimental/coro/Collect.h>
#include <folly/logging/xlog.h>
#include <gflags/gflags.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <ranges>
#include <sstream>
#include <unordered_set>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "batched_model.hpp"
#include "batched_model_policy.hpp"
#include "cached_policy.hpp"
#include "engine_adapter.hpp"
#include "mcts.hpp"
#include "play.hpp"
#include "simple_policy.hpp"
#include "state_conversions.hpp"
#include "tensorrt_model.hpp"
#ifdef GUI_ENABLED
#include "gui/game_gui.hpp"
#endif

DEFINE_string(model1, "", "Serialized TensorRT Model 1");
DEFINE_string(model2, "", "Serialized TensorRT Model 2");
DEFINE_string(output, "data", "Folder to print training data to");
DEFINE_uint32(seed, 42, "Random seed");
DEFINE_uint64(cache_size, 100'000, "Size of the internal evaluation cache");
DEFINE_bool(boost_mouse_priors, false, "Boost mouse move priors to encourage exploration");

DEFINE_int32(columns, 5, "Number of columns");
DEFINE_int32(rows, 5, "Number of rows");
DEFINE_string(variant, "classic", "Game variant: classic or standard");
DEFINE_string(initial_state_config, "",
              "BGS-format JSON config for an authoritative self-play initial state");

DEFINE_int32(game_columns, 0,
             "Effective game columns, embedded in the -columns/-rows model frame with padding "
             "walls (0 = same as -columns). Applies to training, evaluation and ranking modes.");
DEFINE_int32(game_rows, 0, "Effective game rows (0 = same as -rows)");

DEFINE_int32(games, 100, "Number of games to play");
DEFINE_int32(start_game, 1, "Starting game number for output file naming (for resuming)");
DEFINE_int32(samples, 500, "Number of MCTS samples per action");
DEFINE_int32(move_limit, 100, "Maximum full moves per self-play game (0 = unlimited)");
DEFINE_int32(j, 8, "Number of threads");

DEFINE_double(move_prior, 0.3, "Move prior of simple agent");
DEFINE_double(good_move, 1.5, "Good move bias of simple agent");
DEFINE_double(bad_move, 0.75, "Bad move bias of simple agent");

DEFINE_bool(interactive, false, "Enable interactive play against the AI");
DEFINE_bool(gui, false, "Use GUI instead of console for interactive mode");

DEFINE_string(ranking, "", "Folder of *.trt models to rank against each other");
DEFINE_int32(tournaments, 10, "Number of tournaments to run for ranking");
DEFINE_bool(round_robin, false,
            "Ranking mode: play every pair of models once instead of running "
            "single-elimination brackets. Ignores -tournaments. Use this when play is "
            "deterministic (-samples 1 -root_noise_factor 0), where repeating a bracket "
            "would replay identical games.");
DEFINE_double(root_noise_factor, MCTS::Options{}.noise_factor,
              "Fraction of Dirichlet noise mixed into the root priors, in [0, 1]. "
              "0 leaves the policy head untouched, which is what a 1-sample search needs "
              "to be policy-only. Applies to ranking and evaluation modes.");
DEFINE_int32(initial_model, 0, "Index of the initial model to use for ranking");

DEFINE_bool(analyze, false,
            "Puzzle-gen spike: self-play one game and deeply analyze each start-of-turn "
            "position (eval-vs-visits trajectory + per-action Q/visits/prior), writing JSONL. "
            "Requires --model1.");
DEFINE_int32(analyze_samples, 100'000, "Deep MCTS visits per analyzed position (analyze mode)");
DEFINE_int32(analyze_chunk, 2'000,
             "Visit interval for eval-vs-visits trajectory logging (analyze mode)");
DEFINE_int32(analyze_moves, 60, "Max turns to analyze before stopping the game (analyze mode)");
DEFINE_string(analyze_output, "puzzle_candidates.jsonl", "Output JSONL path (analyze mode)");
DEFINE_int32(analyze_play_samples, 1500,
             "Move-selection search budget when a separate --model2 player is given "
             "(weakens play to manufacture tactical positions; analysis still uses the "
             "strong --model1 deep search as the oracle).");
DEFINE_bool(analyze_asymmetric, false,
            "In analyze mode with --model2: play Red with the strong --model1 and Blue with "
            "the weak --model2, so the strong side punishes the weak side's mistakes (hunts "
            "winning-shot tactics). Default: both sides play the weak --model2 (save-type).");
DEFINE_int32(analyze_max_parallelism, 16,
             "In-flight NN evaluations WITHIN a single analyzed position. The MCTS default "
             "is 4, which leaves the GPU's batch queue almost empty; training uses 16.");
DEFINE_int32(analyze_parallel_positions, 32,
             "Positions searched CONCURRENTLY (analyze mode with --analyze_game_file). "
             "Replaying games to collect positions is cheap CPU work and stays serial; "
             "only the deep searches are fanned out.");
DEFINE_int32(analyze_pv_actions, 12,
             "Max actions of the engine's principal variation to record per position "
             "(2 actions per turn, so 12 = 6 turns). The PV is read out of the existing "
             "search tree, so recording it costs no extra search.");
DEFINE_double(analyze_pv_delta, 0.05,
              "Q-closeness for counting near-best actions at each step of the principal "
              "variation (the forcing measure).");
DEFINE_int32(analyze_pv_min_visits, 50,
             "Stop walking the principal variation once the subtree has fewer visits than "
             "this - below it, 'the opponent has only one reply' is search thinness, not "
             "a forced line.");
DEFINE_string(analyze_game_file, "",
              "Analyze mode: instead of self-playing, ingest external games from this JSONL "
              "file (e.g. converted wallwars.net human games). Each line: "
              "{id, rows, columns, variant, firstPlayer, moves} where `moves` is standard "
              "notation in play order. Each start-of-turn position is analyzed with the "
              "strong --model1 oracle; the human move is then replayed to advance. "
              "--columns/--rows set the model frame the game is embedded in.");

namespace nv = nvinfer1;
namespace views = std::ranges::views;

int const kBatchedModelQueueSize = 4096;

enum class Mode {
    Train,
    Evaluate,
    Interactive,
    Ranking,
    Analyze
};

// Creates and validates a model, returning it as an EvaluationFunction
EvaluationFunction create_and_validate_model(nv::IRuntime& runtime, std::string const& model_flag,
                                             Mode mode) {
    if (model_flag == "simple") {
        return SimplePolicy(FLAGS_move_prior, FLAGS_good_move, FLAGS_bad_move);
    }

    // Load and validate TensorRT model
    std::ifstream model_file(model_flag, std::ios::binary);
    if (!model_file) {
        throw std::runtime_error("Failed to open model file: " + model_flag);
    }
    XLOGF(INFO, "Loading TensorRT engine from: {}", model_flag);
    std::shared_ptr<nv::ICudaEngine> engine;
    try {
        engine = load_serialized_engine(runtime, model_file);
    } catch (std::exception const& e) {
        throw std::runtime_error("Failed to load TensorRT engine from " + model_flag + ": " +
                                 e.what());
    }
    if (!engine) {
        throw std::runtime_error("Failed to load TensorRT engine from: " + model_flag);
    }

    std::vector<std::unique_ptr<Model>> tensor_rt_models;
    // Use two models to improve GPU utilization.
    int num_models = mode == Mode::Train ? 2 : 1;
    for (int i = 0; i < num_models; i++) {
        tensor_rt_models.push_back(std::make_unique<TensorRTModel>(engine));
    }
    auto batched_model =
        std::make_shared<BatchedModel>(std::move(tensor_rt_models), kBatchedModelQueueSize);
    BatchedModelPolicy batched_model_policy(std::move(batched_model), FLAGS_boost_mouse_priors);
    return CachedPolicy(std::move(batched_model_policy), FLAGS_cache_size);
}

std::string get_usage_message() {
    std::ostringstream oss;
    oss << "Deep Wallwars Usage:\n\n"
        << "RANKING: Rank all models in a folder against each other by playing random tournaments\n"
        << "    ./deep_ww --ranking <model_folder>\n"
        << "  Options:\n"
        << "    --tournaments N    # Number of tournaments to run (default 10)\n"
        << "    --initial_model N  # Index of the initial model to use for ranking (default 0)\n"
        << "    --round_robin      # Play every pair once instead of brackets; ignores "
           "--tournaments\n"
        << "    --root_noise_factor F  # Dirichlet noise on root priors (default 0.25); use 0\n"
        << "                           # with --samples 1 for a policy-only measurement\n"
        << "INTERACTIVE: Play against the AI\n"
        << "    ./deep_ww --interactive --model1 <model.trt | simple>\n"
        << "    ./deep_ww --interactive --model1 <model.trt | simple> --gui  # Use GUI instead of "
           "console\n"
        << "TRAINING: Generate training data via self-play\n"
        << "    ./deep_ww --model1 <model.trt | simple>\n"
        << "  Options:\n"
        << "    --output DIR # Output folder (default 'data')\n"
        << "EVALUATION: Evaluate models against each other\n"
        << "    ./deep_ww --model1 <model1.trt | simple> --model2 <model2.trt | simple>\n"
        << "ANALYZE (puzzle-gen spike): self-play one game, deeply analyze each position\n"
        << "    ./deep_ww --analyze --model1 <model.trt> --columns 8 --rows 8 --variant standard\n"
        << "  Options:\n"
        << "    --analyze_samples N  # Deep MCTS visits per position (default 100000)\n"
        << "    --analyze_chunk N    # Trajectory logging interval in visits (default 2000)\n"
        << "    --analyze_moves N    # Max turns to analyze (default 60)\n"
        << "    --analyze_output F   # Output JSONL path (default puzzle_candidates.jsonl)\n"
        << "    --analyze_game_file F        # Ingest external games instead of self-playing\n"
        << "    --analyze_parallel_positions N  # Positions searched at once (default 32)\n"
        << "    --analyze_max_parallelism N     # NN requests in flight per search (default 16)\n"
        << "    --analyze_pv_actions N          # Principal-variation actions to record "
           "(default 12)\n"
        << "COMMON OPTIONS:\n"
        << "    --games N             # Number of games to play (default 100)\n"
        << "    --samples N           # MCTS samples per action (default 500)\n"
        << "    --columns N --rows N  # Board size (default 5x5)\n"
        << "    --variant NAME        # classic or standard (default classic)\n"
        << "    --j N                 # Thread count (default 8)\n"
        << "    --seed N              # Random seed (default 42)\n"
        << "    --cache_size N        # MCTS cache size (default 100k)\n"
        << "SIMPLE POLICY OPTIONS: policy that primarily tries to move towards the goal\n"
        << "    --move_prior N  # How likely it is to choose a pawn move (default 0.3)\n"
        << "    --good_move N   # Bias for pawn moves that get closer to the goal (default 1.5)\n"
        << "    --bad_move N    # Bias for pawn moves that get further from the goal (default "
           "0.75)\n"
        << "See --help for all options\n";
    return oss.str();
}

struct Logger : nv::ILogger {
    void log(Severity severity, char const* msg) noexcept {
        switch (severity) {
            case Severity::kINTERNAL_ERROR:
            case Severity::kERROR:
                XLOG(ERR, msg);
                break;
            case Severity::kWARNING:
                XLOG(WARN, msg);
                break;
            case Severity::kINFO:
                XLOG(INFO, msg);
                break;
            default:
                break;
        }
    }
};

// Validates the optional -game_columns/-game_rows flags (both-or-neither,
// 4 <= game <= model frame). Called from main() BEFORE any model loading so
// invalid dimensions fail fast in every mode.
void validate_game_dims() {
    if ((FLAGS_game_columns > 0) != (FLAGS_game_rows > 0)) {
        std::cerr << "Error: -game_columns and -game_rows must be set together.\n";
        exit(1);
    }
    int game_columns = FLAGS_game_columns > 0 ? FLAGS_game_columns : FLAGS_columns;
    int game_rows = FLAGS_game_rows > 0 ? FLAGS_game_rows : FLAGS_rows;
    if (game_columns < 4 || game_rows < 4 || game_columns > FLAGS_columns ||
        game_rows > FLAGS_rows) {
        std::cerr << "Error: game dims " << game_columns << "x" << game_rows
                  << " invalid for model frame " << FLAGS_columns << "x" << FLAGS_rows
                  << " (need 4 <= game <= model).\n";
        exit(1);
    }
}

// Builds the board for a mode: the plain model-frame board, or, when
// -game_columns/-game_rows are set, the smaller game embedded in the frame
// with padding walls (equal dims = plain board, byte-identical behavior).
Board make_mode_board(Variant variant) {
    int game_columns = FLAGS_game_columns > 0 ? FLAGS_game_columns : FLAGS_columns;
    int game_rows = FLAGS_game_rows > 0 ? FLAGS_game_rows : FLAGS_rows;
    if (game_columns != FLAGS_columns || game_rows != FLAGS_rows) {
        XLOGF(INFO, "Padded board: game {}x{} embedded in model frame {}x{} ({} variant)",
              game_columns, game_rows, FLAGS_columns, FLAGS_rows, FLAGS_variant);
    }
    return engine_adapter::make_padded_training_board(FLAGS_columns, FLAGS_rows, game_columns,
                                                      game_rows, variant);
}

void train(EvaluationFunction const& eval_fn, Variant variant) {
    Board board = make_mode_board(variant);
    Turn starting_turn{Player::Red, Turn::First};
    std::optional<PreviousPosition> starting_previous_position;
    if (!FLAGS_initial_state_config.empty()) {
        std::ifstream config_stream(FLAGS_initial_state_config);
        if (!config_stream) {
            throw std::runtime_error("Could not open initial-state config: " +
                                     FLAGS_initial_state_config);
        }
        nlohmann::json config = nlohmann::json::parse(config_stream);
        auto validation = engine_adapter::validate_bgs_config(config, FLAGS_rows, FLAGS_columns);
        if (!validation.valid) {
            throw std::runtime_error("Invalid initial-state config: " + validation.error_message);
        }
        if (config["variant"] != variant_name(variant)) {
            throw std::runtime_error("Initial-state config variant does not match --variant");
        }
        auto converted = engine_adapter::convert_bgs_config_to_board(
            config, FLAGS_rows, FLAGS_columns);
        board = std::move(std::get<0>(converted));
        starting_turn = std::get<1>(converted);
        if (config["initialState"].contains("turn") &&
            !config["initialState"]["turn"]["actionsTaken"].empty()) {
            auto const& action = config["initialState"]["turn"]["actionsTaken"][0];
            std::string const type = action["type"];
            if (type != "wall") {
                Cell source{action["source"][0].get<int>(), action["source"][1].get<int>()};
                starting_previous_position = PreviousPosition{
                    type == "dog" ? Pawn::Dog
                    : type == "cat" ? Pawn::Cat
                    : type == "mouse" ? Pawn::Mouse
                                      : Pawn::Elephant,
                    engine_adapter::transform_to_model(source, std::get<2>(converted))};
            }
        }
    }
    TrainingDataPrinter training_data_printer(FLAGS_output, 0.5);

    folly::CPUThreadPoolExecutor thread_pool(FLAGS_j);

    XLOGF(INFO, "Created thread pool with {} threads (FLAGS_j = {})", thread_pool.numThreads(),
          FLAGS_j);

    folly::coro::blockingWait(training_play(board, FLAGS_games,
                                            {
                                                .model1 = eval_fn,
                                                .model2 = eval_fn,
                                                .samples = FLAGS_samples,
                                                .move_limit = FLAGS_move_limit,
                                                .start_game = FLAGS_start_game,
                                                .starting_turn = starting_turn,
                                                .starting_previous_position = starting_previous_position,
                                                .on_complete = training_data_printer,
                                                .seed = FLAGS_seed,
                                            })
                                  .scheduleOn(&thread_pool));

    // Get cache stats if available
    if (auto* cached_policy = eval_fn.target<CachedPolicy>()) {
        XLOGF(INFO, "{} cache hits, {} cache misses during play.", cached_policy->cache_hits(),
              cached_policy->cache_misses());

        // Get batched model stats
        if (auto* policy = cached_policy->underlying_policy().target<BatchedModelPolicy>()) {
            auto inferences = policy->total_inferences();
            auto batches = policy->total_batches();
            XLOGF(INFO, "{} inferences were sent in {} batches ({} per batch)", inferences, batches,
                  double(inferences) / batches);
        }
    }
}

void evaluate(EvaluationFunction const& eval_fn1, EvaluationFunction const& eval_fn2,
              Variant variant) {
    Board board = make_mode_board(variant);
    folly::CPUThreadPoolExecutor thread_pool(FLAGS_j);

    auto recorders = folly::coro::blockingWait(evaluation_play(board, FLAGS_games,
                                                               {
                                                                   .model1 = {eval_fn1, "Model1"},
                                                                   .model2 = {eval_fn2, "Model2"},
                                                                   .samples = FLAGS_samples,
                                                                   .seed = FLAGS_seed,
                                                               })
                                                   .scheduleOn(&thread_pool));

    for (auto const& [player, results] : tally_results(recorders)) {
        XLOGF(INFO, "{} has a W/L/D of {}/{}/{}.", player, results.wins, results.losses,
              results.draws);
    }

    // Get cache stats for first model if available
    if (auto* cached_policy = eval_fn1.target<CachedPolicy>()) {
        XLOGF(INFO, "Model1: {} cache hits, {} cache misses during play.",
              cached_policy->cache_hits(), cached_policy->cache_misses());

        // Get batched model stats for first model
        if (auto* policy = cached_policy->underlying_policy().target<BatchedModelPolicy>()) {
            auto inferences = policy->total_inferences();
            auto batches = policy->total_batches();
            XLOGF(INFO, "Model1: {} inferences were sent in {} batches ({} per batch)", inferences,
                  batches, double(inferences) / batches);
        }
    }
}

void interactive(EvaluationFunction const& eval_fn, Variant variant) {
    Board board{FLAGS_columns, FLAGS_rows, variant};
    folly::CPUThreadPoolExecutor thread_pool(FLAGS_j);
    InteractivePlayOptions opts = {
        .model = eval_fn,
        .samples = FLAGS_samples,
        .seed = FLAGS_seed,
    };

#ifdef GUI_ENABLED
    if (FLAGS_gui) {
        GUI::interactive_play_gui(board, opts, thread_pool);
        return;
    }
#endif
    folly::coro::blockingWait(interactive_play(board, opts).scheduleOn(&thread_pool));
}

void ranking(nv::IRuntime& runtime, Variant variant) {
    std::filesystem::path ranking_folder(FLAGS_ranking);
    // multimap, not map: models are ordered by mtime so that -initial_model drops
    // the oldest ones, but copying several engines into the folder at once gives
    // them identical timestamps, and a map would silently discard all but one.
    std::multimap<std::filesystem::file_time_type, std::filesystem::path> model_paths;
    for (auto const& dir_entry : std::filesystem::directory_iterator{ranking_folder}) {
        if (dir_entry.path().extension() == ".trt") {
            model_paths.insert({dir_entry.last_write_time(), dir_entry.path()});
        }
    }

    std::vector<std::unique_ptr<nv::ICudaEngine>> engines;
    std::vector<NamedModel> models;

    for (auto const& [_, model_path] : model_paths | views::drop(FLAGS_initial_model)) {
        auto cached_policy = create_and_validate_model(runtime, model_path.string(), Mode::Ranking);
        models.push_back(NamedModel{std::move(cached_policy), model_path.filename().string()});
    }

    Board board = make_mode_board(variant);
    folly::CPUThreadPoolExecutor thread_pool(FLAGS_j);
    XLOGF(INFO, "Collected {} models. Starting ranking now.", models.size());

    RankingPlayOptions ranking_opts{.models = std::move(models),
                                    .output_folder = ranking_folder,
                                    .samples = FLAGS_samples,
                                    .games_per_matchup = FLAGS_games,
                                    .num_tournaments = FLAGS_tournaments,
                                    .noise_factor = static_cast<float>(FLAGS_root_noise_factor),
                                    .seed = FLAGS_seed};

    auto play = FLAGS_round_robin ? round_robin_play(board, std::move(ranking_opts))
                                  : ranking_play(board, std::move(ranking_opts));
    auto recorders = folly::coro::blockingWait(std::move(play).scheduleOn(&thread_pool));

    XLOGF(INFO, "Output written to {}.pgn/json.", (ranking_folder / "games").string());
}

// Puzzle-generation spike (Phase 0a, see info/puzzle-generation.md).
//
// Self-plays a single game with `eval_fn` on both sides. Before each turn we run
// a FRESH deep MCTS at the start-of-turn position (root noise disabled) and record:
//   - the eval-vs-visits trajectory (to detect the "eval jump" and its N_jump), and
//   - every legal root action's Q / visits / prior (to compute solution density).
// One JSONL record is emitted per analyzed position. The engine's best move is then
// committed to advance the game, so the analyzed positions come from a strong-vs-strong
// line. This does NOT yet extract/store puzzles; it produces the raw data we eyeball in
// Phase 0b to decide whether eval-jumps + low density actually correspond to real tactics.
// Build the per-position JSONL record from a completed deep search. Shared by
// self-play analysis (analyze_game) and external-game ingest (analyze_external_game).
nlohmann::json build_position_record(Board const& board, Turn turn, NodeInfo const& info,
                                     int total_visits,
                                     std::vector<std::pair<int, float>> const& trajectory) {
    Cell const cat = board.position(turn.player);

    nlohmann::json record;
    record["player"] = turn.player == Player::Red ? "red" : "blue";
    record["variant"] = std::string(variant_name(board.variant()));
    record["columns"] = board.columns();
    record["rows"] = board.rows();
    record["cat"] = {{"col", cat.column}, {"row", cat.row}};
    record["root_q"] = info.q_value;
    record["num_legal_actions"] = static_cast<int>(info.edges.size());
    record["total_visits"] = total_visits;

    nlohmann::json traj = nlohmann::json::array();
    for (auto const& [n, q] : trajectory) {
        traj.push_back({{"visits", n}, {"q", q}});
    }
    record["trajectory"] = std::move(traj);

    nlohmann::json edges = nlohmann::json::array();
    for (EdgeInfo const& edge : info.edges) {
        std::ostringstream action_str;
        action_str << edge.action;
        edges.push_back({{"action", action_str.str()},
                         {"visits", edge.num_samples},
                         {"q", edge.q_value},
                         {"prior", edge.prior}});
    }
    record["edges"] = std::move(edges);
    return record;
}

// Records the engine's principal variation on the position: the line it expects, with the
// per-step forcing statistics, plus each side's cat distance-to-goal along the way.
//
// Both exist for filter v2 (see info/puzzle-generation.md). Forcing-ness decides whether a
// human can VERIFY the key move at the board or has to take it on faith - the first batch
// of candidates failed precisely because nothing constrained the opponent's replies. The
// distance track separates the two ways a candidate goes wrong: a move that changes the
// race immediately reads as obvious, and a move that never changes it reads as
// inscrutable. The target is the band in between - no change now, a forced change soon.
void add_principal_variation(nlohmann::json& record, Board const& start_board,
                             std::vector<PvStep> const& pv) {
    auto distances = [](Board const& b) {
        return nlohmann::json{{"red", b.distance(b.position(Player::Red), b.goal(Player::Red))},
                              {"blue", b.distance(b.position(Player::Blue), b.goal(Player::Blue))}};
    };

    record["dist_before"] = distances(start_board);

    Board board = start_board;
    nlohmann::json steps = nlohmann::json::array();
    for (PvStep const& step : pv) {
        std::ostringstream action_str;
        action_str << step.action;

        board.do_action(step.player, step.action);
        // Only a completed turn can decide the game, and PvStep already carries which half of the
        // turn this action was. Mid-turn a pawn may be sitting on the cell it could be taken on.
        bool const decided = step.second_action && board.winner() != Winner::Undecided;

        nlohmann::json entry{
            {"action", action_str.str()},
            {"player", step.player == Player::Red ? "red" : "blue"},
            {"second", step.second_action},
            {"node_visits", step.node_visits},
            {"visits", step.child_visits},
            {"q", step.q_value},
            {"gap", step.gap},
            {"near_best", step.near_best},
            {"considered", step.considered},
        };
        // Once a side has reached its goal the position is over and distances stop being
        // meaningful, so report them only while the game is still running.
        if (!decided) {
            entry["dist"] = distances(board);
        }
        steps.push_back(std::move(entry));

        if (decided) {
            break;
        }
    }
    record["pv"] = std::move(steps);
}

folly::coro::Task<void> analyze_game(EvaluationFunction const& analyze_fn,
                                     EvaluationFunction const& play_fn, bool separate_player,
                                     Board start_board, std::ostream& out) {
    Board board = start_board;
    Turn turn{Player::Red, Turn::First};

    for (int move_index = 0;
         move_index < FLAGS_analyze_moves && board.winner() == Winner::Undecided; ++move_index) {
        MCTS::Options opts;
        opts.starting_turn = turn;
        opts.noise_factor = 0.0f;  // clean analysis: no root exploration noise
        opts.max_parallelism = FLAGS_analyze_max_parallelism;
        opts.seed = FLAGS_seed + move_index;
        MCTS mcts(analyze_fn, board, opts);

        // Chunked sampling grows a single search; record the trajectory as it grows.
        // sample() resets samples_done() per call, so track cumulative visits ourselves.
        std::vector<std::pair<int, float>> trajectory;
        int visits = 0;
        while (visits < FLAGS_analyze_samples) {
            int chunk = std::min(FLAGS_analyze_chunk, FLAGS_analyze_samples - visits);
            co_await mcts.sample(chunk);
            visits += chunk;
            trajectory.emplace_back(visits, mcts.root_value());
        }

        nlohmann::json record =
            build_position_record(board, turn, mcts.root_info(), mcts.root_samples(), trajectory);
        record["move_index"] = move_index;
        add_principal_variation(record, board,
                                mcts.principal_variation(FLAGS_analyze_pv_actions,
                                                         static_cast<float>(FLAGS_analyze_pv_delta),
                                                         FLAGS_analyze_pv_min_visits));

        out << record.dump() << "\n";
        out.flush();

        // Move selection. With a separate (typically weaker) --model2 player, run a
        // shallow search with play_fn to advance the game: its mistakes manufacture the
        // tactical positions the deep analysis above is built to detect. Otherwise commit
        // from the strong deep search itself (symmetric strong-vs-strong self-play).
        std::optional<Move> best;
        if (separate_player) {
            // Asymmetric mode: Red plays the strong oracle, Blue the weak model, so the
            // strong side punishes the weak side's blunders (winning-shot tactics).
            // Symmetric mode: both sides play the weak model (save-type tactics).
            EvaluationFunction const& mover_fn =
                (FLAGS_analyze_asymmetric && turn.player == Player::Red) ? analyze_fn : play_fn;
            MCTS::Options play_opts = opts;
            play_opts.seed = FLAGS_seed + move_index + 100000;
            MCTS play_mcts(mover_fn, board, play_opts);
            co_await play_mcts.sample(FLAGS_analyze_play_samples);
            best = play_mcts.peek_best_move();
        } else {
            best = mcts.peek_best_move();
        }
        if (!best) {
            XLOGF(INFO, "No legal move at move {}; stopping analysis.", move_index);
            break;
        }
        board.do_action(turn.player, best->first);
        if (board.reached_goal(turn.player)) {
            break;  // first action captured; skip the (arbitrary) second action
        }
        board.do_action(turn.player, best->second);
        turn = {other_player(turn.player), Turn::First};
    }

    co_return;
}

// A single start-of-turn position queued for deep analysis.
//
// Splitting collection from searching is the whole point: replaying a game to reach its
// positions is pure CPU and takes milliseconds, while the deep search on one position
// takes ~10 seconds of GPU. Interleaving them (the original shape) meant the GPU sat idle
// during every replay and, worse, forced the positions to be searched strictly in order.
struct AnalysisTask {
    Board board;
    Turn turn;
    std::string game_id;
    int move_index;
    int game_rows;
    int game_columns;
};

// External-game ingest (Phase 1, see info/puzzle-generation.md). Instead of the
// engine self-playing, replay a real recorded game (e.g. a converted wallwars.net
// human game) and collect each start-of-turn position for analysis with the strong
// oracle. The position SOURCE is imperfect human play (where hidden tactics exist
// and get missed); the ANALYSIS is the strong deep search.
//
// `seen_positions` is shared across ALL games in the run so duplicate positions are
// searched once; the return value counts the duplicates that saved. Dedup happens HERE,
// before any GPU work, because these players reuse openings and ~10% of an 8x8 run was
// the same board recurring across games.
int collect_external_game_positions(nlohmann::json const& game,
                                    std::vector<AnalysisTask>& tasks,
                                    std::unordered_set<std::uint64_t>& seen_positions) {
    int skipped_duplicates = 0;
    int const game_rows = game.at("rows").get<int>();
    int const game_cols = game.at("columns").get<int>();
    auto const parsed_variant = parse_variant(game.value("variant", std::string("classic")));
    if (!parsed_variant) {
        XLOGF(ERR, "game {}: unsupported variant '{}'", game.value("id", std::string("?")),
              game.value("variant", std::string("?")));
        return 0;
    }
    Variant const variant = *parsed_variant;

    // Embed the (possibly smaller) game board in the model frame FLAGS_columns x FLAGS_rows.
    engine_adapter::PaddingConfig const pc = engine_adapter::create_padding_config(
        FLAGS_rows, FLAGS_columns, game_rows, game_cols, variant);
    Board board = engine_adapter::make_padded_training_board(FLAGS_columns, FLAGS_rows, game_cols,
                                                             game_rows, variant);

    int const first = game.value("firstPlayer", 1);
    Turn turn{first == 1 ? Player::Red : Player::Blue, Turn::First};
    std::string const id = game.value("id", std::string(""));

    // Tokenize the moves string into per-turn tokens, dropping "N." numbering.
    std::vector<std::string> tokens;
    {
        std::istringstream iss(game.at("moves").get<std::string>());
        std::string tok;
        while (iss >> tok) {
            if (!tok.empty() && tok.back() == '.' &&
                tok.find_first_not_of("0123456789") == tok.size() - 1) {
                continue;  // "12." move-number token
            }
            tokens.push_back(tok);
        }
    }

    for (int mi = 0; mi < static_cast<int>(tokens.size()) && mi < FLAGS_analyze_moves &&
                     board.winner() == Winner::Undecided;
         ++mi) {
        // Position-level dedup ACROSS games, BEFORE the expensive search. Human
        // opponents reuse openings, so the same board recurs in many games (observed:
        // one 8x8 position appeared identically in 3 games). Analyzing it more than
        // once burns GPU for a duplicate record. std::hash<Board> covers pawns, mice,
        // variant and the full wall state but NOT whose turn it is, so fold the turn in.
        std::uint64_t const pos_key = std::hash<Board>{}(board) * 4 +
                                      (turn.player == Player::Red ? 0u : 2u) +
                                      (turn.action == Turn::First ? 0u : 1u);
        if (!seen_positions.insert(pos_key).second) {
            ++skipped_duplicates;
        } else {
            tasks.push_back(AnalysisTask{.board = board,
                                         .turn = turn,
                                         .game_id = id,
                                         .move_index = mi,
                                         .game_rows = game_rows,
                                         .game_columns = game_cols});
        }

        // Replay the human move (game-space notation -> model-space actions).
        auto const actions = engine_adapter::parse_move_notation(tokens[mi], board, turn, pc);
        if (!actions) {
            XLOGF(ERR, "game {}: failed to parse move {} ('{}'); stopping this game.", id, mi,
                  tokens[mi]);
            break;
        }
        // Every action of the submitted move is replayed, with no capture check between them. This
        // is a recorded human turn, so a pawn of EITHER colour may be walking past the cell where a
        // capture would be judged, and only the completed turn decides anything - which the outer
        // loop's condition already checks. A player who spent fewer actions simply supplies a
        // shorter list.
        for (Action const& action : *actions) {
            board.do_action(turn.player, action);
        }
        turn = {other_player(turn.player), Turn::First};
    }

    return skipped_duplicates;
}

// Deeply analyzes ONE collected position and appends its JSONL record. Many of these run
// concurrently, so the output stream is written under a mutex - records still land
// incrementally (a long run stays inspectable while it is going), just no longer in game
// order, which is why every record carries its own game id and move index.
folly::coro::Task<int> analyze_position(EvaluationFunction const& analyze_fn,
                                        AnalysisTask const& task, int index, std::ostream& out,
                                        std::mutex& out_mutex, std::atomic<int>& completed,
                                        int total, std::chrono::steady_clock::time_point start) {
    MCTS::Options opts;
    opts.starting_turn = task.turn;
    opts.noise_factor = 0.0f;  // clean analysis: no root exploration noise
    opts.max_parallelism = FLAGS_analyze_max_parallelism;
    // Seeded by position index, not move index, so a rerun of the same task list is
    // reproducible regardless of how the searches happen to interleave.
    opts.seed = FLAGS_seed + index;
    MCTS mcts(analyze_fn, task.board, opts);

    // Chunked sampling grows a single search; record the trajectory as it grows.
    // sample() resets samples_done() per call, so track cumulative visits ourselves.
    std::vector<std::pair<int, float>> trajectory;
    int visits = 0;
    while (visits < FLAGS_analyze_samples) {
        int chunk = std::min(FLAGS_analyze_chunk, FLAGS_analyze_samples - visits);
        co_await mcts.sample(chunk);
        visits += chunk;
        trajectory.emplace_back(visits, mcts.root_value());
    }

    nlohmann::json record = build_position_record(task.board, task.turn, mcts.root_info(),
                                                  mcts.root_samples(), trajectory);
    record["game_id"] = task.game_id;
    record["move_index"] = task.move_index;
    // board rows/columns above are the MODEL frame; record the true game size too
    // (the game is embedded in the frame, cat positions are in model coords).
    record["game_rows"] = task.game_rows;
    record["game_columns"] = task.game_columns;
    // A turn is TWO actions. root_info().edges are only the FIRST actions, so
    // record the complete intended turn as well - without it a puzzle solution
    // is half-specified and cannot be completed by a solver.
    if (auto best_turn = mcts.peek_best_move()) {
        std::ostringstream first_str, second_str;
        first_str << best_turn->first;
        second_str << best_turn->second;
        record["best_turn"] = {first_str.str(), second_str.str()};
    }
    add_principal_variation(record, task.board,
                            mcts.principal_variation(FLAGS_analyze_pv_actions,
                                                     static_cast<float>(FLAGS_analyze_pv_delta),
                                                     FLAGS_analyze_pv_min_visits));

    int const done = completed.fetch_add(1) + 1;
    {
        std::lock_guard<std::mutex> lock(out_mutex);
        out << record.dump() << "\n";
        out.flush();
    }

    if (done % 25 == 0 || done == total) {
        double const minutes =
            std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count() / 60.0;
        XLOGF(INFO, "Analyzed {}/{} positions ({:.1f}/min, {:.0f} min remaining)", done, total,
              done / std::max(minutes, 1e-9), (total - done) * minutes / std::max(done, 1));
    }

    co_return 1;
}

// Fans the deep searches out. This is where the entire GPU budget of a run goes, so it is
// the only part that is parallel. Both windows matter and multiply: how many positions are
// searched at once, and how many NN requests each search keeps in flight. Left at the MCTS
// default of 4 in-flight requests, one position at a time, this fed a batch queue sized for
// thousands roughly four items at a time.
folly::coro::Task<void> run_position_analysis(EvaluationFunction const& analyze_fn,
                                              std::vector<AnalysisTask> const& tasks,
                                              std::ostream& out) {
    auto* executor = co_await folly::coro::co_current_executor;
    std::mutex out_mutex;
    std::atomic<int> completed{0};
    int const total = static_cast<int>(tasks.size());
    auto const start = std::chrono::steady_clock::now();

    auto search_tasks = views::iota(0, total) | views::transform([&](int i) {
                            return analyze_position(analyze_fn, tasks[i], i, out, out_mutex,
                                                    completed, total, start)
                                .scheduleOn(executor);
                        });

    co_await folly::coro::collectAllWindowed(search_tasks, FLAGS_analyze_parallel_positions);
    co_return;
}

void analyze_external_games(EvaluationFunction const& analyze_fn) {
    folly::CPUThreadPoolExecutor thread_pool(FLAGS_j);
    std::ofstream out(FLAGS_analyze_output);
    if (!out) {
        XLOGF(ERR, "Failed to open analyze output file: {}", FLAGS_analyze_output);
        return;
    }
    std::ifstream in(FLAGS_analyze_game_file);
    if (!in) {
        XLOGF(ERR, "Failed to open analyze game file: {}", FLAGS_analyze_game_file);
        return;
    }
    XLOGF(INFO,
          "Ingesting external games from {}: {} visits/position, model frame {}x{}, up to {} "
          "moves/game -> {}",
          FLAGS_analyze_game_file, FLAGS_analyze_samples, FLAGS_columns, FLAGS_rows,
          FLAGS_analyze_moves, FLAGS_analyze_output);

    // Pass 1 (CPU only): replay every game and collect the distinct positions.
    std::vector<AnalysisTask> tasks;
    std::unordered_set<std::uint64_t> seen_positions;
    int skipped_duplicates = 0;
    std::string line;
    int game_no = 0;
    while (std::getline(in, line)) {
        if (line.find_first_not_of(" \t\r\n") == std::string::npos) continue;
        nlohmann::json game;
        try {
            game = nlohmann::json::parse(line);
        } catch (std::exception const& e) {
            XLOGF(ERR, "Skipping malformed JSONL line: {}", e.what());
            continue;
        }
        skipped_duplicates += collect_external_game_positions(game, tasks, seen_positions);
        ++game_no;
    }

    XLOGF(INFO,
          "Collected {} distinct positions from {} games ({} duplicates skipped before any "
          "search). Searching up to {} at a time, {} NN requests in flight each.",
          tasks.size(), game_no, skipped_duplicates, FLAGS_analyze_parallel_positions,
          FLAGS_analyze_max_parallelism);

    // Pass 2 (GPU): fan the searches out.
    folly::coro::blockingWait(
        run_position_analysis(analyze_fn, tasks, out).scheduleOn(&thread_pool));

    XLOGF(INFO,
          "External-game analysis complete: {} games, {} positions analyzed, {} duplicate "
          "positions skipped (deep search avoided).",
          game_no, tasks.size(), skipped_duplicates);
}

void analyze(EvaluationFunction const& analyze_fn, EvaluationFunction const& play_fn,
             bool separate_player, Variant variant) {
    Board board = make_mode_board(variant);
    folly::CPUThreadPoolExecutor thread_pool(FLAGS_j);

    std::ofstream out(FLAGS_analyze_output);
    if (!out) {
        XLOGF(ERR, "Failed to open analyze output file: {}", FLAGS_analyze_output);
        return;
    }

    if (separate_player) {
        XLOGF(INFO,
              "Analyzing game: model1 oracle {} visits/position, model2 player {} visits/move, "
              "up to {} moves, {} variant -> {}",
              FLAGS_analyze_samples, FLAGS_analyze_play_samples, FLAGS_analyze_moves, FLAGS_variant,
              FLAGS_analyze_output);
    } else {
        XLOGF(
            INFO,
            "Analyzing self-play game: {} visits/position, chunk {}, up to {} moves, {} variant -> {}",
            FLAGS_analyze_samples, FLAGS_analyze_chunk, FLAGS_analyze_moves, FLAGS_variant,
            FLAGS_analyze_output);
    }

    folly::coro::blockingWait(
        analyze_game(analyze_fn, play_fn, separate_player, board, out).scheduleOn(&thread_pool));

    XLOG(INFO, "Analysis complete.");
}

int main(int argc, char** argv) {
    // If no arguments are provided (only program name), print usage and exit.
    if (argc == 1) {
        XLOG(ERR, "No arguments provided.");
        std::cout << get_usage_message() << std::endl;
        return 1;
    }

    gflags::SetUsageMessage(get_usage_message());
    gflags::ParseCommandLineFlags(&argc, &argv, true);

    auto parsed_variant = parse_variant(FLAGS_variant);
    validate_game_dims();
    if (!parsed_variant) {
        XLOGF(ERR, "Unsupported variant: {}", FLAGS_variant);
        return 1;
    }
    Variant variant = *parsed_variant;

    Logger logger;
    std::unique_ptr<nv::IRuntime> runtime{nv::createInferRuntime(logger)};

    if (!runtime) {
        XLOG(ERR, "Failed to create TensorRT runtime. CUDA may be not available or out of memory.");
        return 1;
    }

    Mode mode;
    if (FLAGS_ranking != "") {
        mode = Mode::Ranking;
    } else if (FLAGS_interactive) {
        mode = Mode::Interactive;
    } else if (FLAGS_analyze) {
        mode = Mode::Analyze;
    } else if (FLAGS_model2.empty()) {
        // If only one model is provided, generate training data with self-play.
        // This is called from the training script, it is not intended to be used
        // directly.
        mode = Mode::Train;
    } else {
        // If two models are provided, evaluate them against each other.
        // The key output is the win/loss/draw record.
        mode = Mode::Evaluate;
    }

    // Validate arguments for the selected mode
    if (mode == Mode::Ranking) {
        if (!FLAGS_model1.empty() || !FLAGS_model2.empty()) {
            XLOG(ERR, "Ranking mode does not support --model1 or --model2.");
            return 1;
        }
        if (FLAGS_interactive) {
            XLOG(ERR, "Specified --interactive and --ranking.");
            return 1;
        }
    } else if (mode == Mode::Interactive) {
        if (FLAGS_model1.empty()) {
            XLOG(ERR, "Interactive mode requires --model1.");
            return 1;
        }
        if (!FLAGS_model2.empty()) {
            XLOG(ERR, "Interactive mode does not support --model2.");
            return 1;
        }
#ifndef GUI_ENABLED
        if (FLAGS_gui) {
            XLOG(ERR,
                 "GUI support not available. This build was compiled without SFML. Install "
                 "libsfml-dev and rebuild to enable GUI support.");
            return 1;
        }
#endif
    } else if (mode == Mode::Analyze) {
        if (FLAGS_model1.empty()) {
            XLOG(ERR, "Analyze mode requires --model1 (the strong analysis oracle).");
            return 1;
        }
        // --model2 is optional here: when given, it is the (typically weaker) player used
        // for move selection, while --model1 stays the deep analysis oracle.
    }

    EvaluationFunction eval_fn1, eval_fn2;
    if (!FLAGS_model1.empty()) {
        eval_fn1 = create_and_validate_model(*runtime, FLAGS_model1, mode);
    }
    if (!FLAGS_model2.empty()) {
        eval_fn2 = create_and_validate_model(*runtime, FLAGS_model2, mode);
    }

    auto start = std::chrono::high_resolution_clock::now();

    if (mode == Mode::Ranking) {
        ranking(*runtime, variant);
    } else if (mode == Mode::Interactive) {
        interactive(eval_fn1, variant);
    } else if (mode == Mode::Evaluate) {
        evaluate(eval_fn1, eval_fn2, variant);
    } else if (mode == Mode::Train) {
        train(eval_fn1, variant);
    } else if (mode == Mode::Analyze) {
        if (!FLAGS_analyze_game_file.empty()) {
            analyze_external_games(eval_fn1);
        } else {
            bool separate_player = !FLAGS_model2.empty();
            analyze(eval_fn1, separate_player ? eval_fn2 : eval_fn1, separate_player, variant);
        }
    }

    auto stop = std::chrono::high_resolution_clock::now();
    XLOGF(INFO, "Completed in {} seconds.",
          std::chrono::duration_cast<std::chrono::seconds>(stop - start).count());
    return 0;
}
