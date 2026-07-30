#pragma once

#include <folly/Executor.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>

#include "bgs_session.hpp"

namespace bgs {

/**
 * Runs BGS protocol requests on an executor without ever blocking one of its
 * threads.
 *
 * WHY THIS EXISTS. The engine's stdin loop used to hand each request to the
 * pool like this:
 *
 *     pool->add([]{ blockingWait(handle_bgs_request(...).scheduleOn(pool)); });
 *
 * That blocks a pool thread while the coroutine it is waiting for queues up
 * behind it ON THE SAME POOL. N concurrent requests block N threads, and the N
 * coroutines they are waiting for can never be scheduled. Measured on the
 * 4090 desktop at 1caaa61: with --thread_pool_size 4, three concurrent
 * evaluate_position requests answered in 258 ms and FOUR wedged the process
 * permanently, with the same cliff at pool sizes 2, 8 and 12. Production runs
 * --thread_pool_size 4, so four ordinary simultaneous games were enough. A
 * wedged engine also cannot exit, because the pool destructor joins threads
 * that are blocked forever.
 *
 * Handlers are launched as coroutines here instead. A suspended handler holds no
 * thread, so there is no self-dependency and no cliff.
 *
 * LIFETIME. The dispatcher borrows the manager, the config and the sink. Its
 * destructor drains, so no in-flight handler can outlive them - construct it
 * AFTER all three and destroy it BEFORE them.
 *
 * The executor is held by SHARED pointer rather than borrowed, which matters for
 * the draining destructor: if the executor could die first, queued handlers would
 * never run and drain() would wait forever. Sharing ownership makes that
 * impossible regardless of declaration order.
 */
class RequestDispatcher {
public:
    /// Receives one finished response. Called from an executor thread, possibly
    /// concurrently, so it must be thread-safe.
    using ResponseSink = std::function<void(json const&)>;

    RequestDispatcher(SessionManager& manager,
                      BgsEngineConfig const& config,
                      std::shared_ptr<folly::Executor> executor,
                      ResponseSink sink);

    /// Drains, so that no handler can reference this object after it is gone.
    ~RequestDispatcher();

    RequestDispatcher(RequestDispatcher const&) = delete;
    RequestDispatcher& operator=(RequestDispatcher const&) = delete;

    /**
     * Launch one request. Returns immediately without waiting for the response,
     * so it is safe to call from the event-base thread that reads stdin.
     *
     * Every dispatched request produces exactly one call to the sink: the
     * handler's response, or an explicit error object if the handler threw. A
     * request is never silently dropped.
     */
    void dispatch(json request);

    /**
     * Block until every dispatched handler has finished AND its response has
     * been handed to the sink.
     *
     * MUST NOT be called from a thread of `executor` - it would wait on work
     * that needs the very thread it is holding, which is the bug this class
     * exists to remove.
     */
    void drain();

    /**
     * drain() with a deadline. Returns false if work was still outstanding when
     * the timeout expired.
     *
     * Exists so a test can FAIL a deadlock instead of hanging the whole suite.
     * Note that it can only report the problem, not recover from it: a genuinely
     * wedged executor cannot be destroyed either, so the caller still needs an
     * external timeout to terminate the process.
     */
    bool drain_for(std::chrono::milliseconds timeout);

    /// Requests launched but not yet finished.
    int in_flight() const;

private:
    /**
     * Owns one unit of the in-flight count.
     *
     * Captured by the handler lambda rather than decremented at the end of the
     * coroutine body, so the count is released on EVERY exit path - normal
     * return, exception, or the task being destroyed without ever running. A
     * missed decrement would strand drain() forever, which in a test is
     * indistinguishable from the deadlock we are fixing.
     */
    class Ticket {
    public:
        explicit Ticket(RequestDispatcher* owner) : m_owner{owner} {}
        Ticket(Ticket&& other) noexcept : m_owner{other.m_owner} { other.m_owner = nullptr; }
        Ticket(Ticket const&) = delete;
        Ticket& operator=(Ticket const&) = delete;
        ~Ticket() { release(); }

        /// Idempotent, so the body can release early and the destructor is a
        /// backstop rather than a double decrement.
        void release() {
            if (m_owner) {
                m_owner->finish_one();
                m_owner = nullptr;
            }
        }

    private:
        RequestDispatcher* m_owner;
    };

    void finish_one();

    SessionManager& m_manager;
    BgsEngineConfig const& m_config;
    std::shared_ptr<folly::Executor> m_executor;
    ResponseSink m_sink;

    mutable std::mutex m_mutex;
    std::condition_variable m_idle;
    int m_in_flight = 0;
};

}  // namespace bgs
