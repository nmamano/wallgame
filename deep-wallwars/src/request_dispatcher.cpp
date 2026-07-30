#include "request_dispatcher.hpp"

#include <folly/experimental/coro/Invoke.h>
#include <folly/experimental/coro/Task.h>
#include <folly/logging/xlog.h>

#include <utility>

namespace bgs {

/**
 * The one response shape used for a request that could not be handled at all.
 *
 * `bgsId` is read defensively: the request may be malformed in exactly the way
 * that made the handler throw, so it must not be able to throw again here.
 */
static json error_response(json const& request, std::string const& message) {
    std::string bgs_id;
    try {
        if (request.is_object()) {
            bgs_id = request.value("bgsId", std::string{});
        }
    } catch (...) {
        // Leave bgs_id empty rather than let response construction fail.
    }
    return json{{"type", "error"}, {"bgsId", bgs_id}, {"error", message}};
}

RequestDispatcher::RequestDispatcher(SessionManager& manager,
                                    BgsEngineConfig const& config,
                                    std::shared_ptr<folly::Executor> executor,
                                    ResponseSink sink)
    : m_manager{manager},
      m_config{config},
      m_executor{std::move(executor)},
      m_sink{std::move(sink)} {}

RequestDispatcher::~RequestDispatcher() {
    drain();
}

void RequestDispatcher::dispatch(json request) {
    // Counted BEFORE the task is created. If the count were incremented inside
    // the coroutine instead, a drain() racing the schedule could observe zero
    // and return while this request was still queued.
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        ++m_in_flight;
    }

    Ticket ticket{this};

    // co_invoke owns the lambda for the coroutine's whole lifetime, which is
    // what keeps `request` and `ticket` alive. Calling the lambda directly would
    // return a Task referring to a lambda that dies at the end of this
    // statement.
    folly::coro::co_invoke(
        [this, request = std::move(request),
         ticket = std::move(ticket)]() mutable -> folly::coro::Task<void> {
            // PRODUCTION of the response is separated from DELIVERY of it, so
            // that a throwing sink can never be mistaken for a handler error and
            // retried. Exactly one delivery is attempted per dispatched request.
            json response;
            try {
                response = co_await handle_bgs_request(m_manager, m_config, request);
            } catch (std::exception const& e) {
                XLOGF(ERR, "Handler error: {}", e.what());
                // Response-or-explicit-error: the peer is told something went
                // wrong rather than waiting forever on a request that silently
                // evaporated.
                response = error_response(request, std::string{"Handler error: "} + e.what());
            } catch (...) {
                XLOG(ERR, "Handler threw a non-std exception");
                response = error_response(request, "Handler error: unknown exception");
            }

            try {
                m_sink(response);
            } catch (std::exception const& sink_error) {
                // Logged, NOT retried - a second call would break the
                // exactly-once contract this class advertises.
                XLOGF(ERR, "Response sink failed: {}", sink_error.what());
            } catch (...) {
                XLOG(ERR, "Response sink threw a non-std exception");
            }

            // Released after the delivery attempt, so drain() cannot return
            // while a response is still being written. The destructor remains
            // the backstop for paths that never reach this line.
            ticket.release();
        })
        .scheduleOn(m_executor.get())
        .start();
}

void RequestDispatcher::drain() {
    std::unique_lock<std::mutex> lock(m_mutex);
    m_idle.wait(lock, [this] { return m_in_flight == 0; });
}

bool RequestDispatcher::drain_for(std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(m_mutex);
    return m_idle.wait_for(lock, timeout, [this] { return m_in_flight == 0; });
}

int RequestDispatcher::in_flight() const {
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_in_flight;
}

void RequestDispatcher::finish_one() {
    std::lock_guard<std::mutex> lock(m_mutex);
    // Loudly, not silently: a future ticket bug that double-released would drive
    // the count negative and turn drain() into a permanent wait, which is
    // indistinguishable from the deadlock this class exists to remove.
    XCHECK_GT(m_in_flight, 0, "RequestDispatcher in-flight count underflow");
    --m_in_flight;
    if (m_in_flight == 0) {
        m_idle.notify_all();
    }
}

}  // namespace bgs
