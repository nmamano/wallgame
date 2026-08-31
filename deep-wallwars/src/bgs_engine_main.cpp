#include <NvInfer.h>
#include <NvInferRuntime.h>
#include <folly/executors/CPUThreadPoolExecutor.h>
#include <folly/io/async/AsyncPipe.h>
#include <folly/io/async/AsyncSocketException.h>
#include <folly/io/async/EventBase.h>
#include <folly/logging/xlog.h>
#include <gflags/gflags.h>

#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>

#include "batched_model.hpp"
#include "batched_model_policy.hpp"
#include "bgs_session.hpp"
#include "cached_policy.hpp"
#include "mcts.hpp"
#include "request_dispatcher.hpp"
#include "simple_policy.hpp"
#include "tensorrt_model.hpp"

namespace nv = nvinfer1;

// ============================================================================
// Command-line Flags
// ============================================================================

DEFINE_string(model, "", "Path to TensorRT model file (.trt) or 'simple' for simple policy");
DEFINE_string(batch_stats_output, "",
              "Optional fail-if-existing JSON file written after all requests drain");
DEFINE_bool(policy_probe_details, false,
            "Include offline policy-parity details in evaluate responses");
DEFINE_bool(search_diagnostics, false,
            "Include offline root/PV/terminal and self-play-target evidence");
DEFINE_bool(terminal_after_first_action_shortcut, false,
            "Diagnostic A/B: treat a terminal first action as terminal inside MCTS (default off)");
DEFINE_int32(samples, 1000, "Number of MCTS samples per move");
DEFINE_int32(parallel_samples, 32, "Max parallel MCTS samples (controls GPU batch utilization)");
DEFINE_uint32(seed, 42, "Random seed for MCTS");
DEFINE_uint64(cache_size, 100'000, "Size of the MCTS evaluation cache");
DEFINE_int32(model_rows, 8, "Model rows (for --model=simple)");
DEFINE_int32(model_columns, 8, "Model columns (for --model=simple)");
DEFINE_int32(thread_pool_size, 12, "Number of threads in the executor pool");
DEFINE_double(root_noise_factor, MCTS::Options{}.noise_factor,
              "Fraction of Dirichlet noise mixed into the root priors, in [0, 1]. "
              "0 leaves the policy head untouched, which is what a 1-sample search needs "
              "to be policy-only");
DEFINE_bool(losing_fallback, false,
            "Play the naive policy instead of the search once the position is hopeless. OFF unless "
            "asked for: there is no numeric threshold that means 'disabled', because root_value() "
            "legitimately reaches -1. On its own it uses --losing_fallback_eval's default");
DEFINE_double(losing_fallback_eval, bgs::BgsEngineConfig::kDefaultLosingFallbackEval,
              "How bad the position has to be, from the mover's own perspective, before "
              "--losing_fallback takes over. In [-1, 0]. Passing it EXPLICITLY requires "
              "--losing_fallback; on its own it is rejected rather than ignored");

// Simple policy options
DEFINE_double(move_prior, 0.3, "Move prior of simple agent");
DEFINE_double(good_move, 1.5, "Good move bias of simple agent");
DEFINE_double(bad_move, 0.75, "Bad move bias of simple agent");

// ============================================================================
// TensorRT Logger
// ============================================================================

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

// ============================================================================
// Async Stdin Reader
// ============================================================================

/**
 * Asynchronous line reader for stdin using Folly's AsyncPipeReader.
 *
 * Reads stdin asynchronously and invokes a callback for each complete line.
 * This enables the engine to process multiple BGS requests concurrently.
 */
class StdinLineReader : public folly::AsyncReader::ReadCallback {
public:
    using LineCallback = std::function<void(std::string)>;

    StdinLineReader(folly::EventBase* evb, LineCallback on_line, std::function<void()> on_eof)
        : evb_(evb), on_line_(std::move(on_line)), on_eof_(std::move(on_eof)) {}

    void getReadBuffer(void** bufReturn, size_t* lenReturn) override {
        // Provide a buffer for reading
        *bufReturn = read_buffer_;
        *lenReturn = sizeof(read_buffer_);
    }

    void readDataAvailable(size_t len) noexcept override {
        // Append new data to line buffer
        line_buffer_.append(read_buffer_, len);

        // Process complete lines
        size_t pos;
        while ((pos = line_buffer_.find('\n')) != std::string::npos) {
            std::string line = line_buffer_.substr(0, pos);
            line_buffer_.erase(0, pos + 1);

            // Trim carriage return if present (Windows line endings)
            if (!line.empty() && line.back() == '\r') {
                line.pop_back();
            }

            // Skip empty lines
            if (!line.empty()) {
                on_line_(std::move(line));
            }
        }
    }

    void readEOF() noexcept override {
        XLOG(INFO, "Stdin EOF received");
        // Process any remaining data as a final line
        if (!line_buffer_.empty()) {
            on_line_(std::move(line_buffer_));
            line_buffer_.clear();
        }
        on_eof_();
    }

    void readErr(const folly::AsyncSocketException& ex) noexcept override {
        XLOGF(ERR, "Stdin read error: {}", ex.what());
        on_eof_();
    }

private:
    folly::EventBase* evb_;
    LineCallback on_line_;
    std::function<void()> on_eof_;
    char read_buffer_[4096];
    std::string line_buffer_;
};

// ============================================================================
// Thread-safe Response Writer
// ============================================================================

class ResponseWriter {
public:
    void write(nlohmann::json const& response) {
        std::lock_guard<std::mutex> lock(mutex_);
        std::cout << response.dump() << "\n";
        std::cout.flush();
    }

private:
    std::mutex mutex_;
};

// ============================================================================
// Main
// ============================================================================

int main(int argc, char** argv) {
    gflags::SetUsageMessage(
        "Deep Wallwars V3 BGS Engine\n\n"
        "Usage: deep_ww_bgs_engine --model <path.trt|simple> [options]\n\n"
        "This program implements the V3 Bot Game Session (BGS) protocol.\n"
        "It reads JSON-lines from stdin and writes responses to stdout.\n"
        "Multiple concurrent sessions are supported (up to 256).\n\n"
        "Required:\n"
        "  --model PATH      Path to TensorRT model file (.trt) or 'simple'\n\n"
        "Options:\n"
        "  --samples N       MCTS samples per move (default: 1000)\n"
        "  --seed N          Base random seed for MCTS (default: 42)\n"
        "  --cache_size N    Evaluation cache size (default: 100000)\n"
        "  --thread_pool_size N  Thread pool size (default: 12)\n"
        "  --root_noise_factor N  Dirichlet noise fraction mixed into the root priors,\n"
        "                    in [0, 1]; 0 leaves the policy head untouched\n"
        "  --losing_fallback  Play the naive policy once the position is hopeless\n"
        "                    (default: off; on its own it uses the default threshold)\n"
        "  --losing_fallback_eval N  How bad it has to get first, in [-1, 0] (default: -0.9).\n"
        "                    Passing this explicitly REQUIRES --losing_fallback: a threshold\n"
        "                    with no switch is refused at startup, not ignored\n\n"
        "Simple Policy Options (used by --model=simple AND by the losing fallback):\n"
        "  --move_prior N    Likelihood of choosing a pawn move (default: 0.3)\n"
        "  --good_move N     Bias for moves closer to goal (default: 1.5)\n"
        "  --bad_move N      Bias for moves farther from goal (default: 0.75)\n"
        "  --model_rows N    Model rows (default: 8)\n"
        "  --model_columns N Model columns (default: 8)\n");

    gflags::ParseCommandLineFlags(&argc, &argv, true);
    if (FLAGS_terminal_after_first_action_shortcut && !FLAGS_search_diagnostics) {
        std::cerr << "Error: --terminal_after_first_action_shortcut requires "
                     "--search_diagnostics\n";
        return 2;
    }

    // Checked before anything is built, because the value is mixed into every session's root priors
    // and a silently-wrong one would look like a search that plays badly rather than a bad flag.
    if (!std::isfinite(FLAGS_root_noise_factor) || FLAGS_root_noise_factor < 0.0 ||
        FLAGS_root_noise_factor > 1.0) {
        XLOGF(ERR, "Invalid --root_noise_factor: {}", FLAGS_root_noise_factor);
        std::cerr << "Error: --root_noise_factor must be finite and within [0, 1]\n";
        return 1;
    }

    // Bounded ABOVE by 0 on purpose: a positive threshold would mean "abandon the search while
    // winning", which is only ever a sign error, and it would be invisible in play until someone
    // wondered why the bot had stopped trying. Checked whether or not the fallback is enabled, so a
    // typo cannot sit unnoticed in a config until the day someone turns the feature on.
    if (!std::isfinite(FLAGS_losing_fallback_eval) || FLAGS_losing_fallback_eval < -1.0 ||
        FLAGS_losing_fallback_eval > 0.0) {
        XLOGF(ERR, "Invalid --losing_fallback_eval: {}", FLAGS_losing_fallback_eval);
        std::cerr << "Error: --losing_fallback_eval must be finite and within [-1, 0]\n";
        return 1;
    }

    // FAIL CLOSED on a threshold given without the switch. That combination is a config that LOOKS
    // configured and does nothing - the same silent-downgrade shape as a bot with no engine command -
    // and refusing to start is the only version of it anyone notices.
    if (!gflags::GetCommandLineFlagInfoOrDie("losing_fallback_eval").is_default &&
        !FLAGS_losing_fallback) {
        XLOG(ERR, "--losing_fallback_eval given without --losing_fallback");
        std::cerr << "Error: --losing_fallback_eval has no effect without --losing_fallback; "
                     "pass both or neither\n";
        return 1;
    }
    if (!FLAGS_batch_stats_output.empty() &&
        std::filesystem::exists(FLAGS_batch_stats_output)) {
        XLOGF(ERR, "Batch stats output already exists: {}", FLAGS_batch_stats_output);
        std::cerr << "Error: refusing to overwrite batch stats output\n";
        return 1;
    }

    try {
        // Create evaluation function
        EvaluationFunction eval_fn;
        std::shared_ptr<BatchedModel> batch_stats_model;
        int model_rows = FLAGS_model_rows;
        int model_columns = FLAGS_model_columns;

        if (FLAGS_model == "simple") {
            XLOG(INFO, "Using simple policy");
            eval_fn = SimplePolicy(FLAGS_move_prior, FLAGS_good_move, FLAGS_bad_move);
        } else {
            // Create TensorRT runtime
            Logger logger;
            std::unique_ptr<nv::IRuntime> runtime{nv::createInferRuntime(logger)};

            if (!runtime) {
                XLOG(ERR, "Failed to create TensorRT runtime");
                std::cerr << "Error: Failed to create TensorRT runtime\n";
                return 1;
            }

            if (FLAGS_model.empty()) {
                XLOG(ERR, "Error: --model flag is required");
                std::cerr << "Error: --model flag is required\n";
                return 1;
            }

            // Load TensorRT model
            std::ifstream model_file(FLAGS_model, std::ios::binary);
            if (!model_file) {
                XLOGF(ERR, "Failed to open model file: {}", FLAGS_model);
                std::cerr << "Error: Failed to open model file: " << FLAGS_model << "\n";
                return 1;
            }

            XLOGF(INFO, "Loading TensorRT engine from: {}", FLAGS_model);

            std::shared_ptr<nv::ICudaEngine> engine;
            try {
                engine = load_serialized_engine(*runtime, model_file);
            } catch (std::exception const& e) {
                XLOGF(ERR, "Failed to load TensorRT engine: {}", e.what());
                std::cerr << "Error: Failed to load TensorRT engine: " << e.what() << "\n";
                return 1;
            }

            if (!engine) {
                XLOG(ERR, "Failed to load TensorRT engine");
                std::cerr << "Error: Failed to load TensorRT engine\n";
                return 1;
            }

            // Create batched model
            std::vector<std::unique_ptr<Model>> models;
            auto tensor_model = std::make_unique<TensorRTModel>(engine);
            model_rows = tensor_model->rows();
            model_columns = tensor_model->columns();
            models.push_back(std::move(tensor_model));

            constexpr int kBatchedModelQueueSize = 4096;
            auto batched_model = std::make_shared<BatchedModel>(
                std::move(models), kBatchedModelQueueSize);
            batch_stats_model = batched_model;

            BatchedModelPolicy batched_model_policy(std::move(batched_model));
            eval_fn = CachedPolicy(std::move(batched_model_policy), FLAGS_cache_size);
        }

        XLOGF(INFO, "Model dimensions: {}x{}", model_rows, model_columns);

        // Configure BGS engine
        bgs::BgsEngineConfig config;
        config.samples_per_move = FLAGS_samples;
        config.max_parallel_samples = FLAGS_parallel_samples;
        config.base_seed = FLAGS_seed;
        config.model_rows = model_rows;
        config.model_columns = model_columns;
        config.root_noise_factor = static_cast<float>(FLAGS_root_noise_factor);
        config.policy_probe_details = FLAGS_policy_probe_details;
        config.search_diagnostics = FLAGS_search_diagnostics;
        config.terminal_after_first_action_shortcut =
            FLAGS_terminal_after_first_action_shortcut;
        // Left EMPTY unless asked for. The optional is the enablement, so there is no number that
        // could accidentally mean "on".
        if (FLAGS_losing_fallback) {
            config.losing_fallback_eval = static_cast<float>(FLAGS_losing_fallback_eval);
        }
        // The simple-agent flags do double duty: they configure --model=simple AND the naive policy
        // the losing fallback plays. Same knobs, same meaning of "naive".
        config.naive_move_prior = static_cast<float>(FLAGS_move_prior);
        config.naive_good_move_bias = static_cast<float>(FLAGS_good_move);
        config.naive_bad_move_bias = static_cast<float>(FLAGS_bad_move);

        // Create session manager
        bgs::SessionManager session_manager(eval_fn, config);

        // Create thread pool for MCTS sampling
        auto thread_pool = std::make_shared<folly::CPUThreadPoolExecutor>(
            FLAGS_thread_pool_size);

        // Create response writer
        ResponseWriter response_writer;

        // Create event base for async I/O
        folly::EventBase evb;

        // Declared AFTER session_manager, config and response_writer, so that
        // reverse-order destruction drains it before any of them go away. The
        // explicit drain() below the loop is the real guarantee; this ordering
        // corroborates it rather than being the only protection.
        bgs::RequestDispatcher dispatcher{
            session_manager, config, thread_pool,
            [&response_writer](nlohmann::json const& response) {
                response_writer.write(response);
                XLOGF(DBG, "Sent response: {}", response.dump());
            }};

        // Create stdin reader callback
        auto on_line = [&](std::string line) {
            // Parse JSON
            nlohmann::json request;
            try {
                request = nlohmann::json::parse(line);
            } catch (std::exception const& e) {
                XLOGF(ERR, "Failed to parse JSON: {}", e.what());
                return;
            }

            XLOGF(DBG, "Received request: {}", request.dump());

            // Launches a coroutine and returns at once, so the event loop keeps
            // reading stdin and no worker is ever blocked waiting on the pool it
            // is running on. See RequestDispatcher for what that used to cost.
            dispatcher.dispatch(std::move(request));
        };

        auto on_eof = [&]() { evb.terminateLoopSoon(); };

        // Set up async stdin reading
        StdinLineReader stdin_reader(&evb, on_line, on_eof);

        // Create AsyncPipeReader for stdin (fd 0)
        auto stdin_pipe = folly::AsyncPipeReader::newReader(
            &evb, folly::NetworkSocket::fromFd(0));
        stdin_pipe->setReadCB(&stdin_reader);

        XLOG(INFO, "Deep Wallwars V3 BGS Engine started");
        XLOGF(INFO,
              "Configuration: samples={}, parallel={}, threads={}, cache={}, root_noise={}, "
              "losing_fallback={}",
              FLAGS_samples, FLAGS_parallel_samples, FLAGS_thread_pool_size, FLAGS_cache_size,
              FLAGS_root_noise_factor,
              // Prints the effective state, not the flag: "off" is what the other two bots must show.
              config.losing_fallback_eval
                  ? std::to_string(*config.losing_fallback_eval)
                  : std::string{"off"});

        // Run event loop
        evb.loopForever();

        // Cleanup
        stdin_pipe->setReadCB(nullptr);
        stdin_pipe.reset();

        // Finish the requests that were still running when stdin closed, BEFORE
        // response_writer, session_manager, config or the pool are torn down.
        // Without this the pool destructor was the only thing joining the
        // handlers, and it runs after response_writer is already gone.
        XLOGF(INFO, "Draining {} in-flight request(s)", dispatcher.in_flight());
        dispatcher.drain();

        if (!FLAGS_batch_stats_output.empty()) {
            if (!batch_stats_model) {
                throw std::runtime_error("batch stats require a TensorRT model");
            }
            auto const inferences = batch_stats_model->total_inferences();
            auto const batches = batch_stats_model->total_batches();
            nlohmann::json const stats{
                {"schema", "wallgame-bgs-batch-stats-v1"},
                {"model", FLAGS_model},
                {"inferences", inferences},
                {"batches", batches},
                {"inferencesPerBatch",
                 batches == 0 ? 0.0 : static_cast<double>(inferences) / batches},
            };
            std::filesystem::path const output{FLAGS_batch_stats_output};
            std::filesystem::path const temporary = output.string() + ".tmp";
            if (std::filesystem::exists(temporary)) {
                throw std::runtime_error("batch stats temporary output already exists");
            }
            {
                std::ofstream stream{temporary, std::ios::out | std::ios::trunc};
                stream.exceptions(std::ios::failbit | std::ios::badbit);
                stream << stats.dump(2) << '\n';
                stream.flush();
            }
            // create_hard_link is the atomic fail-if-existing publish step on the
            // Linux runner. rename() would overwrite a file created after the
            // startup check and turn two runs into one unreadable artifact.
            std::filesystem::create_hard_link(temporary, output);
            std::filesystem::remove(temporary);
            XLOGF(INFO, "Wrote batch stats: {} inferences / {} batches ({:.3f} per batch)",
                  inferences, batches,
                  batches == 0 ? 0.0 : static_cast<double>(inferences) / batches);
        }

        XLOG(INFO, "Deep Wallwars V3 BGS Engine shutting down");
        return 0;

    } catch (std::exception const& e) {
        XLOGF(ERR, "Fatal error: {}", e.what());
        std::cerr << "Fatal error: " << e.what() << "\n";
        return 1;
    }
}
