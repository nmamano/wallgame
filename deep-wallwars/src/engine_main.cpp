#include <NvInfer.h>
#include <NvInferRuntime.h>
#include <folly/logging/xlog.h>
#include <gflags/gflags.h>

#include <fstream>
#include <iostream>
#include <memory>

#include "batched_model.hpp"
#include "batched_model_policy.hpp"
#include "cached_policy.hpp"
#include "engine_adapter.hpp"
#include "simple_policy.hpp"
#include "tensorrt_model.hpp"

namespace nv = nvinfer1;

// ============================================================================
// Command-line Flags
// ============================================================================

DEFINE_string(model, "", "Path to TensorRT model file (.trt) or 'simple' for simple policy");
DEFINE_int32(think_time, 5, "Thinking time in seconds");
DEFINE_int32(samples, 500, "Number of MCTS samples per move (overrides think time)");
DEFINE_uint32(seed, 42, "Random seed for MCTS");
DEFINE_uint64(cache_size, 100'000, "Size of the MCTS evaluation cache");

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
// Main
// ============================================================================

int main(int argc, char** argv) {
    gflags::SetUsageMessage(
        "Deep Wallwars Engine Adapter for Official Custom-Bot Client\n\n"
        "Usage: deep_ww_engine --model <path.trt|simple> [options]\n\n"
        "This program reads a JSON request from stdin and writes a JSON response to stdout.\n"
        "It is designed to be called by the official custom-bot client.\n\n"
        "Required:\n"
        "  --model PATH      Path to TensorRT model file (.trt) or 'simple' for simple policy\n\n"
        "Options:\n"
        "  --think_time N    Thinking time in seconds (default: 5)\n"
        "  --samples N       MCTS samples per move (default: 500, overrides think_time)\n"
        "  --seed N          Random seed for MCTS (default: 42)\n"
        "  --cache_size N    MCTS evaluation cache size (default: 100000)\n\n"
        "Simple Policy Options (when --model=simple):\n"
        "  --move_prior N    Likelihood of choosing a pawn move (default: 0.3)\n"
        "  --good_move N     Bias for pawn moves closer to goal (default: 1.5)\n"
        "  --bad_move N      Bias for pawn moves farther from goal (default: 0.75)\n\n"
        "Supported Configurations:\n"
        "  - Variant: Classic or Standard\n"
        "  - Board size: 8x8 only\n");

    gflags::ParseCommandLineFlags(&argc, &argv, true);

    try {
        // Create evaluation function
        EvaluationFunction eval_fn;

        if (FLAGS_model == "simple") {
            // Simple policy doesn't need TensorRT
            XLOG(INFO, "Using simple policy");
            eval_fn = SimplePolicy(FLAGS_move_prior, FLAGS_good_move, FLAGS_bad_move);
        } else {
            // Create TensorRT runtime only when needed
            Logger logger;
            std::unique_ptr<nv::IRuntime> runtime{nv::createInferRuntime(logger)};

            if (!runtime) {
                XLOG(ERR, "Failed to create TensorRT runtime");
                std::cerr << "Error: Failed to create TensorRT runtime. "
                          << "CUDA may not be available or out of memory.\n";
                return 1;
            }

            if (FLAGS_model.empty()) {
                XLOG(ERR, "Error: --model flag is required");
                std::cerr << "Error: --model flag is required (path to .trt file or 'simple')\n";
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

            // Create model (single instance for engine mode)
            std::vector<std::unique_ptr<Model>> models;
            models.push_back(std::make_unique<TensorRTModel>(engine));

            constexpr int kBatchedModelQueueSize = 4096;
            auto batched_model = std::make_shared<BatchedModel>(
                std::move(models),
                kBatchedModelQueueSize);

            BatchedModelPolicy batched_model_policy(std::move(batched_model));
            eval_fn = CachedPolicy(std::move(batched_model_policy), FLAGS_cache_size);
        }

        // Set up engine config
        engine_adapter::EngineConfig config;
        config.model_path = FLAGS_model;
        config.think_time_seconds = FLAGS_think_time;
        config.samples = FLAGS_samples;
        config.seed = FLAGS_seed;

        // Read request from stdin
        std::string input;
        std::string line;
        while (std::getline(std::cin, line)) {
            input += line;
        }

        if (input.empty()) {
            XLOG(ERR, "No input received on stdin");
            std::cerr << "Error: No engine request provided on stdin\n";
            return 1;
        }

        XLOGF(DBG, "Received request: {}", input);

        // Parse JSON
        engine_adapter::json request;
        try {
            request = engine_adapter::json::parse(input);
        } catch (std::exception const& e) {
            XLOGF(ERR, "Failed to parse JSON: {}", e.what());
            std::cerr << "Error: Failed to parse JSON request: " << e.what() << "\n";
            return 1;
        }

        // Handle request
        engine_adapter::json response = engine_adapter::handle_engine_request(
            request,
            eval_fn,
            config);

        // Write response to stdout
        std::string response_str = response.dump();
        std::cout << response_str << "\n";

        XLOGF(DBG, "Sent response: {}", response_str);

        return 0;

    } catch (std::exception const& e) {
        XLOGF(ERR, "Fatal error: {}", e.what());
        std::cerr << "Fatal error: " << e.what() << "\n";
        return 1;
    }
}
