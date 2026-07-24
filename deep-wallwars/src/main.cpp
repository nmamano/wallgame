#include <NvInfer.h>
#include <NvInferRuntime.h>
#include <folly/executors/CPUThreadPoolExecutor.h>
#include <folly/experimental/coro/BlockingWait.h>
#include <folly/logging/xlog.h>
#include <gflags/gflags.h>

#include <algorithm>
#include <chrono>
#include <fstream>
#include <iostream>
#include <memory>
#include <ranges>
#include <sstream>
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

DEFINE_int32(game_columns, 0,
             "Effective game columns, embedded in the -columns/-rows model frame with padding "
             "walls (0 = same as -columns). Applies to training, evaluation and ranking modes.");
DEFINE_int32(game_rows, 0, "Effective game rows (0 = same as -rows)");

DEFINE_int32(games, 100, "Number of games to play");
DEFINE_int32(start_game, 1, "Starting game number for output file naming (for resuming)");
DEFINE_int32(samples, 500, "Number of MCTS samples per action");
DEFINE_int32(j, 8, "Number of threads");

DEFINE_double(move_prior, 0.3, "Move prior of simple agent");
DEFINE_double(good_move, 1.5, "Good move bias of simple agent");
DEFINE_double(bad_move, 0.75, "Bad move bias of simple agent");

DEFINE_bool(interactive, false, "Enable interactive play against the AI");
DEFINE_bool(gui, false, "Use GUI instead of console for interactive mode");

DEFINE_string(ranking, "", "Folder of *.trt models to rank against each other");
DEFINE_int32(tournaments, 10, "Number of tournaments to run for ranking");
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
    TrainingDataPrinter training_data_printer(FLAGS_output, 0.5);

    folly::CPUThreadPoolExecutor thread_pool(FLAGS_j);

    XLOGF(INFO, "Created thread pool with {} threads (FLAGS_j = {})", thread_pool.numThreads(),
          FLAGS_j);

    folly::coro::blockingWait(training_play(board, FLAGS_games,
                                            {
                                                .model1 = eval_fn,
                                                .model2 = eval_fn,
                                                .samples = FLAGS_samples,
                                                .start_game = FLAGS_start_game,
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
    std::map<std::filesystem::file_time_type, std::filesystem::path> model_paths;
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

    auto recorders =
        folly::coro::blockingWait(ranking_play(board, {.models = std::move(models),
                                                       .output_folder = ranking_folder,
                                                       .samples = FLAGS_samples,
                                                       .games_per_matchup = FLAGS_games,
                                                       .num_tournaments = FLAGS_tournaments,
                                                       .seed = FLAGS_seed})
                                      .scheduleOn(&thread_pool));

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

        NodeInfo const info = mcts.root_info();
        Cell const cat = board.position(turn.player);

        nlohmann::json record;
        record["move_index"] = move_index;
        record["player"] = turn.player == Player::Red ? "red" : "blue";
        record["variant"] = std::string(variant_name(board.variant()));
        record["columns"] = board.columns();
        record["rows"] = board.rows();
        record["cat"] = {{"col", cat.column}, {"row", cat.row}};
        record["root_q"] = info.q_value;
        record["num_legal_actions"] = static_cast<int>(info.edges.size());
        record["total_visits"] = mcts.root_samples();

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
        if (board.winner() != Winner::Undecided) {
            break;  // first action decided the game; skip the (arbitrary) second action
        }
        board.do_action(turn.player, best->second);
        turn = {other_player(turn.player), Turn::First};
    }

    co_return;
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
        bool separate_player = !FLAGS_model2.empty();
        analyze(eval_fn1, separate_player ? eval_fn2 : eval_fn1, separate_player, variant);
    }

    auto stop = std::chrono::high_resolution_clock::now();
    XLOGF(INFO, "Completed in {} seconds.",
          std::chrono::duration_cast<std::chrono::seconds>(stop - start).count());
    return 0;
}
