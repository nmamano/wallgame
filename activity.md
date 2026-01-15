# V3 Bot Protocol Migration - Activity Log

## Current Status
**Last Updated:** 2026-01-15
**Tasks Completed:** 2/18
**Current Task:** Phase 1 - Types

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
