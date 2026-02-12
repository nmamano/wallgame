# BGS Orchestration State Machine (V3+)

## Purpose

Define a robust server-side state machine for orchestrating stateful BGS sessions under concurrent game actions (moves, takebacks, rematch, eval-bar toggles, history cursor changes), with strict invariants and deterministic behavior.

This design assumes:

- BGS/engine sessions are **stateful** and central to V3.
- The server owns authoritative game timeline and lifecycle policy.
- The server must tolerate delayed/stale/out-of-order responses and overlapping user actions.

---

## Scope

This state machine lives in the server game-session orchestration layer (around current `game-socket` + BGS integration), not in frontend, not inside engine implementation.

---

## Core Principles

1. **Single-writer per game session**
   - All game+engine orchestration for one game runs through a single serialized event loop (actor/mailbox).
   - No direct BGS calls from route handlers.

2. **Authoritative timeline**
   - Game state is source of truth.
   - BGS is a synchronized, stateful analysis replica.

3. **Explicit epochs and revisions**
   - `generation`: increments when BGS session is logically replaced (takeback/rematch/reset).
   - `timelineRev`: increments on every authoritative game mutation.
   - `engineSyncedRev`: latest timeline revision known applied to BGS.

4. **Strict request-response matching**
   - Every outbound BGS request has token:
     - `requestId`
     - `generation`
     - `timelineRev`
     - `expectedResponseType`
   - Responses not matching current expected token are discarded.

5. **Orthogonal UI analysis controls**
   - Eval-bar on/off and history cursor are separate from engine-sync lifecycle.
   - They never alter authoritative game timeline.

---

## State Model

Represent machine with three parallel regions.

## 1) Timeline Region (authoritative game lifecycle)

- `Playing`
- `Finished`
- `RematchPending`
- `RematchStarted` (new session created; timeline reset)

This region is driven by game domain actions (move, resign, takeback acceptance, rematch, timeout, etc.).

## 2) EngineSync Region (BGS lifecycle)

- `NoEngine`
- `StartingSession`
- `SyncedIdle` (ready, no in-flight request)
- `ApplyingMove` (await `move_applied`)
- `Evaluating` (await `evaluate_response`)
- `RebuildingFromHistory` (after takeback/rematch/history rewrite)
- `EndingSession`
- `Degraded` (engine unusable; deterministic fallback path)

## 3) AnalysisView Region (UI analysis controls)

- `EvalBarOff`
- `EvalBarLive`
- `EvalBarHistory(cursorPly)`

This region only controls subscriptions/data presentation.

---

## Context (per game actor)

- `gameId`
- `generation: number`
- `timelineRev: number`
- `engineSyncedRev: number | null`
- `inFlight: null | { requestId, expectedType, generation, timelineRev, timeoutAt }`
- `rebuild: null | { generation, snapshotRev, moves[] }`
- `latestEvalByPly: Map<number, Eval>`
- `analysisView: { enabled: boolean, cursor: number | null }`
- `botSeatPlayerId: PlayerId | null`
- `bgsId: string | null` (usually gameId)

---

## Invariants

1. **One in-flight engine request max**
   - `inFlight == null` in `SyncedIdle`, non-null in request states.
2. **Generation monotonicity**
   - New reset/rematch increments generation exactly once.
3. **Revision order**
   - `engineSyncedRev <= timelineRev`.
4. **No stale side effects**
   - Any async completion with stale `(generation, requestId)` is ignored.
5. **Rebuild snapshot immutability**
   - Rebuild replays from captured `moves[]` snapshot only.
6. **Timeline mutation independence**
   - User move/takeback mutates timeline immediately, independent of engine latency.
7. **Degraded determinism**
   - On irrecoverable engine sync failure, always execute configured fallback (e.g., bot resign).

---

## Event Catalog

## User/domain events

- `USER_MOVE_APPLIED({ rev, move, actor })`
- `TAKEBACK_ACCEPTED({ rev, newHistory })`
- `TAKEBACK_REJECTED`
- `RESIGN_APPLIED({ rev, actor })`
- `GAME_FINISHED({ rev, result })`
- `REMATCH_CREATED({ newGameId, rev })`
- `TOGGLE_EVAL_BAR({ enabled })`
- `SET_HISTORY_CURSOR({ cursor | null })`

## Engine transport events

- `ENGINE_SESSION_STARTED({ requestId, generation, ok, error? })`
- `ENGINE_MOVE_APPLIED({ requestId, generation, ply, ok, error? })`
- `ENGINE_EVAL_READY({ requestId, generation, ply, eval, bestMove, ok, error? })`
- `ENGINE_SESSION_ENDED({ requestId, generation, ok, error? })`
- `ENGINE_DISCONNECTED`
- `ENGINE_TIMEOUT({ requestId, generation })`
- `ENGINE_PROTOCOL_ERROR({ detail })`

## Internal scheduler events

- `SYNC_REQUIRED`
- `REBUILD_REQUIRED`
- `TRY_PROGRESS` (actor attempts next deterministic step)

---

## Transition Sketch (EngineSync)

## `NoEngine`
- On bot available + game playable -> `StartingSession` (issue `start_game_session`).

## `StartingSession`
- On matching `ENGINE_SESSION_STARTED(ok)` -> `SyncedIdle`, set `engineSyncedRev` appropriately, then `TRY_PROGRESS`.
- On failure/timeout -> `Degraded` (fallback).

## `SyncedIdle`
- On `SYNC_REQUIRED` where `engineSyncedRev < timelineRev`:
  - If timeline rewrite detected (takeback/rematch): `RebuildingFromHistory`.
  - Else next op:
    - apply missing move -> `ApplyingMove`
    - then evaluate -> `Evaluating`
- On finish/resign/rematch end conditions -> `EndingSession`.

## `ApplyingMove`
- On matching `ENGINE_MOVE_APPLIED(ok)` -> update internal ply, transition `Evaluating`.
- On failure/timeout -> if generation changed, ignore; else `Degraded`.

## `Evaluating`
- On matching `ENGINE_EVAL_READY(ok)` -> store eval at ply, update `engineSyncedRev`, go `SyncedIdle`, then `TRY_PROGRESS`.
- On failure/timeout -> if generation changed, ignore; else `Degraded`.

## `RebuildingFromHistory`
- Entry action:
  - increment `generation`
  - end prior session (best effort)
  - start fresh session for new generation
  - capture immutable `{ snapshotRev, moves[] }`
- Replay loop:
  - sequentially apply+evaluate snapshot moves
  - before each step, if generation changed -> abort stale work
- On complete:
  - set `engineSyncedRev = snapshotRev`
  - go `SyncedIdle`
  - emit `TRY_PROGRESS` to catch up post-snapshot moves
- On failure/timeout -> `Degraded` (or retry policy if desired).

## `EndingSession`
- Send end session (respect one in-flight rule).
- On ack/timeout -> `NoEngine` or terminal if game ended.

## `Degraded`
- Execute deterministic fallback:
  - bot resign OR disable bot and mark game unrecoverable (choose one policy).
- No silent continue with unsynced engine.

---

## Handling Key Concurrent Scenarios

## 1) Human move while engine evaluating
- Timeline rev increments immediately.
- Actor records `SYNC_REQUIRED`.
- No parallel second request; move sync waits until current in-flight resolves.
- Deterministic catch-up in `SyncedIdle`.

## 2) Takeback while engine request in-flight
- Timeline rewrite event increments rev and requests rebuild.
- Actor bumps generation, making current in-flight response stale.
- On stale response arrival: ignored.
- Rebuild runs from snapshot at takeback acceptance.

## 3) Human move during rebuild
- Timeline rev increments.
- Rebuild snapshot remains fixed.
- After rebuild completes to `snapshotRev`, actor catches up additional revs via normal sync.
- No duplicate apply.

## 4) Eval bar toggle / history cursor changes during engine work
- Only affects `AnalysisView`.
- No effect on `generation`, `timelineRev`, or in-flight engine request.
- UI reads from stored eval history or live stream safely.

## 5) Rematch
- Treated as timeline replacement + new generation.
- Old generation async completions are stale and ignored.

---

## Request Token Format

Each outbound engine command carries metadata in actor context (not necessarily wire payload if protocol cannot change):

- `requestId: string`
- `expectedType: "game_session_started" | "move_applied" | "evaluate_response" | "game_session_ended"`
- `generation: number`
- `timelineRev: number`

When response arrives:
1. Must match current `inFlight.requestId`.
2. Must match `inFlight.expectedType`.
3. Must match current `generation`.
4. Otherwise: log stale/unexpected and discard.

---

## Timeout & Retry Policy

- Timeouts become explicit events (`ENGINE_TIMEOUT`), not ad-hoc sleep loops.
- Recommended:
  - `start/end`: short bounded retries (e.g., 1 retry max)
  - `apply/eval`: no blind retry unless idempotency guaranteed by protocol
- On repeated failure -> `Degraded` (deterministic fallback).

---

## Implementation Plan (Incremental)

1. Introduce `GameActor` abstraction with mailbox per game.
2. Route handlers stop calling BGS directly; they dispatch events only.
3. Add `generation`, `timelineRev`, `engineSyncedRev`, `inFlight`.
4. Move current BGS calls behind actor actions.
5. Implement `RebuildingFromHistory` snapshot replay path.
6. Split eval-bar/history-cursor into orthogonal region logic.
7. Add structured logs for state transitions.
8. Add integration tests for race cases.

---

## Minimum Test Matrix

1. Move during `Evaluating` -> catches up exactly once.
2. Takeback during `ApplyingMove` -> stale response ignored, rebuild succeeds.
3. Move during rebuild -> no duplicate apply, catch-up happens.
4. Two rapid takebacks -> only newest generation mutates state.
5. Eval bar toggles during rebuild -> no sync side effects.
6. History cursor changes during bot turn -> no timeline mutation.
7. Engine timeout in each request type -> deterministic `Degraded` behavior.
8. Rematch during in-flight -> old generation responses ignored.

---

## Observability

Log every transition with:

- `gameId`
- `fromState` -> `toState`
- `event`
- `generation`
- `timelineRev`
- `engineSyncedRev`
- `requestId` (if any)

This is essential for debugging concurrency correctness.

---

## Non-Goals

- Replacing engine protocol semantics.
- Moving authoritative game rules out of existing domain logic.
- Coupling UI analysis controls to engine synchronization decisions.

---

## Summary

A per-game serialized actor + explicit state machine (with generation/revision invariants and strict request token matching) eliminates the current class of race conditions and patchwork waits. It keeps V3’s stateful engine-session benefits while making lifecycle behavior deterministic and testable.