# Deep Wallwars BGS Engine Interface

This document specifies the Bot Game Session (BGS) adapter interface for the Deep Wallwars C++ engine. The BGS engine is a **long-lived process** that manages multiple concurrent game sessions with persistent MCTS trees.

## Overview

The BGS engine replaces the V2 stateless engine (spawn-per-move) with a V3 stateful architecture:

| Aspect | V2 (Old) | V3 BGS (New) |
|--------|----------|--------------|
| Lifecycle | Spawn per move request | Long-lived process |
| State | Stateless (full game state in request) | Stateful sessions with MCTS persistence |
| Tree | Discarded after each move | Preserved and pruned across moves |
| Concurrency | Single game at a time | Up to 256 concurrent sessions |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      BGS Engine Process                          │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Shared Resources                       │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │   │
│  │  │ ThreadPool  │  │  BatchedModel │  │ EvalCache (LRU) │   │   │
│  │  │  (~12 thr)  │  │  (TensorRT)   │  │  (per variant)  │   │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                 Active Sessions (max 256)                │    │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐                  │    │
│  │  │ BGS #1  │  │ BGS #2  │  │ BGS #N  │  ...             │    │
│  │  │ ─────── │  │ ─────── │  │ ─────── │                  │    │
│  │  │ Board   │  │ Board   │  │ Board   │                  │    │
│  │  │ MCTS    │  │ MCTS    │  │ MCTS    │                  │    │
│  │  │ Ply     │  │ Ply     │  │ Ply     │                  │    │
│  │  └─────────┘  └─────────┘  └─────────┘                  │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  stdin ──────► JSON Parser ──► Request Router                    │
│                                     │                            │
│  stdout ◄───── JSON Writer ◄── Response Handler                  │
└─────────────────────────────────────────────────────────────────┘
```

## BgsSession Struct

Each active game session maintains the following state:

```cpp
struct BgsSession {
    // Identity
    std::string bgs_id;           // Unique session identifier

    // Game State
    Board board;                  // Current board position
    Variant variant;              // Classic or Standard
    Turn current_turn;            // Whose turn (Red/Blue, First/Second action)
    int ply;                      // Move counter (0 = initial, increments after moves)

    // MCTS Tree
    std::unique_ptr<MCTS> mcts;   // Persistent search tree

    // Configuration
    PaddingConfig padding;        // Board embedding for model input
    int samples_per_eval;         // MCTS samples for evaluate_position (default: 1000)
};
```

### Session Lifecycle

```
┌─────────────┐     start_game_session     ┌─────────────┐
│   (empty)   │ ──────────────────────────► │ Initializing│
└─────────────┘                             └──────┬──────┘
                                                   │
                              Board + MCTS created │
                                                   ▼
┌─────────────┐     end_game_session       ┌─────────────┐
│   (deleted) │ ◄────────────────────────── │    Ready    │
└─────────────┘                             └──────┬──────┘
                                                   │
                         evaluate_position         │ apply_move
                         (returns bestMove)        │ (updates state)
                                                   │
                                            ┌──────┴──────┐
                                            │    Ready    │
                                            └─────────────┘
```

## Shared Resources

### Thread Pool

```cpp
// Fixed thread pool shared across all sessions
// Threads sleep during GPU inference, allowing multiplexing
folly::CPUThreadPoolExecutor thread_pool{12};  // ~12 threads

// Each BGS can use up to 4 threads for parallel MCTS samples
constexpr int MAX_PARALLELISM_PER_SESSION = 4;
```

### Batched Model (TensorRT)

```cpp
// Single BatchedModel instance shared across all sessions
// Models loaded to GPU at engine startup
struct SharedModel {
    std::shared_ptr<BatchedModel> batched_model;
    int model_rows;    // e.g., 8
    int model_columns; // e.g., 8
};

// One model per variant (if different model architectures)
std::map<Variant, SharedModel> models;
```

### Evaluation Cache (LRU)

```cpp
// Sharded LRU cache per variant for position evaluations
// Shared across all sessions of the same variant
std::map<Variant, std::shared_ptr<CachedPolicy>> eval_caches;

// Cache configuration
constexpr size_t CACHE_CAPACITY = 100'000;  // Entries per cache
constexpr size_t CACHE_SHARDS = 16;         // For parallel access
```

## JSON Protocol (stdin/stdout)

The BGS engine communicates via **JSON-lines protocol**: one complete JSON object per line on stdin/stdout.

### Request Messages (stdin)

#### start_game_session

Creates a new BGS with initial board state.

```json
{
    "type": "start_game_session",
    "bgsId": "game_abc123",
    "botId": "deep-wallwars-v1",
    "config": {
        "variant": "standard",
        "boardWidth": 9,
        "boardHeight": 9,
        "initialState": {
            "type": "standard",
            "pawns": {
                "p1": { "cat": { "col": 0, "row": 8 }, "mouse": { "col": 8, "row": 8 } },
                "p2": { "cat": { "col": 8, "row": 0 }, "mouse": { "col": 0, "row": 0 } }
            },
            "walls": []
        }
    }
}
```

#### evaluate_position

Runs MCTS search and returns best move + evaluation.

```json
{
    "type": "evaluate_position",
    "bgsId": "game_abc123",
    "expectedPly": 0
}
```

#### apply_move

Applies a move to the session state (updates board, prunes MCTS tree).

```json
{
    "type": "apply_move",
    "bgsId": "game_abc123",
    "expectedPly": 0,
    "move": "Bc8-c7 Bm0-1"
}
```

#### end_game_session

Terminates session, frees resources.

```json
{
    "type": "end_game_session",
    "bgsId": "game_abc123"
}
```

### Response Messages (stdout)

#### game_session_started

```json
{
    "type": "game_session_started",
    "bgsId": "game_abc123",
    "success": true,
    "error": ""
}
```

Error response (e.g., at capacity):

```json
{
    "type": "game_session_started",
    "bgsId": "game_abc123",
    "success": false,
    "error": "Maximum session limit reached (256)"
}
```

#### evaluate_response

```json
{
    "type": "evaluate_response",
    "bgsId": "game_abc123",
    "ply": 0,
    "bestMove": "Bc8-c7 Bm0-1",
    "evaluation": 0.15,
    "success": true,
    "error": ""
}
```

**Evaluation semantics:**
- Range: `[-1.0, +1.0]`
- Always from P1's perspective: `+1.0` = P1 winning, `-1.0` = P2 winning
- `0.0` = even position

#### move_applied

```json
{
    "type": "move_applied",
    "bgsId": "game_abc123",
    "ply": 1,
    "success": true,
    "error": ""
}
```

#### game_session_ended

```json
{
    "type": "game_session_ended",
    "bgsId": "game_abc123",
    "success": true,
    "error": ""
}
```

### Error Handling

All responses include `success` and `error` fields. Common errors:

| Error | Cause |
|-------|-------|
| `"Session not found"` | Invalid `bgsId` |
| `"Maximum session limit reached (256)"` | At capacity |
| `"Ply mismatch: expected N, got M"` | Stale/out-of-order request |
| `"Invalid move notation"` | Malformed move string |
| `"Illegal move"` | Move violates game rules |
| `"Unsupported variant"` | Model doesn't support requested variant |

## MCTS Tree Reuse Strategy

The key performance optimization in V3 is **MCTS tree persistence**. Instead of discarding the search tree after each move, we prune it to preserve relevant search work.

### apply_move Flow

```cpp
void BgsSession::apply_move(const Move& move) {
    // 1. Apply move to board state
    board.take_step(move.first_action);
    board.take_step(move.second_action);

    // 2. Update turn
    current_turn = next_turn(current_turn);

    // 3. Prune MCTS tree
    // Find the child node corresponding to the played move
    // Make that child the new root, delete sibling subtrees
    mcts->force_move(move);

    // 4. Increment ply
    ply++;
}
```

### Tree Pruning Benefits

When `apply_move` is called with a move that was previously searched:

1. **Child becomes root**: The subtree for the played move becomes the new root
2. **Siblings deleted**: Alternative move subtrees are freed
3. **Work preserved**: All search work in the chosen subtree is retained
4. **Memory reclaimed**: Only relevant tree portions stay in memory

```
Before apply_move(A):          After apply_move(A):

        [Root]                       [New Root]
       /   |   \                     (was child A)
      A    B    C                    /     |
     / \   |   / \                  D      E
    D   E  F  G   H                / \    / \
   ...                           ...    ...

   (Subtrees B, C deleted)
```

### Opponent Move Handling

When the opponent plays a move:

- **If searched**: The existing subtree is promoted (fast, preserves work)
- **If unsearched**: A new tree node is created (rare for well-searched positions)

```cpp
// force_move handles both cases:
// - If move was explored: promotes existing child
// - If move was unexplored: creates new root node
mcts->force_move(opponent_move);
```

## Capacity and Resource Limits

| Resource | Limit | Rationale |
|----------|-------|-----------|
| Max concurrent sessions | 256 | Matches self-play capacity |
| Threads per session | 4 | MCTS parallelism |
| Total threads | 12 | Thread pool size |
| Samples per evaluation | 1000 | Quality vs latency tradeoff |
| Eval cache entries | 100,000 | Memory budget per variant |
| Message size | 64 KB | Abuse protection |

## Initialization Sequence

```cpp
int main() {
    // 1. Load models to GPU (expensive, done once)
    auto standard_model = load_tensorrt_model("models/standard.trt");
    auto classic_model = load_tensorrt_model("models/classic.trt");

    // 2. Create batched inference wrappers
    models[Variant::Standard] = {
        std::make_shared<BatchedModel>(standard_model, batch_size),
        8, 8  // model dimensions
    };
    models[Variant::Classic] = {
        std::make_shared<BatchedModel>(classic_model, batch_size),
        8, 8
    };

    // 3. Create evaluation caches
    for (auto& [variant, model] : models) {
        auto batched_policy = make_batched_model_policy(model.batched_model);
        eval_caches[variant] = make_cached_policy(batched_policy, CACHE_CAPACITY);
    }

    // 4. Initialize session storage
    std::unordered_map<std::string, BgsSession> active_sessions;

    // 5. Enter main loop
    run_json_loop(active_sessions);
}
```

## Implementation Notes

### Board Padding

The engine supports variable board sizes by embedding smaller boards into the fixed model dimensions:

```cpp
PaddingConfig compute_padding(int game_cols, int game_rows,
                               int model_cols, int model_rows,
                               Variant variant) {
    // Classic: embed at bottom-center
    // Standard: embed at top-left
    // Returns offsets for coordinate translation
}
```

### Move Notation

Moves use the standard Wallwars notation:

```
Pawn moves: Pc<col>-<dir>    (e.g., "Rc4-u" = Red cat moves up from col 4)
            Pm<row>-<dir>    (e.g., "Bm3-l" = Blue mouse moves left from row 3)
Wall moves: W<col><row><dir> (e.g., "W45r" = Wall at (4,5) going right)

Full move (2 actions): "<action1> <action2>"
```

### Variant Support

| Variant | Description | Model |
|---------|-------------|-------|
| `standard` | Cat + mouse per player, race to opposite corner | `standard.trt` |
| `classic` | Cat + home, capture opponent's cat | `classic.trt` |

### Concurrency Safety

- **Session map**: Protected by mutex for add/remove operations
- **Per-session state**: Each session accessed by one request at a time (protocol guarantees)
- **Shared resources**: Thread-safe by design (BatchedModel uses lock-free queue, cache is sharded)

## Future Extensions

1. **Survival variant**: Add support for 1v1 survival mode when model is trained
2. **Configurable samples**: Allow per-session sample count configuration
3. **Time-based search**: Support `think_time_ms` instead of fixed samples
4. **Pondering**: Continue searching during opponent's turn
5. **Opening book**: Skip MCTS for known opening positions

## Related Documents

- `info/v3_migration_plan.md` - V3 protocol migration overview
- `info/game_session_bot_protocol.md` - V3 BGS protocol specification
- `info/deep-wallwars-integration.md` - Deep Wallwars integration details
- `info/proactive_bot_protocol.md` - V2 protocol (deprecated)
