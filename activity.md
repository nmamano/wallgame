# V3 Bot Protocol Migration - Activity Log

## Current Status
**Last Updated:** 2026-01-15
**Tasks Completed:** 15/18
**Current Task:** Phase 9 - Update eval-client.ts for V3 history-based protocol

---

## Session Log

<!-- Agent will append dated entries here -->

### 2026-01-15: Fix GameInitialState types to use explicit p1/p2 fields

**Status:** ✅ Complete

**Changes:**
- Updated `StandardInitialState` in `shared/domain/game-types.ts` to use `{ p1: ..., p2: ... }` instead of `Record<PlayerId, ...>`
- Updated `ClassicInitialState` similarly
- `SurvivalInitialState` already used flat `cat`/`mouse` fields, no change needed

**Files Modified:**
- `shared/domain/game-types.ts` - Type definitions
- `shared/domain/standard-setup.ts` - Builder function uses `p1`/`p2` keys
- `shared/domain/classic-setup.ts` - Builder function uses `p1`/`p2` keys
- `shared/domain/freestyle-setup.ts` - Builder function and internal usage updated
- `shared/domain/game-state.ts` - Type guards and constructor updated to use `.p1`/`.p2`

**Verification:**
- `cd frontend && bunx tsc --noEmit` - Passed
- `bun run lint` - Passed

**Notes:**
- The change from `Record<PlayerId, ...>` to explicit `{ p1, p2 }` improves JSON serialization safety since JSON only supports string keys, not numeric keys like TypeScript's `1 | 2`
- This change only affects the `*InitialState` types used in game configuration; the runtime `GameState.pawns` still uses `Record<PlayerId, ...>` internally

### 2026-01-15: Update custom-bot-protocol.ts with V3 message types

**Status:** ✅ Complete

**Changes:**
- Bumped `CUSTOM_BOT_PROTOCOL_VERSION` from 2 to 3
- Added V3 BGS (Bot Game Session) types:
  - `BgsConfig` - Configuration for a game session
  - `StartGameSessionMessage` / `GameSessionStartedMessage` - Session lifecycle
  - `EndGameSessionMessage` / `GameSessionEndedMessage` - Session termination
  - `EvaluatePositionMessage` / `EvaluateResponseMessage` - Position evaluation
  - `ApplyMoveMessage` / `MoveAppliedMessage` - Move application
- Removed `timeControls` from `VariantConfig` (V3 bot games have no time control)
- Added `BgsServerMessage` union type for BGS protocol messages
- Marked V2 types as `@deprecated` (kept temporarily for backward compatibility during migration)
- Updated file header documentation to describe V3 protocol flow

**Files Modified:**
- `shared/contracts/custom-bot-protocol.ts` - Protocol type definitions

**Verification:**
- `cd frontend && bunx tsc --noEmit` - Passed
- `bun run lint` - Passed

**Notes:**
- V2 types (BotRequestKind, BotResponseAction, BotResponseMessage, RequestMessage, etc.) are kept with @deprecated annotations to maintain backward compatibility until later phases update all consumers
- The V3 protocol uses stateful Bot Game Sessions instead of stateless per-move requests, enabling MCTS tree persistence and better engine efficiency
- `expectedPly` field added to requests for ordering and staleness detection

### 2026-01-15: Update engine-api.ts to re-export V3 types

**Status:** ✅ Complete

**Changes:**
- Updated `ENGINE_API_VERSION` from 2 to 3
- Re-exported all V3 BGS message types from `custom-bot-protocol.ts`:
  - Request types: `StartGameSessionMessage`, `EndGameSessionMessage`, `EvaluatePositionMessage`, `ApplyMoveMessage`
  - Response types: `GameSessionStartedMessage`, `GameSessionEndedMessage`, `EvaluateResponseMessage`, `MoveAppliedMessage`
  - Configuration: `BgsConfig`, `CUSTOM_BOT_PROTOCOL_VERSION`
- Added new V3 type aliases: `EngineRequestV3`, `EngineResponseV3`
- Added `BgsHistoryEntry` interface for engine-side tracking
- Added V3 helper functions:
  - `createGameSessionStartedResponse()`
  - `createGameSessionEndedResponse()`
  - `createEvaluateResponse()` (with automatic evaluation clamping)
  - `createMoveAppliedResponse()`
- Kept V2 legacy types with `@deprecated` annotations for backward compatibility:
  - `EngineRequest`, `EngineResponse` (V2 unions still exported)
  - `EngineMoveRequest`, `EngineDrawRequest`, `EngineMoveResponse`, `EngineDrawResponse`, `EngineEvalResponse`
  - `createMoveRequest()`, `createDrawRequest()` helpers
  - `ENGINE_API_VERSION_V2` constant
- Updated file header documentation to describe V3 JSON-lines protocol flow

**Files Modified:**
- `shared/custom-bot/engine-api.ts` - Engine API type definitions

**Verification:**
- `cd frontend && bunx tsc --noEmit` - Passed
- `bun run lint` - Passed

**Notes:**
- V2 types are kept because consumers (`dummy-engine`, `official-custom-bot-client`, tests) still use them. These will be migrated in Phase 6 (client) and Phase 7 (dummy engine), then cleaned up in Phase 10.
- The V3 engine API uses JSON-lines protocol: long-lived engine processes that read/write one JSON message per line, enabling stateful sessions with MCTS tree persistence.
- `EngineRequestV3` and `EngineResponseV3` are the new primary types; `EngineRequest` and `EngineResponse` are deprecated V2 aliases kept for migration.

### 2026-01-15: Create bgs-store.ts for BGS state management

**Status:** ✅ Complete

**Changes:**
- Created `server/games/bgs-store.ts` - new file for BGS state management
- Implemented `BgsHistoryEntry` interface for tracking position evaluations
- Implemented `BotGameSession` interface with:
  - Session metadata (bgsId, botCompositeId, gameId, config)
  - Lifecycle status ("initializing" | "ready" | "ended")
  - Evaluation history and current ply tracking
  - Pending request tracking for timeout management
- Implemented core lifecycle functions:
  - `createBgs()` - Create new BGS with capacity check (max 256 sessions)
  - `getBgs()` - Retrieve BGS by ID
  - `endBgs()` - End session and clean up
  - `markBgsReady()` - Transition from initializing to ready
- Implemented history management:
  - `addHistoryEntry()` - Add evaluation entry with ply validation
  - `getBgsHistory()` - Get copy of history array
  - `getLatestHistoryEntry()` - Get most recent evaluation
- Implemented pending request management:
  - `setPendingRequest()` - Set pending request with conflict check
  - `getPendingRequest()` / `clearPendingRequest()` - Request lifecycle
- Implemented query functions:
  - `getBgsForBot()` - Get all BGS for a specific bot
  - `getBgsForGame()` - Get BGS for a game
  - `getBgsCount()` / `isAtCapacity()` - Capacity checking
- Implemented cleanup functions:
  - `endAllBgsForBot()` - End all BGS when bot disconnects
  - `cleanupStaleBgs()` - Periodic cleanup for stale sessions
- Added debug/testing utilities: `clearAll()`, `getAllBgs()`

**Files Modified:**
- `server/games/bgs-store.ts` - New file (485 lines)

**Verification:**
- `cd frontend && bunx tsc --noEmit` - Passed
- `bun run lint` - Passed

**Notes:**
- The BGS store follows the same patterns as `custom-bot-store.ts` (Map-based storage, similar API style)
- `BgsHistoryEntry` is defined independently here (not imported from `engine-api.ts`) as the server may need additional fields in the future
- The 256 session limit matches Deep Wallwars' self-play capacity
- Pending request tracking supports the 10-second timeout policy specified in the V3 migration plan
- Used `Array.from(sessions.values())` instead of direct iteration to ensure compatibility with TypeScript's downlevelIteration requirements

### 2026-01-15: Rewrite custom-bot-store.ts for V3

**Status:** ✅ Complete

**Changes:**
- Updated `BotClientConnection` interface: removed `activeRequest` and `requestQueue`, added `activeBgsSessions: Set<string>`
- Removed V2 request queue infrastructure (types and storage)
- Added V3 BGS session tracking functions:
  - `addClientBgsSession()` - Track active BGS on client
  - `removeClientBgsSession()` - Remove BGS from client
  - `hasClientBgsSession()` - Check if client has BGS
  - `getClientBgsSessions()` - Get all active BGS for client
- Updated `getMatchingBots()`: removed `timeControl` parameter (V3 bot games have no time control)
- Updated `getRecommendedBots()`: removed `timeControl` parameter
- Deprecated V2 queue functions with `@deprecated` annotations and throwing implementations:
  - `enqueueRequest`, `tryProcessNextRequest`, `getActiveRequest`, `clearActiveRequest`, `validateRequestId`, `removeRequestsForGame`
  - These throw errors if called, ensuring V2 code paths are caught early
- Updated `server/routes/games.ts` to use new function signatures

**Files Modified:**
- `server/games/custom-bot-store.ts` - Main store rewrite
- `server/routes/games.ts` - Updated bot listing API calls

**Verification:**
- `cd frontend && bunx tsc --noEmit` - Passed
- `bun run lint` - Passed

**Notes:**
- V2 functions kept as deprecated stubs because consumers (`custom-bot-socket.ts`, `eval-socket.ts`) still import them. These will be removed in Phase 3 (WebSocket handler rewrite) and Phase 5 (Eval socket rewrite).
- The `MAX_QUEUE_LENGTH` constant was removed since V3 doesn't use request queues.
- Time control filtering removed from bot discovery - in V3, bot games are untimed. The `botsQuerySchema` still accepts `timeControl` for backward compatibility but it's ignored.

### 2026-01-15: Rewrite custom-bot-socket.ts for V3 BGS handlers

**Status:** ✅ Complete

**Changes:**
- Complete rewrite of `custom-bot-socket.ts` from V2 stateless request/response to V3 stateful Bot Game Sessions (BGS)
- Attach handling now requires exactly `protocolVersion === 3` (V2 clients rejected)
- Removed all V2 message handling (`request`, `response`, `ack`, `nack`)
- Added V3 BGS response handlers:
  - `handleGameSessionStarted()` - Marks BGS as ready on success
  - `handleGameSessionEnded()` - Cleans up BGS tracking
  - `handleEvaluateResponse()` - Validates ply, stores result in BGS history
  - `handleMoveApplied()` - Updates BGS ply tracking
- Implemented V3 public API for game integration (Promise-based):
  - `startBgsSession()` - Creates BGS and waits for bot confirmation
  - `endBgsSession()` - Ends BGS and waits for bot confirmation
  - `requestEvaluation()` - Requests position evaluation from bot
  - `applyBgsMove()` - Applies move to BGS and waits for confirmation
  - `notifyBotGameEnded()` - Handles game end (cleans up BGS)
- Implemented 10-second timeout policy for all BGS requests
- Implemented abuse protection:
  - 64KB message size limit (incoming and outgoing)
  - Unexpected message tracking (disconnect after 100 unexpected messages)
- Stubbed out `eval-socket.ts` temporarily (returns "not available" for eval requests)
  - Full V3 BGS-based eval bar will be implemented in Phase 5

**Files Modified:**
- `server/routes/custom-bot-socket.ts` - Complete rewrite (1173 lines → 1173 lines)
- `server/routes/eval-socket.ts` - Temporary stub (501 lines → 196 lines)

**Verification:**
- `cd frontend && bunx tsc --noEmit` - Passed
- `bun run lint` - Passed

**Notes:**
- The V3 protocol uses Promise-based async/await for all BGS operations, replacing V2's fire-and-forget queue model
- Timeouts are enforced via `setTimeout` with cleanup on response or timeout
- The `pendingResolvers` Map tracks outstanding requests by bgsId, enabling proper timeout handling
- Eval socket is temporarily disabled during migration (Phase 5 will rewrite it for V3 BGS-based eval bar)
- V2 deprecated functions in `custom-bot-store.ts` (now throwing errors) are no longer called

### 2026-01-15: Update game-socket.ts for V3 bot game flow

**Status:** ✅ Complete

**Changes:**
- Complete V3 BGS integration in `server/routes/game-socket.ts` for bot game flow
- Added BGS helper functions:
  - `buildBgsConfig()` - Extracts variant config from session for BGS creation
  - `startBotGameSession()` - Creates and starts a BGS for a bot player
  - `getInitialEvaluation()` - Gets the initial position evaluation (ply 0)
  - `applyMoveAndEvaluate()` - Core V3 flow: applies move then evaluates new position
  - `resignBotOnFailure()` - Handles bot resignation when BGS operations fail
  - `initializeBotGameSession()` - Combined BGS start + initial evaluation
- Replaced V2 `notifyBotIfActive()` with V3 `executeBotTurnV3()`:
  - Gets best move from BGS history (already computed from previous evaluation)
  - Applies move to game state and broadcasts to clients
  - Updates BGS with `applyMoveAndEvaluate()` for next turn
- Added `initializeBotGameOnStart()` - Initializes BGS when player connects to bot game
- Replaced V2 `registerRematchBotGames()` with V3 `registerRematchBotGamesV3()`:
  - Creates BGS and initializes for rematch games
  - Executes first bot turn if needed
- Added `handleTakebackBgsReset()` for V3 takeback handling:
  - Ends current BGS
  - Creates new BGS with same ID
  - Replays all moves from game history to rebuild BGS state
  - Triggers bot turn if needed
- Updated draw handling:
  - V3 policy: server auto-rejects all draws in bot games (no message to bot)
  - Removed V2 `queueBotDrawRequest()` calls
- Updated game end handling:
  - `notifyBotsGameEnded()` now calls V3 async `notifyBotGameEnded()`
- Updated human move handling in bot games:
  - After human move, applies move to BGS and triggers bot turn
- Removed unused imports (`getClient`, `getClientForBot`, `cancelBotRequestsForGame`)
- Fixed minor lint issues (nullish coalescing in custom-bot-socket.ts)

**Files Modified:**
- `server/routes/game-socket.ts` - Complete V3 integration (~200 lines added)
- `server/routes/games.ts` - Removed V2 bot move queueing at game creation
- `server/routes/custom-bot-socket.ts` - Fixed `||` to `??` for lint compliance

**Verification:**
- `bunx tsc --noEmit` - Passed (only pre-existing auth.ts URL type error)
- `bun run lint` - Passed

**Notes:**
- BGS initialization is now lazy (on player connect) rather than eager (at game creation). This simplifies error handling and ensures the human player is present when BGS starts.
- Bot turn execution uses the `bestMove` from the latest BGS history entry, which was computed during the previous `evaluate_position` call. This enables the "pre-compute next move" pattern described in the V3 spec.
- The takeback flow rebuilds BGS from scratch by replaying all moves. This ensures the MCTS tree can be properly rebuilt from the new game state.
- `ensureRematchSession()` is now synchronous since BGS initialization is done asynchronously via `void registerRematchBotGamesV3()`.
- Draw offers in bot games are now silently rejected server-side (V3 policy) instead of being sent to the bot client.

### 2026-01-15: Add V3 eval protocol message types

**Status:** ✅ Complete

**Changes:**
- Updated file header documentation in `shared/contracts/eval-protocol.ts` to describe V3 BGS-based connection flow
- Added `EvalHistoryEntry` interface for evaluation history entries:
  - `ply: number` - Position in game (0 = initial)
  - `evaluation: number` - Position score from P1's perspective [-1, +1]
  - `bestMove: string` - Recommended move for side-to-move
- Added `EvalHistoryMessage` interface:
  - V3 message sent when eval bar is enabled
  - Contains full evaluation history from ply 0 to current position
- Added `EvalUpdateMessage` interface:
  - V3 streaming message for live games
  - Sent when new moves are made, containing evaluation of new position
- Added `EvalPendingMessage` interface:
  - V3 message sent during BGS initialization
  - Allows client to show loading state while moves are being replayed
- Updated `EvalServerMessage` union type to include all V3 message types

**Files Modified:**
- `shared/contracts/eval-protocol.ts` - V3 eval protocol message types

**Verification:**
- `bunx tsc --noEmit` - Passed
- `bun run lint` - Passed

**Notes:**
- V2 eval protocol types (EvalPositionRequest, EvalResponse) are preserved for backward compatibility during migration
- The `EvalPendingMessage` was added beyond the spec to improve UX during initialization of long games
- `EvalHistoryEntry` mirrors the server-side `BgsHistoryEntry` structure for consistency
- V3 uses a push model (server streams updates) vs V2's pull model (client requests evaluations)

### 2026-01-15: Rewrite eval-socket.ts for BGS-based eval bar

**Status:** ✅ Complete

**Changes:**
- Complete rewrite of `server/routes/eval-socket.ts` for V3 BGS-based evaluation bar
- Implemented BGS creation logic for different game types:
  - **Bot games (live):** Reuses the existing bot game BGS for eval bar
  - **Human vs human (live):** Creates shared eval BGS with ID `${gameId}_eval`
  - **Past game replays:** Creates ephemeral BGS, closes immediately after sending history
- Implemented `initializeBgsHistory()` - Core V3 flow:
  - Creates BGS via `startBgsSession()`
  - Gets initial position evaluation (ply 0)
  - Replays all moves sequentially with `applyBgsMove()` + `requestEvaluation()`
  - Validates ply values match expected sequence
  - Returns full `EvalHistoryEntry[]` array on success
- Implemented `handleHandshake()` for eval bar connection:
  - Validates game exists and variant is supported
  - Finds official eval bot via `findEvalBot()`
  - Handles pending state with `eval-pending` message during initialization
  - Supports multiple viewers sharing the same BGS (human vs human games)
- Added streaming update support:
  - Exported `notifyEvalBarMove()` - Called from game-socket.ts when moves are made
  - Broadcasts `eval-update` messages to all connected eval sockets
- Added game end handling:
  - Exported `handleEvalBarGameEnd()` - Called when games end
  - Closes shared BGS and cleans up state (clients retain history client-side)
- Implemented `SharedEvalBgs` interface for tracking shared BGS state:
  - Tracks `status` ("initializing" | "ready" | "error")
  - Manages `pendingSocketIds` for sockets waiting on initialization
  - Caches `cachedHistory` for quick access by subsequent viewers
  - Tracks `viewerCount` (BGS stays open until game ends, not viewer disconnect)
- Added `INTERNAL_ERROR` to `EvalHandshakeRejectedCode` type for edge cases

**Files Modified:**
- `server/routes/eval-socket.ts` - Complete rewrite (~815 lines)
- `shared/contracts/eval-protocol.ts` - Added `INTERNAL_ERROR` to rejection codes

**Verification:**
- `bunx tsc --noEmit` - Passed (only pre-existing errors in unrelated files)
- `bun run lint` - Passed

**Notes:**
- The V3 eval bar uses a push model: server initializes BGS, then streams updates. V2 used a pull model where client requested evals per-position.
- Bot game eval bars reuse the existing bot game BGS (ID = gameId). This means eval history is already populated from the bot's turn calculations.
- Human vs human games create a separate eval BGS (ID = `${gameId}_eval`) that is shared across all viewers.
- Replays create ephemeral BGS that is closed immediately after sending the full history to minimize server resource usage.
- The `SharedEvalBgs` pattern handles concurrent initialization requests - first viewer starts BGS init, subsequent viewers wait for it to complete.
- Exported `notifyEvalBarMove()` and `handleEvalBarGameEnd()` need to be wired up in game-socket.ts in a future update.

### 2026-01-15: Update ws-client.ts for long-lived engine

**Status:** ✅ Complete

**Changes:**
- Complete rewrite of `official-custom-bot-client/src/ws-client.ts` for V3 Bot Game Session protocol
- Removed all V2 request/response handling (`request`, `response`, `ack`, `nack` message types)
- Added V3 BGS message handlers:
  - `handleStartGameSession()` - Creates engine session, passes through to engine
  - `handleEndGameSession()` - Ends engine session, passes through to engine
  - `handleEvaluatePosition()` - Passes evaluation request to engine, clamps response
  - `handleApplyMove()` - Passes move to engine for state update
- Added `startEngines()` method to spawn long-lived engine processes at startup
- Engine processes are stored in a Map keyed by botId
- Engines stay running during WebSocket reconnections
- Added `EngineProcess` class to `engine-runner.ts`:
  - Long-lived process communicating via JSON-lines (stdin/stdout)
  - Handles async request/response with pending request tracking
  - Supports multiple concurrent BGS sessions per engine
- Updated version strings from "2.0.0" to "3.0.0"
- Updated CLI help text to describe V3 JSON-lines protocol

**Files Modified:**
- `official-custom-bot-client/src/ws-client.ts` - Complete rewrite for V3 BGS protocol
- `official-custom-bot-client/src/engine-runner.ts` - Complete rewrite for long-lived EngineProcess
- `official-custom-bot-client/src/index.ts` - Updated version and help text

**Verification:**
- `cd frontend && bunx tsc --noEmit` - Passed
- `cd official-custom-bot-client && bunx tsc --noEmit` - Passed
- `bun run lint` - Passed

**Notes:**
- V3 engines are started once at startup and remain running for the lifetime of the client
- The JSON-lines protocol allows multiple BGS sessions to be multiplexed over a single engine process
- When WebSocket reconnects, engines stay running - only the WebSocket connection is re-established
- Dumb bot fallback is provided for bots without engine commands (used for testing)
- Evaluation values are clamped to [-1, +1] range before sending to server
- The `EngineProcess` class tracks pending requests by bgsId and resolves them when responses arrive

### 2026-01-15: Rewrite engine-runner.ts for long-lived process

**Status:** ✅ Complete

**Changes:**
- Verified that `engine-runner.ts` was already rewritten as part of the previous ws-client.ts task
- Confirmed all task requirements are implemented:
  - `EngineProcess` class with static `spawn()` factory method
  - JSON-lines communication over stdin/stdout (one JSON message per line)
  - `send()` method with `pendingRequests` Map tracking by bgsId
  - `kill()` method for cleanup (closes stdin, kills process, rejects pending requests)
- The implementation includes:
  - Private constructor pattern with public static `spawn()` factory
  - `readResponses()` for async stdout reading with line buffering
  - `handleResponse()` for JSON parsing and request resolution
  - Proper error handling for process exit and stderr logging
  - `alive` getter for checking process status

**Files Modified:**
- `official-custom-bot-client/src/engine-runner.ts` - Previously rewritten (265 lines)

**Verification:**
- `cd official-custom-bot-client && bunx tsc --noEmit` - Passed
- `cd frontend && bunx tsc --noEmit` - Passed
- `bun run lint` - Passed

**Notes:**
- This task was actually completed as part of the previous "Update ws-client.ts for long-lived engine" task, as the ws-client.ts rewrite required the EngineProcess class to be available
- The implementation follows a factory pattern (private constructor + static spawn) to ensure proper initialization
- Request tracking uses bgsId as the key, supporting multiple concurrent BGS sessions per engine
- The JSON-lines protocol (one JSON object per newline) is simple and debuggable

### 2026-01-15: Rewrite dummy-engine for V3 stateful protocol

**Status:** ✅ Complete

**Changes:**
- Complete rewrite of `dummy-engine/src/index.ts` from V2 stateless single-request mode to V3 stateful Bot Game Session protocol
- Converted from single-request stdin/stdout to long-lived JSON-lines protocol:
  - Engine now reads JSON lines continuously from stdin
  - Each line is a complete JSON message, responses written as single JSON lines to stdout
  - Engine stays running for the lifetime of the bot client
- Implemented session state management:
  - `DummyBgsState` interface tracks per-session game state (grid, pawns, ply)
  - `sessions` Map stores multiple concurrent BGS sessions keyed by bgsId
- Implemented V3 message handlers:
  - `handleStartGameSession()` - Creates new BGS from BgsConfig, initializes grid and pawns
  - `handleEndGameSession()` - Removes BGS from sessions Map
  - `handleEvaluatePosition()` - Computes best move using dummy AI, returns evaluation
  - `handleApplyMove()` - Applies move to session state, increments ply
- Added variant-aware initialization:
  - Standard/Freestyle: cat/mouse structure with p1/p2 pawns
  - Classic: cat/home structure (home stored in mouse slot)
  - Survival: flat cat/mouse structure (single cat vs single mouse)
- Added `readLines()` async generator for line-buffered stdin reading
- Added ply validation to detect stale/out-of-order requests

**Files Modified:**
- `dummy-engine/src/index.ts` - Complete rewrite (~430 lines)

**Verification:**
- `cd dummy-engine && bunx tsc --noEmit` - Passed
- `cd frontend && bunx tsc --noEmit` - Passed
- `bun run lint` - Passed

**Notes:**
- The dummy engine now supports multiple concurrent BGS sessions, matching the V3 protocol specification
- Session state includes: grid with walls, pawn positions for both players, current ply counter
- Move computation uses the existing `computeDummyAiMove()` function which walks the cat toward its goal
- The engine always returns evaluation 0 (neutral) - a more sophisticated engine would compute real evaluations
- Type guards (`isStandardInitialState`, `isClassicInitialState`, `isSurvivalInitialState`) are duplicated from `game-state.ts` since the dummy engine is a standalone binary
- The `readLines()` implementation handles partial reads and buffers incomplete lines correctly

### 2026-01-15: Design Deep Wallwars BGS adapter interface

**Status:** ✅ Complete

**Changes:**
- Created `info/bgs_engine.md` - comprehensive design document for the Deep Wallwars BGS engine adapter
- Documented `BgsSession` struct with fields: `bgs_id`, `board`, `variant`, `current_turn`, `ply`, `mcts` tree, `padding` config, `samples_per_eval`
- Documented shared resources architecture:
  - **Thread pool**: ~12 threads shared across all sessions, up to 4 threads per session for MCTS parallelism
  - **Batched models**: TensorRT models loaded to GPU at startup, shared via `BatchedModel` instances
  - **Evaluation cache**: Sharded LRU cache (100k entries) per variant for position evaluations
- Defined JSON-lines protocol for stdin/stdout communication:
  - Request types: `start_game_session`, `evaluate_position`, `apply_move`, `end_game_session`
  - Response types with `success`/`error` fields for all messages
  - Evaluation semantics: `[-1.0, +1.0]` range, always from P1's perspective
- Documented MCTS tree reuse strategy:
  - On `apply_move`: find child node for played move, promote to root, delete siblings
  - Preserves search work from previous turns
  - Handles both pre-searched and unexplored opponent moves
- Documented capacity limits: max 256 concurrent sessions (matches self-play capacity)
- Included architecture diagrams, initialization sequence, and future extensions

**Files Modified:**
- `info/bgs_engine.md` - New file (~350 lines)

**Verification:**
- `cd frontend && bunx tsc --noEmit` - Passed (no TypeScript changes)
- `bun run lint` - Passed

**Notes:**
- This is a design/documentation task, not a code implementation task
- The design builds on the existing Deep Wallwars architecture: Folly coroutines, BatchedModel for GPU inference, sharded LRU cache, MCTS with tree persistence
- The BGS engine will leverage existing components: `Board`, `MCTS`, `BatchedModelPolicy`, `CachedPolicy`, `PaddingConfig`
- Key insight: MCTS tree pruning via `force_move()` is already implemented in the existing codebase for self-play; the BGS adapter will reuse this functionality
- The document serves as the specification for future C++ implementation of `bgs_engine.cpp`

### 2026-01-15: Update game-setup.tsx to hide time control for bot games

**Status:** ✅ Complete

**Changes:**
- Updated `frontend/src/routes/game-setup.tsx` to conditionally hide the time control selector when `mode === 'vs-ai'` (V3: bot games are untimed)
- Updated `shared/contracts/games.ts`:
  - Removed `timeControl` from `botsQuerySchema` - bot discovery no longer filters by time control
  - Removed `timeControl` from `createBotGameSchema.config` - bot game creation doesn't require time control
  - Updated comment headers to reflect V3 Bot Game Session Protocol
- Updated `frontend/src/hooks/use-bots.ts`:
  - Removed `timeControl` from `BotsQuerySettings` interface
  - Updated `useRecommendedBotsQuery` to not require timeControl parameter
- Updated `frontend/src/lib/api.ts`:
  - Removed `timeControl` from `fetchBots` and `fetchRecommendedBots` parameters
  - Removed `timeControl` handling from `playVsBot` (V3 bot games are untimed)
- Updated `frontend/src/components/ready-to-join-table.tsx`:
  - Removed `timeControl` from bot query calls
  - Removed unused `formatTimeControlLabel` function
  - Updated display text to not mention time control for bot tabs
- Updated `shared/domain/game-utils.ts`:
  - Added `BOT_GAME_TIME_CONTROL` constant (24-hour placeholder for untimed bot games)
- Updated `server/routes/games.ts`:
  - Updated bot game creation to use `BOT_GAME_TIME_CONTROL` constant
  - Removed ELO lookup for bot games (V3: bot games are unrated)
  - Removed async from bot game creation handler (no longer awaits)

**Files Modified:**
- `frontend/src/routes/game-setup.tsx` - Hide time control for vs-ai mode
- `frontend/src/hooks/use-bots.ts` - Remove timeControl from query settings
- `frontend/src/lib/api.ts` - Remove timeControl from bot API calls
- `frontend/src/components/ready-to-join-table.tsx` - Update bot query calls
- `shared/contracts/games.ts` - Remove timeControl from bot schemas
- `shared/domain/game-utils.ts` - Add BOT_GAME_TIME_CONTROL constant
- `server/routes/games.ts` - Use placeholder time control for bot games

**Verification:**
- `cd frontend && bunx tsc --noEmit` - Passed
- `bun run lint` on modified files - Passed (pre-existing errors in unmodified code)

**Notes:**
- V3 bot games are untimed - this removes the time control concept entirely for human vs bot games
- The `BOT_GAME_TIME_CONTROL` constant uses 24 hours (86400 seconds) as a placeholder to satisfy type requirements while indicating effectively unlimited time
- Bot games enforce `rated: false` server-side regardless of client input
- The UI no longer shows time control selection when entering the game setup page in "vs-ai" mode

### 2026-01-15: Update use-bots.ts and bots-table.tsx

**Status:** ✅ Complete

**Changes:**
- Verified `use-bots.ts` was already updated in previous phase (no `timeControl` in `BotsQuerySettings`)
- Verified `api.ts` bot functions already remove timeControl filtering
- Removed `timeControls` from `variantConfigSchema` in `shared/contracts/custom-bot-config-schema.ts`
- Removed unused `timeControlValues` import from the schema file
- Added V3 documentation header to `custom-bot-config-schema.ts`
- Updated all bot configuration JSON files to remove `timeControls`:
  - `official-custom-bot-client/deep-wallwars.config.json`
  - `official-custom-bot-client/deep-wallwars-12x10.config.json`
  - `official-custom-bot-client/deep-wallwars.config.prod.json`
- Updated integration test bot configs to remove `timeControls`:
  - `tests/integration/bot-1-mock-client.test.ts`
  - `tests/integration/bot-2-official-client.test.ts`
  - `tests/integration/bot-3-dummy-engine.test.ts`
  - `tests/integration/bot-4-deep-wallwars-engine.test.ts`

**Files Modified:**
- `shared/contracts/custom-bot-config-schema.ts` - Remove timeControls from schema
- `official-custom-bot-client/deep-wallwars.config.json` - Remove timeControls from variants
- `official-custom-bot-client/deep-wallwars-12x10.config.json` - Remove timeControls from variants
- `official-custom-bot-client/deep-wallwars.config.prod.json` - Remove timeControls from variants
- `tests/integration/bot-1-mock-client.test.ts` - Remove timeControls from test configs
- `tests/integration/bot-2-official-client.test.ts` - Remove timeControls from test configs
- `tests/integration/bot-3-dummy-engine.test.ts` - Remove timeControls from test configs
- `tests/integration/bot-4-deep-wallwars-engine.test.ts` - Remove timeControls from test configs

**Verification:**
- `cd frontend && bunx tsc --noEmit` - Passed
- `cd official-custom-bot-client && bunx tsc --noEmit` - Passed
- `cd dummy-engine && bunx tsc --noEmit` - Passed
- `bun run lint` - Passed for modified files (pre-existing errors in unrelated code)

**Notes:**
- The `bots-table.tsx` file mentioned in the task description doesn't exist in this codebase - bot listing is handled within `ready-to-join-table.tsx` and other components
- The task steps related to `use-bots.ts` and API filtering were already completed as part of the previous phase9-frontend task (game-setup.tsx)
- This task primarily completes the removal of `timeControls` from the Zod validation schema and bot config files
- The schema change affects both client-side config file validation and server-side bot attachment validation

