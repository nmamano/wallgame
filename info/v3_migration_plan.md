# Bot Protocol V2 → V3 Migration Plan

## Context

- `info/v3_migration_plan.md`: this doc.
- `info/proactive_bot_protocol.md`: the V2 protocol.
- `info/game_session_bot_protocol.md`: the V3 protocol.
- `info/evaluation_bar.md`: the eval bar feature design.
- `info/deep-wallwars-integration.md`: Deep Wallwars (engine) details.
- `info/generalized_variants.md`: game initial state types.

## Overview

Migrate from V2 "proactive bot protocol" to V3 "game session bot protocol". The key architectural change is from **stateless per-move engine spawning** to **stateful Bot Game Sessions (BGS)** with persistent engine processes.

### What Stays the Same (V2 → V3)

The **proactive connection model** is preserved:
- Bot clients connect to `/ws/custom-bot` with a `clientId`
- Clients send `attach` message with `bots` array
- Server sends `attached` confirmation
- Bots are discoverable in UI for users to play against
- Same `clientId` replaces existing connection

### What Changes (V2 → V3)

| Aspect | V2 (Delete) | V3 (New) |
|--------|-------------|----------|
| Engine lifecycle | Spawn per move | Long-lived process |
| State management | Stateless (full game state in each request) | Stateful BGS with MCTS tree persistence |
| Game messages | `request` (move/draw/eval) → `response` | BGS messages: `start_game_session`, `apply_move`, `evaluate_position`, `end_game_session` |
| Time control | Bot games have clocks | **No time control** (unlimited) |
| Draw handling | Client auto-declines | **Server auto-rejects** (no message to bot) |
| Eval bar | Ad-hoc eval requests | BGS history tracks all positions |

**Key insight**: The stateless CLI engine model is deleted. The proactive attachment stays.

### Scope
- ✅ Server backend (custom-bot-store, custom-bot-socket, game-socket, eval-socket)
- ✅ Official bot client (ws-client, engine-runner)
- ✅ Dummy engine (convert to stateful JSON-lines)
- ✅ Deep Wallwars adapter (new binary with parallel BGS support)
- ✅ Eval bar for bot games AND human vs human games
- ✅ Frontend (remove time control for bot games)

---

## Phase 1: V3 Protocol Types (Shared Contracts)

### Files to modify:
- `shared/contracts/custom-bot-protocol.ts` - Update to V3 message types
- `shared/custom-bot/engine-api.ts` - Update to V3 (same messages as server-client)

### What stays (attachment protocol):
- `AttachMessage` structure (just bump `protocolVersion` to 3)
- `AttachedMessage`, `AttachRejectedMessage` stay same
- `BotConfig` mostly same (remove `timeControls` from `VariantConfig`)
- `ListedBot`, `RecommendedBotEntry` stay same

### What changes (game protocol):

```typescript
// custom-bot-protocol.ts changes:

export const CUSTOM_BOT_PROTOCOL_VERSION = 3;  // Bump from 2

// BGS Configuration - reuses existing GameInitialState types from generalized_variants.md
export interface BgsConfig {
  variant: Variant;
  boardWidth: number;
  boardHeight: number;
  initialState: GameInitialState;  // Reuse existing type (StandardInitialState | ClassicInitialState | ...)
}

// IMPORTANT: As part of this migration, fix existing GameInitialState types to use
// explicit p1/p2 fields instead of Record<PlayerId, ...> for JSON safety.
// This affects shared/domain/game-types.ts:
//
// Before (suboptimal):
//   pawns: Record<PlayerId, { cat: Cell; mouse: Cell }>
//
// After (fixed):
//   pawns: { p1: { cat: Cell; mouse: Cell }; p2: { cat: Cell; mouse: Cell } }
//
// This fix should be applied to all *InitialState types (Standard, Classic, Survival).

// V3 Messages (same format server→client→engine)
export interface StartGameSessionMessage {
  type: "start_game_session";
  bgsId: string;
  botId: string;
  config: BgsConfig;
}

export interface GameSessionStartedMessage {
  type: "game_session_started";
  bgsId: string;
  success: boolean;
  error: string;
}

export interface EndGameSessionMessage {
  type: "end_game_session";
  bgsId: string;
}

export interface GameSessionEndedMessage {
  type: "game_session_ended";
  bgsId: string;
  success: boolean;
  error: string;
}

export interface EvaluatePositionMessage {
  type: "evaluate_position";
  bgsId: string;
  expectedPly: number;  // For ordering/staleness detection
}

export interface EvaluateResponseMessage {
  type: "evaluate_response";
  bgsId: string;
  ply: number;          // Echo back for correlation
  bestMove: string;
  evaluation: number;   // [-1, +1], always P1 perspective
  success: boolean;
  error: string;
}

export interface ApplyMoveMessage {
  type: "apply_move";
  bgsId: string;
  expectedPly: number;  // For ordering/staleness detection
  move: string;         // Standard notation
}

export interface MoveAppliedMessage {
  type: "move_applied";
  bgsId: string;
  ply: number;          // New ply after move applied
  success: boolean;
  error: string;
}
```

### BGS History Entry Semantics

```typescript
interface BgsHistoryEntry {
  ply: number;        // 0 = initial position, increments after each move
  evaluation: number; // Always P1 perspective: +1 = P1 winning, 0 = even, -1 = P2 winning
  bestMove: string;   // Best move for the side-to-move at this ply (standard notation)
}
```

**Key invariants:**
- `evaluation` is always from P1's perspective, regardless of whose turn it is
- `bestMove` is the recommended move for whoever is to move at that ply
- After move N is played, history entry at ply N+1 contains the evaluation of the resulting position

### V3 BotConfig changes:
- Remove `timeControls` from `VariantConfig` entirely (bot games have no time control)
- Keep `boardWidth`, `boardHeight`, `recommended` settings
- Bot game configs simply don't include time control—it's not `null`, it's absent

---

## Phase 2: Server BGS Infrastructure

### New file: `server/games/bgs-store.ts`

Create BGS state management:

```typescript
interface BgsHistoryEntry {
  ply: number;
  evaluation: number;
  bestMove: string;
}

interface BotGameSession {
  bgsId: string;
  botCompositeId: string;
  gameId: string;
  config: BgsConfig;
  status: "initializing" | "ready" | "ended";
  history: BgsHistoryEntry[];
  currentPly: number;
  pendingRequest: PendingBgsRequest | null;
}

// Public API
export function createBgs(bgsId, botCompositeId, config): BotGameSession;
export function getBgs(bgsId): BotGameSession | undefined;
export function endBgs(bgsId): void;
export function addHistoryEntry(bgsId, entry): void;
export function getBgsHistory(bgsId): BgsHistoryEntry[];
```

### Rewrite: `server/games/custom-bot-store.ts`

- Remove V2 request queue (`requestQueue`, `activeRequest`, `enqueueRequest`, `tryProcessNextRequest`)
- Add `activeBgsSessions: Set<string>` to track client's active BGS IDs
- Remove `protocolVersion` field—all clients are V3
- Keep: client registry, bot registry, connection management

---

## Phase 3: Server WebSocket V3 Handler

### Rewrite: `server/routes/custom-bot-socket.ts`

Delete all V2 request/response handling. Replace with V3 BGS message handlers.

Key changes:

1. **Attach handling**: Require `protocolVersion === 3`. Reject V2 clients.
2. **V3 message handlers**:
   - `handleGameSessionStarted()` - Mark BGS as ready
   - `handleGameSessionEnded()` - Clean up BGS
   - `handleEvaluateResponse()` - Validate `ply`, store in BGS history, trigger next action
   - `handleMoveApplied()` - Validate `ply`, confirm move applied

3. **V3 public API for game integration**:
```typescript
export async function startBgsSession(compositeId, bgsId, config): Promise<boolean>;
export async function endBgsSession(compositeId, bgsId): Promise<void>;
export async function requestEvaluation(compositeId, bgsId, expectedPly): Promise<EvaluateResponseMessage>;
export async function applyBgsMove(compositeId, bgsId, expectedPly, move): Promise<MoveAppliedMessage>;
```

4. **Timeout and error policy**:
   - **Timeout**: 10 seconds for all request types (`start_game_session`, `apply_move`, `evaluate_position`)
   - **No retries**: Errors or timeouts lead to immediate failure
   - **Bot game failure**: Server resigns the game on behalf of the bot
   - **Eval bar failure**: Toggle off + show error message to user
   - **Late responses** (after timeout or `end_game_session`): Silently discard

5. **Abuse protection**:
   - **Message size limit**: 64KB max (same as V2)
   - **Unexpected messages**: Track per client. Disconnect after 100 unexpected messages (messages that aren't valid responses to pending requests)
   - No rate limiting—protocol is strictly request/response

---

## Phase 4: Game Socket Bot Integration

### Update: `server/routes/game-socket.ts`

**V3 Bot Game Flow:**

1. **Game creation** → Create BGS, send `start_game_session`
2. **Get initial evaluation** → `evaluate_position` for starting position
3. **Bot's turn**:
   - Best move already known from history
   - Send `apply_move` with best move
   - Send `evaluate_position` for new position (human's POV)
4. **Human's turn**:
   - Wait for human move
   - Send `apply_move` with human's move
   - Send `evaluate_position` for new position (bot's POV)
5. **Game end** → Send `end_game_session`

**Draw handling**: Server auto-rejects (no message to bot)

**Takeback handling**: End BGS, start new BGS with same ID, replay moves

---

## Phase 5: Eval Socket Integration

### Major rewrite: `server/routes/eval-socket.ts`

**Current V2 design** (from `evaluation_bar.md`):
- Sends ad-hoc eval requests per position
- Eval requests go into bot's request queue
- No history tracking

**V3 design**:
- BGS-based: Server creates a BGS for the eval bar session
- BGS history: Server maintains evaluations for all positions
- When user turns on eval bar, server replays all moves to build history
- When new moves happen, server updates BGS history and broadcasts

### V3 Eval Flow:

1. **User turns on eval bar** → Server creates BGS (or reuses existing)
   - Bot games: BGS ID = `gameId` (already exists for bot player)
   - Human vs human: BGS ID = `gameId` (shared by both players and spectators)
   - Past replay: BGS ID = `gameId_username` (per-viewer, since multiple users may view the same replay independently)

2. **Initialize BGS history**:
   ```typescript
   async function initializeBgsHistory(bgsId: string, moves: Move[]) {
     // Get initial position evaluation (ply 0)
     const initialEval = await requestEvaluation(botId, bgsId, expectedPly: 0);
     addHistoryEntry(bgsId, { ply: 0, ...initialEval });

     // Replay each move
     for (let i = 0; i < moves.length; i++) {
       await applyBgsMove(botId, bgsId, expectedPly: i, moves[i]);
       const eval = await requestEvaluation(botId, bgsId, expectedPly: i + 1);
       addHistoryEntry(bgsId, { ply: i + 1, ...eval });
     }
   }
   ```

   **Ply validation**: If the response's `ply` doesn't match `expectedPly`, the server:
   - **Bot games**: Resigns the game on behalf of the bot
   - **Eval bar**: Toggles off + shows error message

3. **Send full history to client** when initialization completes

4. **Stream updates** as new moves happen:
   - Subscribe eval socket to game move events
   - When move made: `apply_move` + `evaluate_position` + broadcast update

5. **Close BGS** when:
   - **Live games (bot or human vs human)**: When the game ends. The frontend retains the history client-side so users can still view evaluations while on the game page.
   - **Replays**: Immediately after sending the full history to the client. The BGS is ephemeral—created to populate history, then closed.

### New message types (eval-protocol.ts):

```typescript
// V3: Server sends full history on connect
interface EvalHistoryMessage {
  type: "eval-history";
  entries: Array<{
    ply: number;
    evaluation: number;
    bestMove: string;
  }>;
}

// V3: Server streams updates
interface EvalUpdateMessage {
  type: "eval-update";
  ply: number;
  evaluation: number;
  bestMove: string;
}
```

### Shared BGS for human vs human games

When multiple viewers enable eval bar for the same game:
- **First viewer**: Creates BGS, initializes history (can take time for long games)
- **Subsequent viewers during initialization**: Must wait. UI shows "pending" state until initialization completes.
- **Subsequent viewers after initialization**: Immediately receive cached history
- **Viewer count tracking**: End BGS when game ends (not when viewers leave)

### Error handling for eval bar

- **Bot disconnect**: Toggle off + show error message. No re-homing to another bot.
- **Timeout during initialization**: Toggle off + show error message.
- **Timeout during streaming**: Toggle off + show error message (keep history received so far client-side).

---

## Phase 6: Bot Client V3

### Update: `official-custom-bot-client/src/ws-client.ts`

Major restructure for long-lived engine:

```typescript
class BotClientV3 {
  private engine: EngineProcess;

  async connect() {
    // Start engine ONCE at startup
    this.engine = await EngineProcess.spawn(this.engineCommand);
    // Then connect WebSocket
  }

  // V3: Pass-through messages to engine
  private async handleStartGameSession(msg) {
    const response = await this.engine.send(msg);
    this.ws.send(response);
  }

  private async handleEvaluatePosition(msg) {
    const response = await this.engine.send(msg);
    this.ws.send(response);
  }

  private async handleApplyMove(msg) {
    const response = await this.engine.send(msg);
    this.ws.send(response);
  }
}
```

### Update: `official-custom-bot-client/src/engine-runner.ts`

Replace per-move spawning with long-lived process:

```typescript
class EngineProcess {
  private proc: Subprocess;
  private pendingRequests: Map<string, Resolver>;

  static async spawn(command): Promise<EngineProcess>;

  async send(message: BgsRequestMessage): Promise<BgsResponseMessage> {
    // Write JSON line to stdin
    // Wait for response on stdout
  }

  kill(): void;
}
```

Communication: JSON lines over stdin/stdout (one JSON per line).

---

## Phase 7: Dummy Engine V3

### Update: `dummy-engine/src/index.ts`

Convert to stateful JSON-lines protocol:

```typescript
const sessions = new Map<string, DummyBgsState>();

async function main() {
  // Read JSON lines continuously
  for await (const line of readLines(stdin)) {
    const request = JSON.parse(line);
    const response = handleRequest(request);
    console.log(JSON.stringify(response));
  }
}

function handleRequest(msg) {
  switch (msg.type) {
    case "start_game_session":
      sessions.set(msg.bgsId, createSession(msg.config));
      return { type: "game_session_started", bgsId: msg.bgsId, success: true, error: "" };

    case "evaluate_position":
      const session = sessions.get(msg.bgsId);
      const bestMove = computeDummyMove(session.state);
      return { type: "evaluate_response", bgsId: msg.bgsId, bestMove, evaluation: 0, success: true, error: "" };

    case "apply_move":
      const session = sessions.get(msg.bgsId);
      applyMove(session.state, msg.move);
      return { type: "move_applied", bgsId: msg.bgsId, success: true, error: "" };

    case "end_game_session":
      sessions.delete(msg.bgsId);
      return { type: "game_session_ended", bgsId: msg.bgsId, success: true, error: "" };
  }
}
```

---

## Phase 8: Deep Wallwars Adapter

**This requires a new binary** that behaves like a server maintaining multiple parallel game sessions.

### New binary: `deep-wallwars/src/bgs_engine.cpp`

Key design points from `game_session_bot_protocol.md`:

- **Single binary** for all variants, models, and games
- **All models loaded on GPU** at initialization (~2 models)
- **Thread pool** with fixed number of threads (~12)
- **Max 256 concurrent BGS** (like self-play)
- **Each BGS** can use up to 4 threads
- **Each BGS** has its own MCTS tree in memory
- **Batching queues** shared across BGS using same model
- **Evaluation cache** shared per model (sharded for parallel writes)
- **1000 samples per move** (similar to self-play)

It should follow the implementation principles behind how self-play works and supports many games in parallel.

### Implementation:

```cpp
// BGS session storage
struct BgsSession {
  string bgs_id;
  unique_ptr<GameState> state;
  unique_ptr<MCTS> mcts_tree;  // Persisted across moves, pruned on apply_move
  Variant variant;
};

// Shared across all sessions
unordered_map<string, BgsSession> active_sessions;  // Max 256
ThreadPool thread_pool;  // ~12 threads
map<Variant, shared_ptr<BatchingQueue>> batching_queues;
map<Variant, shared_ptr<LRUCache>> eval_caches;

void run_v3_engine() {
  // Load models to GPU at startup
  load_all_models();

  // Read JSON lines continuously
  string line;
  while (getline(cin, line)) {
    json request = json::parse(line);
    json response = handle_request(request);
    cout << response.dump() << "\n" << flush;
  }
}

json handle_start_session(const json& req) {
  // Check if under 256 sessions limit
  // Create GameState from config
  // Create MCTS tree (shares batching queue and cache with other sessions of same variant)
  // Store in active_sessions
}

json handle_evaluate(const json& req) {
  // Run MCTS search (1000 samples)
  // Threads sleep during model inference, allowing other BGS to use them
  // Return best move + evaluation
}

json handle_apply_move(const json& req) {
  // Apply move to GameState
  // Prune MCTS tree to subtree rooted at the played move
  // This preserves search work for moves that were already explored
}

json handle_end_session(const json& req) {
  // Delete MCTS tree from memory
  // Remove from active_sessions
}
```

### MCTS Tree Reuse

Key optimization: When `apply_move` is called, the engine **prunes the MCTS tree** rather than discarding it:
- We do the same as how it works now (this functionality already exists):
  - Find the child node corresponding to the move
  - Make that child the new root
  - Delete all sibling subtrees
  - This preserves relevant search work from previous turns

---

## Phase 9: Frontend Changes

### Update: `frontend/src/routes/game-setup.tsx`

- Hide time control selector for bot games (mode === "vs-ai")
- Bot game configs don't include time control field at all (not `null`, just absent)
- Keep `rated: false` for bot games

### Update: `frontend/src/hooks/use-bots.ts`

- Remove `timeControl` from `BotsQuerySettings`
- Update API calls to not filter by time control

### Update: `frontend/src/components/bots-table.tsx`

- Remove time control column from bot listing
- Update filtering logic

### Update: `frontend/src/lib/eval-client.ts`

- Update for V3 history-based protocol
- Handle `eval-history` message (full history on connect)
- Handle `eval-update` message (streaming updates)
- Show "pending" state during BGS initialization

---

## Phase 10: Cleanup & Testing

### Delete V2 stateless engine code:
- Remove `request`/`response` message types for move/draw/eval
- Remove spawn-per-move logic from `engine-runner.ts`
- Remove `SerializedGameState` from request messages (BGS is stateful)
- Remove `BotRequestKind`, `MoveRequestMessage`, `DrawRequestMessage`, `EvalRequestMessage`
- Remove `BotResponseAction`, `BotResponseMessage`
- Remove per-request queue logic from `custom-bot-store.ts`
- Keep: `AttachMessage`, `AttachedMessage`, `AttachRejectedMessage` (proactive attachment)
- Keep: `BotConfig`, `VariantConfig` (remove `timeControls`), bot listing types

### Testing checklist:
- [ ] V3 bot client connects and attaches (V2 clients rejected)
- [ ] BGS lifecycle: start → evaluate → apply_move → evaluate → ... → end
- [ ] Bot game flow: human plays against bot
- [ ] Eval bar for bot games (reuses bot's BGS)
- [ ] Eval bar for human vs human games (shared BGS across viewers)
- [ ] Eval bar pending state during initialization
- [ ] Takeback handling (end BGS, start new, replay)
- [ ] Past game replay with eval bar (ephemeral BGS)
- [ ] Multiple concurrent BGS per client
- [ ] Bot disconnect handling (server resigns games, eval bar toggles off)
- [ ] 10-second timeout handling (resignation / toggle off)
- [ ] Unexpected message handling (disconnect after 100)
- [ ] Message size limit enforcement (64KB)
- [ ] `expectedPly` validation (stale messages rejected)

---

## Critical Files Summary

| File | Action |
|------|--------|
| `shared/domain/game-types.ts` | Fix `*InitialState` types: `Record<PlayerId, ...>` → `{ p1: ..., p2: ... }` |
| `shared/contracts/custom-bot-protocol.ts` | Update to V3 BGS message types |
| `shared/contracts/eval-protocol.ts` | Add V3 eval history/update messages |
| `shared/custom-bot/engine-api.ts` | Update to V3 (re-export BGS types) |
| `server/games/bgs-store.ts` | **New** - BGS state & history management |
| `server/games/custom-bot-store.ts` | Remove per-request queue, add BGS tracking |
| `server/routes/custom-bot-socket.ts` | Replace request/response with BGS handlers |
| `server/routes/game-socket.ts` | V3 BGS flow for bot games |
| `server/routes/eval-socket.ts` | **Rewrite** - BGS-based eval bar |
| `official-custom-bot-client/src/ws-client.ts` | V3 client with long-lived engine |
| `official-custom-bot-client/src/engine-runner.ts` | **Rewrite** - Long-lived engine process |
| `dummy-engine/src/index.ts` | **Rewrite** - Stateful JSON-lines protocol |
| `deep-wallwars/src/bgs_engine.cpp` | **New** - BGS engine binary with MCTS persistence |
| `frontend/src/routes/game-setup.tsx` | Remove time control for bot games |
| `frontend/src/lib/eval-client.ts` | Update for V3 history-based eval |

---

## Verification

1. **Manual testing**: Start bot client, play game vs bot, verify BGS lifecycle
2. **Eval bar**: Enable eval bar during bot game, verify history populates
3. **Integration tests**: Update tests in `tests/integration/` for V3 protocol
