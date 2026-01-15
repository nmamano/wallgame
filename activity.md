# V3 Bot Protocol Migration - Activity Log

## Current Status
**Last Updated:** 2026-01-15
**Tasks Completed:** 5/18
**Current Task:** Phase 3 - WebSocket V3 Handler

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
