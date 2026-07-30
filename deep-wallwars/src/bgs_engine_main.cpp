#include <NvInfer.h>
#include <NvInferRuntime.h>
#include <folly/executors/CPUThreadPoolExecutor.h>
#include <folly/io/async/AsyncPipe.h>
#include <folly/io/async/AsyncSocketException.h>
#include <folly/io/async/EventBase.h>
#include <folly/logging/xlog.h>
#include <gflags/gflags.h>

#include <cmath>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
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
        "                    in [0, 1]; 0 leaves the policy head untouched\n\n"
        "Simple Policy Options (when --model=simple):\n"
        "  --move_prior N    Likelihood of choosing a pawn move (default: 0.3)\n"
        "  --good_move N     Bias for moves closer to goal (default: 1.5)\n"
        "  --bad_move N      Bias for moves farther from goal (default: 0.75)\n"
        "  --model_rows N    Model rows (default: 8)\n"
        "  --model_columns N Model columns (default: 8)\n");

    gflags::ParseCommandLineFlags(&argc, &argv, true);

    // Checked before anything is built, because the value is mixed into every session's root priors
    // and a silently-wrong one would look like a search that plays badly rather than a bad flag.
    if (!std::isfinite(FLAGS_root_noise_factor) || FLAGS_root_noise_factor < 0.0 ||
        FLAGS_root_noise_factor > 1.0) {
        XLOGF(ERR, "Invalid --root_noise_factor: {}", FLAGS_root_noise_factor);
        std::cerr << "Error: --root_noise_factor must be finite and within [0, 1]\n";
        return 1;
    }

    try {
        // Create evaluation function
        EvaluationFunction eval_fn;
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
              "Configuration: samples={}, parallel={}, threads={}, cache={}, root_noise={}",
              FLAGS_samples, FLAGS_parallel_samples, FLAGS_thread_pool_size, FLAGS_cache_size,
              FLAGS_root_noise_factor);

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

        XLOG(INFO, "Deep Wallwars V3 BGS Engine shutting down");
        return 0;

    } catch (std::exception const& e) {
        XLOGF(ERR, "Fatal error: {}", e.what());
        std::cerr << "Fatal error: " << e.what() << "\n";
        return 1;
    }
}
