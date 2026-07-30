#include "request_dispatcher.hpp"

#include <folly/executors/CPUThreadPoolExecutor.h>

#include <atomic>
#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include "bgs_session.hpp"
#include "simple_policy.hpp"

using json = nlohmann::json;
using namespace bgs;
using namespace std::chrono_literals;

// ============================================================================
// Fixture
// ============================================================================

// Matches production. The deadlock these tests guard against appeared at
// exactly this many concurrent requests on the real engine.
constexpr int kPoolSize = 4;

// Above the ~112 threshold at which the engine can report a complete two-action
// move, so the handlers really run a search rather than short-circuiting on
// "No legal move available". SimplePolicy is a cheap heuristic, so this stays
// fast even multiplied by the request count.
constexpr int kSamples = 150;

// Every drain in this file is BOUNDED. An unbounded drain() turns a regression
// into a suite that hangs forever instead of a test that fails. The bound only
// buys a readable failure though - a wedged executor cannot be destroyed
// either, so these cases are also run under an external `timeout` in the gate.
constexpr auto kDrainBudget = 90s;

// Deliberately a local copy of the config builder in test/bgs_session.cpp rather
// than a shared header: it is fixture DATA, and that file carries several known
// failures that this slice is not touching.
static json make_standard_config(int width = 8, int height = 8) {
    json config;
    config["variant"] = "standard";
    config["boardWidth"] = width;
    config["boardHeight"] = height;
    config["initialState"]["pawns"]["p1"]["cat"] = {0, 0};
    config["initialState"]["pawns"]["p1"]["mouse"] = {height - 1, 0};
    config["initialState"]["pawns"]["p2"]["cat"] = {0, width - 1};
    config["initialState"]["pawns"]["p2"]["mouse"] = {height - 1, width - 1};
    config["initialState"]["walls"] = json::array();
    return config;
}

/// Thread-safe response collector - the sink is called from executor threads.
struct Collector {
    mutable std::mutex mutex;
    std::vector<json> responses;

    RequestDispatcher::ResponseSink sink() {
        return [this](json const& response) {
            std::lock_guard<std::mutex> lock(mutex);
            responses.push_back(response);
        };
    }

    std::size_t count() const {
        std::lock_guard<std::mutex> lock(mutex);
        return responses.size();
    }

    /// A stable copy to assert against, taken under the lock.
    std::vector<json> snapshot() const {
        std::lock_guard<std::mutex> lock(mutex);
        return responses;
    }
};

struct Fixture {
    BgsEngineConfig config;
    SessionManager manager;
    std::shared_ptr<folly::CPUThreadPoolExecutor> pool;
    Collector collector;
    RequestDispatcher dispatcher;

    explicit Fixture(int samples = kSamples)
        : config{make_config(samples)},
          manager{SimplePolicy{1.0, 1.0, 1.0}, config},
          pool{std::make_shared<folly::CPUThreadPoolExecutor>(kPoolSize)},
          dispatcher{manager, config, pool, collector.sink()} {}

    static BgsEngineConfig make_config(int samples) {
        BgsEngineConfig config;
        config.samples_per_move = samples;
        config.max_parallel_samples = 32;
        config.model_rows = 8;
        config.model_columns = 8;
        return config;
    }

    /// Bounded drain. REQUIRE on this rather than calling drain(), so a
    /// regression fails the case instead of hanging the suite.
    [[nodiscard]] bool drain_ready() { return dispatcher.drain_for(kDrainBudget); }

    void start_session(std::string const& bgs_id) {
        dispatcher.dispatch(json{{"type", "start_game_session"},
                                 {"bgsId", bgs_id},
                                 {"botId", "test-bot"},
                                 {"config", make_standard_config()}});
    }

    void evaluate(std::string const& bgs_id, int ply = 0) {
        dispatcher.dispatch(
            json{{"type", "evaluate_position"}, {"bgsId", bgs_id}, {"expectedPly", ply}});
    }

    void end_session(std::string const& bgs_id) {
        dispatcher.dispatch(json{{"type", "end_game_session"}, {"bgsId", bgs_id}});
    }
};

static std::size_t count_of_type(std::vector<json> const& responses, std::string const& type) {
    std::size_t n = 0;
    for (json const& r : responses) {
        if (r.value("type", std::string{}) == type) {
            ++n;
        }
    }
    return n;
}

// ============================================================================
// D1: the deadlock regression
// ============================================================================

// THE regression guard for the defect this class was extracted to fix. The old
// dispatch blocked a pool thread per request while the work queued behind it on
// the same pool, so this wedged permanently once the request count reached the
// pool size. Measured on the real engine at 1caaa61: 3 concurrent requests
// answered in 258 ms, 4 answered never.
//
// Shaped as VALID protocol traffic: all 144 sessions are created and confirmed
// FIRST, so that a "Session not found" caused by create/evaluate ordering can
// never be mistaken for coverage. Only then are the evaluates bulk-dispatched.
TEST_CASE("dispatcher - 144 concurrent evaluates all get answered", "[dispatcher]") {
    Fixture fx;
    constexpr int kRequests = 144;

    for (int i = 0; i < kRequests; ++i) {
        fx.start_session("bulk-" + std::to_string(i));
    }
    REQUIRE(fx.drain_ready());
    {
        // Every session must actually have STARTED, not merely have produced a
        // game_session_started object that says success=false.
        std::vector<json> const starts = fx.collector.snapshot();
        REQUIRE(count_of_type(starts, "game_session_started") == kRequests);
        for (json const& r : starts) {
            REQUIRE(r.value("success", false));
        }
    }
    REQUIRE(fx.manager.active_session_count() == kRequests);

    std::size_t const after_starts = fx.collector.count();

    // No waiting between these: every one of them is in flight at once, which is
    // far more than kPoolSize.
    for (int i = 0; i < kRequests; ++i) {
        fx.evaluate("bulk-" + std::to_string(i));
    }

    REQUIRE(fx.drain_ready());
    CHECK(fx.dispatcher.in_flight() == 0);

    std::vector<json> const responses = fx.collector.snapshot();
    CHECK(responses.size() == after_starts + kRequests);
    CHECK(count_of_type(responses, "evaluate_response") == kRequests);

    // Exactly one evaluate response per session, and each one must be a real
    // answer. Counting response OBJECTS would certify an engine that replies
    // "No legal move available" to all 144, and matching only on set size would
    // let an unexpected bgsId stand in for a missing expected one.
    std::unordered_map<std::string, int> per_session;
    for (json const& r : responses) {
        if (r.value("type", std::string{}) != "evaluate_response") {
            continue;
        }
        ++per_session[r.value("bgsId", std::string{})];
        CHECK(r.value("success", false));
        CHECK_FALSE(r.value("bestMove", std::string{}).empty());
    }
    for (int i = 0; i < kRequests; ++i) {
        std::string const expected = "bulk-" + std::to_string(i);
        CHECK(per_session[expected] == 1);
    }
    CHECK(per_session.size() == static_cast<std::size_t>(kRequests));
}

// ============================================================================
// D2: the per-session lock
// ============================================================================

// Concurrent requests on ONE session must serialize rather than deadlock or
// interleave. This is the path that used to hold a std::mutex across a co_await:
// evaluate_position suspends inside MCTS::sample, and folly may resume it on a
// different worker than the one that locked.
TEST_CASE("dispatcher - concurrent evaluates on one session serialize", "[dispatcher]") {
    Fixture fx;
    constexpr int kRequests = 16;

    fx.start_session("solo");
    REQUIRE(fx.drain_ready());

    // evaluate_position does not advance the ply, so all of these are legitimate
    // at ply 0 and every one of them should succeed.
    for (int i = 0; i < kRequests; ++i) {
        fx.evaluate("solo");
    }
    REQUIRE(fx.drain_ready());

    std::vector<json> const responses = fx.collector.snapshot();
    CHECK(count_of_type(responses, "evaluate_response") == kRequests);
    for (json const& r : responses) {
        if (r.value("type", std::string{}) != "evaluate_response") {
            continue;
        }
        CHECK(r.value("bgsId", std::string{}) == "solo");
        CHECK(r.value("ply", -1) == 0);
        // Serialized AND successful. Sixteen ply-mismatch errors would also be
        // sixteen responses, and would not show that the lock did its job.
        CHECK(r.value("success", false));
        CHECK_FALSE(r.value("bestMove", std::string{}).empty());
    }
}

// ============================================================================
// D3: session lifetime
// ============================================================================

// end_game_session used to be able to free the MCTS tree under an in-flight
// evaluate, because get_session handed out a raw pointer after releasing its
// shared_lock. Now the handler pins the session, so whichever request wins the
// lookup, BOTH get a coherent answer.
//
// Fresh session ids per iteration, because root Dirichlet noise is seeded from
// the bgsId - reusing one id would make repeated rounds identical by
// construction rather than exploring interleavings.
TEST_CASE("dispatcher - end_game_session racing evaluate stays coherent", "[dispatcher]") {
    Fixture fx;
    constexpr int kRounds = 50;

    for (int i = 0; i < kRounds; ++i) {
        std::string const bgs_id = "race-" + std::to_string(i);
        fx.start_session(bgs_id);
        REQUIRE(fx.drain_ready());

        // Both in flight together; either order is legal protocol-wise.
        fx.evaluate(bgs_id);
        fx.end_session(bgs_id);
        REQUIRE(fx.drain_ready());
    }

    std::vector<json> const responses = fx.collector.snapshot();

    // Every single request answered - none lost to a crash or a stranded slot.
    CHECK(count_of_type(responses, "game_session_started") == kRounds);
    CHECK(count_of_type(responses, "evaluate_response") == kRounds);
    CHECK(count_of_type(responses, "game_session_ended") == kRounds);
    CHECK(count_of_type(responses, "error") == 0);

    for (json const& r : responses) {
        std::string const type = r.value("type", std::string{});
        if (type == "game_session_started" || type == "game_session_ended") {
            // Counting the types is not enough. Starting and ending the session
            // must actually SUCCEED - a failed end would mean the session went
            // missing, which is the very thing this race tests for.
            CHECK(r.value("success", false));
        } else if (type == "evaluate_response") {
            // An evaluate that lost the race must say so explicitly rather than
            // returning a half-built answer.
            if (r.value("success", false)) {
                CHECK_FALSE(r.value("bestMove", std::string{}).empty());
            } else {
                CHECK_FALSE(r.value("error", std::string{}).empty());
            }
        }
    }
}

// ============================================================================
// Dispatcher contract
// ============================================================================

// A throwing handler must still answer and must still release its in-flight
// slot. A leaked slot would strand drain() forever, which is indistinguishable
// from the deadlock being fixed.
TEST_CASE("dispatcher - a handler that throws answers and releases its slot", "[dispatcher]") {
    Fixture fx;

    // No "type" field, so the router throws while reading it.
    fx.dispatcher.dispatch(json{{"bgsId", "malformed"}});
    REQUIRE(fx.drain_ready());

    CHECK(fx.dispatcher.in_flight() == 0);
    std::vector<json> const responses = fx.collector.snapshot();
    REQUIRE(responses.size() == 1);
    CHECK(responses[0].value("type", std::string{}) == "error");
    CHECK(responses[0].value("bgsId", std::string{}) == "malformed");
    CHECK_FALSE(responses[0].value("error", std::string{}).empty());
}

// An unknown request type is a protocol error, not an exception - it should come
// back as the router's own error response.
TEST_CASE("dispatcher - unknown request type answers with an error", "[dispatcher]") {
    Fixture fx;

    fx.dispatcher.dispatch(json{{"type", "not_a_real_request"}, {"bgsId", "weird"}});
    REQUIRE(fx.drain_ready());

    std::vector<json> const responses = fx.collector.snapshot();
    REQUIRE(responses.size() == 1);
    CHECK(responses[0].value("type", std::string{}) == "error");
    CHECK(responses[0].value("bgsId", std::string{}) == "weird");
}

// A THROWING SINK must not be retried. The dispatcher promises exactly one
// delivery attempt per request; treating a sink failure as a handler failure
// would call the same broken sink a second time with an error object, and would
// also make the response count meaningless.
TEST_CASE("dispatcher - a throwing sink is attempted once and does not strand drain",
          "[dispatcher]") {
    BgsEngineConfig config = Fixture::make_config(kSamples);
    SessionManager manager{SimplePolicy{1.0, 1.0, 1.0}, config};
    auto pool = std::make_shared<folly::CPUThreadPoolExecutor>(kPoolSize);

    std::atomic<int> attempts{0};
    RequestDispatcher dispatcher{manager, config, pool, [&attempts](json const&) {
                                     ++attempts;
                                     throw std::runtime_error("sink is broken");
                                 }};

    // A request that SUCCEEDS, so the throw can only come from the sink.
    dispatcher.dispatch(json{{"type", "start_game_session"},
                            {"bgsId", "throwing-sink"},
                            {"botId", "test-bot"},
                            {"config", make_standard_config()}});
    REQUIRE(dispatcher.drain_for(kDrainBudget));

    CHECK(attempts.load() == 1);
    CHECK(dispatcher.in_flight() == 0);
    // The handler still did its work; only delivery failed.
    CHECK(manager.active_session_count() == 1);
}

// drain() must not return until the sink has actually run, otherwise main could
// tear down the ResponseWriter while a handler was still writing to it.
TEST_CASE("dispatcher - drain waits for the sink, not just the handler", "[dispatcher]") {
    BgsEngineConfig config = Fixture::make_config(kSamples);
    SessionManager manager{SimplePolicy{1.0, 1.0, 1.0}, config};
    auto pool = std::make_shared<folly::CPUThreadPoolExecutor>(kPoolSize);

    std::atomic<int> sink_calls{0};
    {
        RequestDispatcher dispatcher{manager, config, pool,
                                     [&sink_calls](json const&) { ++sink_calls; }};
        for (int i = 0; i < 24; ++i) {
            dispatcher.dispatch(json{{"type", "start_game_session"},
                                     {"bgsId", "sink-" + std::to_string(i)},
                                     {"botId", "test-bot"},
                                     {"config", make_standard_config()}});
        }
        REQUIRE(dispatcher.drain_for(kDrainBudget));
        CHECK(sink_calls.load() == 24);
        CHECK(dispatcher.in_flight() == 0);
    }
    // Destructor drained too, so this stays true after the dispatcher is gone.
    CHECK(sink_calls.load() == 24);
}
