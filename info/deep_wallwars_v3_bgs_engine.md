# Implementation Plan: Deep-Wallwars V3 BGS Engine

## Overview

Create a new `deep_ww_bgs_engine` binary implementing the V3 Bot Game Session (BGS) protocol - a long-lived process that maintains persistent MCTS trees across moves.

### Key Differences from V2 (`engine_main.cpp`)

| Aspect | V2 | V3 |
|--------|----|----|
| Lifetime | Single request → exit | Long-lived JSON-lines loop |
| MCTS tree | Fresh per move | Persistent across session |
| Sessions | N/A | Up to 256 concurrent BGS |
| State | Stateless | Ply tracking per session |
| I/O | Blocking stdin read | **Async stdin with parallel processing** |

---

## Architecture: Async Request Handling

### Why Async?

The bot client (`engine-runner.ts:230-232`) enforces:
- **One pending request per BGS** (sequential within a session)
- **Multiple BGSs can have pending requests simultaneously** (parallel across sessions)

This means a **blocking main loop is wrong**. If BGS A is doing MCTS sampling, requests for BGS B would be blocked. We need async I/O.

### Threading Model

```
Main Thread (Async I/O):
  - Async stdin reading (Folly AsyncPipe or AsyncReader)
  - Parse incoming JSON requests
  - Dispatch each request as a coroutine to thread pool
  - Async stdout writing (mutex protected)

Thread Pool (12 threads, shared):
  - MCTS sampling coroutines for each BGS
  - Multiple BGSs processed concurrently
  - Coroutines sleep during GPU inference

GPU Batching (per model):
  - Shared batching queue across all BGSs
  - Model inference batches from multiple BGSs together
```

### Request Flow (Async)

```cpp
// Main loop (async)
while (!eof) {
    std::string line = co_await async_readline(stdin);
    json request = json::parse(line);

    // Schedule handler - DON'T await, let it run in parallel
    folly::coro::co_schedule(
        handle_request(request, session_manager, eval_fn, config)
            .thenValue([](json response) {
                write_response_locked(response);  // stdout mutex
            })
    );
}

// Each request handler is a coroutine
folly::coro::Task<json> handle_request(...) {
    // May suspend during MCTS sampling
    co_return response;
}
```

### Response Ordering

Responses may arrive out of order (BGS B finishes before BGS A). The bot client matches by `bgsId` field, so this is fine.

---

## Files to Create

### 1. `src/bgs_engine_main.cpp` - Main Entry Point

Key responsibilities:
- TensorRT/model initialization (from `engine_main.cpp`)
- Create shared thread pool, BatchedModel, CachedPolicy
- **Async stdin reading loop** (Folly coroutines)
- Dispatch requests to handler coroutines
- **Mutex-protected stdout writing**

```cpp
// Async reading approach options:
// Option A: Folly AsyncPipeReader for stdin
// Option B: Dedicated reader thread + folly::UnboundedQueue
// Option C: poll/select with non-blocking stdin

// Response writing (needs mutex since responses may come out of order)
std::mutex stdout_mutex;
void write_response(json const& response) {
    std::lock_guard<std::mutex> lock(stdout_mutex);
    std::cout << response.dump() << "\n";
    std::cout.flush();
}
```

### 2. `src/bgs_session.hpp` - Session Management

```cpp
struct BgsSession {
    std::string bgs_id;
    std::unique_ptr<MCTS> mcts;
    int ply;  // 0 = initial, increments per move
    PaddingConfig padding_config;
    int game_rows, game_columns;

    // Per-session mutex (for sequential request handling within BGS)
    std::mutex request_mutex;
};

class SessionManager {
    static constexpr int kMaxSessions = 256;
    std::unordered_map<std::string, std::unique_ptr<BgsSession>> m_sessions;
    std::shared_mutex m_sessions_mutex;  // Reader-writer lock for session map

    // Thread-safe lifecycle methods
    std::pair<bool, std::string> create_session(...);
    std::pair<bool, std::string> end_session(std::string const& bgs_id);
    BgsSession* get_session(std::string const& bgs_id);
};
```

### 3. `src/bgs_session.cpp` - Session Implementation

Request handlers as coroutines:
```cpp
folly::coro::Task<json> handle_start_game_session(...);
folly::coro::Task<json> handle_end_game_session(...);
folly::coro::Task<json> handle_evaluate_position(...);  // co_await sample()
folly::coro::Task<json> handle_apply_move(...);
```

---

## Files to Modify

### 4. `src/mcts.hpp` / `src/mcts.cpp` - Add Peek Methods

**Critical**: `evaluate_position` must NOT modify the tree. Add methods to get best action WITHOUT committing:

```cpp
// In mcts.hpp, add to public section:
std::optional<Action> peek_best_action() const;
std::optional<Move> peek_best_move() const;

// In mcts.cpp:
std::optional<Action> MCTS::peek_best_action() const {
    if (m_root->edges.empty()) return {};
    // Note: get_best_edge needs a const overload or const_cast workaround
    TreeEdge const& te = get_best_edge(*m_root);
    return te.action;
}

std::optional<Move> MCTS::peek_best_move() const {
    // Get best first action
    auto action1 = peek_best_action();
    if (!action1) return {};

    // Find the child node for this action (if explored)
    auto const& edge1 = *std::ranges::find_if(
        m_root->edges, [&](auto& e) { return e.action == *action1; });

    TreeNode* child = edge1.child.load();
    if (!child || child->edges.empty()) {
        // Child not explored - return action1 with a default second action
        // (wall placement or other valid action)
        return Move{*action1, find_any_valid_second_action(...)};
    }

    // Get best second action from child's perspective (without modifying)
    TreeEdge const& edge2 = get_best_edge(*child);  // Need const or temp copy
    return Move{*action1, edge2.action};
}
```

**Implementation notes:**
- Need to make `get_best_edge` work in const context (add const overload or use const_cast)
- If child node wasn't explored, need fallback for second action
- The second action lookup doesn't require sampling - just picks highest-value explored edge

### 5. `src/engine_adapter.hpp` / `src/engine_adapter.cpp`

**What's V2-specific vs reusable:**

| Function | V2-Specific? | Notes |
|----------|--------------|-------|
| `create_padding_config()` | **Reusable** | Generic |
| `transform_to_model/game()` | **Reusable** | Coordinate transforms |
| `place_padding_walls()` | **Reusable** | Generic |
| `transform_move_notation()` | **Reusable** | Model→game coords |
| `validate_request()` | V2-specific | Checks V2 JSON structure |
| `convert_state_to_board()` | V2-specific | V2 `state_json` format |
| `find_best_move()` | Mostly reusable | MCTS sampling |
| `handle_engine_request()` | V2-specific | V2 request routing |

**New functions needed for V3:**

```cpp
// Parse V3 BgsConfig to Board (similar to convert_state_to_board but V3 format)
std::tuple<Board, Turn, PaddingConfig> convert_bgs_config_to_board(
    json const& bgs_config,  // BgsConfig: {variant, boardWidth, boardHeight, initialState}
    int model_rows,
    int model_columns);

// Parse standard notation move, transform game→model coords
std::optional<Move> parse_move_notation(
    std::string const& notation,
    int game_rows,
    PaddingConfig const& config);
```

### 6. `CMakeLists.txt` - Add New Target

```cmake
# V3 BGS Engine executable
add_executable(deep_ww_bgs_engine
    src/bgs_engine_main.cpp
    src/bgs_session.cpp
    # Shared sources (engine_adapter, mcts, etc.)
)
target_link_libraries(deep_ww_bgs_engine PRIVATE core gflags)
```

---

## Request Handling Flow

### `start_game_session`

1. Acquire session map write lock
2. Validate `bgs_id` not in use and session count < 256
3. Parse `BgsConfig` (variant, boardWidth, boardHeight, initialState)
4. Create `PaddingConfig` via `create_padding_config()`
5. Convert initial state to `Board` via new `convert_bgs_config_to_board()`
6. Create `MCTS` with board and shared `eval_fn`
7. Store `BgsSession` with ply=0
8. Release lock, return `game_session_started`

### `evaluate_position`

1. Acquire session (read lock on map, then lock session's request_mutex)
2. Validate `expectedPly` == session.ply
3. Run MCTS sampling: `co_await mcts->sample(1000)` (coroutine suspends here)
4. Get evaluation: `mcts->root_value()` (from current player's POV)
5. Get best move: `mcts->peek_best_move()` (**does NOT commit**)
6. Transform move notation using `transform_move_notation()`
7. Convert eval to P1 perspective (negate if ply is odd)
8. Release locks, return `evaluate_response`

### `apply_move`

1. Acquire session (lock session's request_mutex)
2. Validate `expectedPly` == session.ply
3. Parse move from standard notation via `parse_move_notation()`
4. Advance tree: `mcts->force_move(move)` (preserves subtree)
5. Increment `session.ply`
6. Release lock, return `move_applied`

### `end_game_session`

1. Acquire session map write lock
2. Delete session (MCTS destructor cleans up tree via `delete_subtree`)
3. Remove from map
4. Return `game_session_ended`

---

## Configuration (from protocol doc)

```cpp
constexpr int kMaxSessions = 256;
constexpr int kSamplesPerMove = 1000;
constexpr int kMaxParallelSamples = 4;  // Per BGS
constexpr int kThreadPoolSize = 12;
constexpr int kBatchSize = 256;
constexpr uint64_t kCacheSize = 100'000;
```

---

## Async I/O Implementation: Folly AsyncPipe

Use Folly's async I/O primitives for true non-blocking stdin:

```cpp
#include <folly/io/async/AsyncPipe.h>
#include <folly/io/async/EventBase.h>

class StdinReader : public folly::AsyncReader::ReadCallback {
    folly::EventBase* evb_;
    std::function<void(std::string)> onLine_;
    std::string buffer_;

public:
    void getReadBuffer(void** bufReturn, size_t* lenReturn) override;
    void readDataAvailable(size_t len) noexcept override;
    void readEOF() noexcept override;
    void readErr(const folly::AsyncSocketException& ex) noexcept override;
};

// Main setup
folly::EventBase evb;
auto stdinPipe = folly::AsyncPipeReader::newReader(&evb, 0);  // fd 0 = stdin
stdinPipe->setReadCB(&reader);

// Event loop runs async, dispatches requests to coroutines
evb.loopForever();
```

Key benefits:
- True async I/O - no thread blocking on stdin
- Full parallelism across BGSs
- Natural integration with Folly's coroutine infrastructure

---

## Implementation Order

1. **Add MCTS peek methods** (`mcts.hpp/cpp`) - Required before session handling
2. **Add V3 state conversion** (`engine_adapter.hpp/cpp`) - `convert_bgs_config_to_board`, `parse_move_notation`
3. **Create BgsSession/SessionManager** (`bgs_session.hpp/cpp`) - Core session management
4. **Create bgs_engine_main.cpp** - Start with Option C (blocking stdin), async handlers
5. **Update CMakeLists.txt** - Build new target
6. **Test with official-custom-bot-client** - Basic protocol compliance
7. **Upgrade to async stdin** (Option A or B) - Full parallelism

---

## Verification Plan

1. **Unit tests**: Test `peek_best_action`, `parse_move_notation`, `convert_bgs_config_to_board`
2. **Single session test**: start → evaluate → apply → evaluate → ... → end
3. **Concurrent session test**: Multiple BGS IDs simultaneously
4. **Ply validation**: Test expectedPly mismatch error handling
5. **Tree reuse verification**: Compare sampling time first move vs later moves (should be faster)
6. **Stress test**: 256 concurrent sessions

---

## Critical Files Reference

| File | Purpose |
|------|---------|
| `deep-wallwars/src/engine_main.cpp` | Model loading pattern to reuse |
| `deep-wallwars/src/mcts.hpp:100-108` | `commit_to_action`, `force_action`, `force_move` |
| `deep-wallwars/src/mcts.cpp:274-306` | `force_action`/`force_move` implementation |
| `deep-wallwars/src/engine_adapter.cpp:18-68` | Padding functions (reusable) |
| `deep-wallwars/src/engine_adapter.cpp:376+` | `convert_state_to_board` (pattern for V3) |
| `official-custom-bot-client/src/engine-runner.ts` | Bot client's async request handling |
| `dummy-engine/src/index.ts` | V3 reference implementation |
| `shared/contracts/custom-bot-protocol.ts` | Message type definitions |

---

## Decisions Made

1. **Async I/O**: Use Folly AsyncPipeReader for true non-blocking stdin
2. **peek_best_move()**: Implement inside MCTS class (cleaner API)
3. **engine_adapter**: V3 will add new functions alongside existing V2 code; reusable functions shared
