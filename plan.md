# V3 Bot Protocol Migration Plan

## Overview

Migrate from V2 "proactive bot protocol" to V3 "game session bot protocol". Key change: from **stateless per-move engine spawning** to **stateful Bot Game Sessions (BGS)** with persistent engine processes.

**Reference:** `info/v3_migration_plan.md`

---

## Task List

```json
[
  {
    "category": "phase1-types",
    "description": "Fix GameInitialState types to use explicit p1/p2 fields",
    "steps": [
      "Update StandardInitialState in shared/domain/game-types.ts to use { p1: ..., p2: ... } instead of Record<PlayerId, ...>",
      "Update ClassicInitialState similarly",
      "Update SurvivalInitialState similarly",
      "Verify with tsc that no type errors introduced"
    ],
    "passes": true
  },
  {
    "category": "phase1-types",
    "description": "Update custom-bot-protocol.ts with V3 message types",
    "steps": [
      "Bump CUSTOM_BOT_PROTOCOL_VERSION to 3",
      "Add BgsConfig interface",
      "Add StartGameSessionMessage and GameSessionStartedMessage",
      "Add EndGameSessionMessage and GameSessionEndedMessage",
      "Add EvaluatePositionMessage and EvaluateResponseMessage",
      "Add ApplyMoveMessage and MoveAppliedMessage",
      "Remove timeControls from VariantConfig",
      "Remove V2 request/response types (MoveRequestMessage, DrawRequestMessage, etc.)",
      "Verify with tsc"
    ],
    "passes": true
  },
  {
    "category": "phase1-types",
    "description": "Update engine-api.ts to re-export V3 types",
    "steps": [
      "Update shared/custom-bot/engine-api.ts to export V3 BGS message types",
      "Ensure types match server-client protocol",
      "Verify with tsc"
    ],
    "passes": true
  },
  {
    "category": "phase2-server",
    "description": "Create bgs-store.ts for BGS state management",
    "steps": [
      "Create server/games/bgs-store.ts",
      "Implement BgsHistoryEntry interface",
      "Implement BotGameSession interface",
      "Implement createBgs, getBgs, endBgs functions",
      "Implement addHistoryEntry, getBgsHistory functions",
      "Verify with tsc"
    ],
    "passes": true
  },
  {
    "category": "phase2-server",
    "description": "Rewrite custom-bot-store.ts for V3",
    "steps": [
      "Remove V2 request queue (requestQueue, activeRequest, enqueueRequest, tryProcessNextRequest)",
      "Add activeBgsSessions Set to track client's active BGS IDs",
      "Remove protocolVersion field (all clients are V3)",
      "Keep client registry, bot registry, connection management",
      "Verify with tsc"
    ],
    "passes": true
  },
  {
    "category": "phase3-websocket",
    "description": "Rewrite custom-bot-socket.ts for V3 BGS handlers",
    "steps": [
      "Update attach handling to require protocolVersion === 3",
      "Add handleGameSessionStarted handler",
      "Add handleGameSessionEnded handler",
      "Add handleEvaluateResponse handler with ply validation",
      "Add handleMoveApplied handler",
      "Implement public API: startBgsSession, endBgsSession, requestEvaluation, applyBgsMove",
      "Implement 10-second timeout policy",
      "Implement abuse protection (64KB limit, unexpected message tracking)",
      "Verify with tsc"
    ],
    "passes": true
  },
  {
    "category": "phase4-game",
    "description": "Update game-socket.ts for V3 bot game flow",
    "steps": [
      "On game creation: Create BGS, send start_game_session",
      "Get initial evaluation for starting position",
      "Implement bot turn flow: use bestMove from history, apply_move, evaluate_position",
      "Implement human turn flow: wait, apply_move, evaluate_position",
      "Implement draw handling: server auto-rejects",
      "Implement takeback handling: end BGS, start new BGS, replay moves",
      "On game end: send end_game_session",
      "Verify with tsc"
    ],
    "passes": false
  },
  {
    "category": "phase5-eval",
    "description": "Add V3 eval protocol message types",
    "steps": [
      "Add EvalHistoryMessage to shared/contracts/eval-protocol.ts",
      "Add EvalUpdateMessage for streaming updates",
      "Verify with tsc"
    ],
    "passes": false
  },
  {
    "category": "phase5-eval",
    "description": "Rewrite eval-socket.ts for BGS-based eval bar",
    "steps": [
      "Create BGS on eval bar enable (bot games reuse existing, human vs human creates new)",
      "Implement initializeBgsHistory with move replay",
      "Implement ply validation with error handling",
      "Send full history to client on initialization",
      "Subscribe to game move events for streaming updates",
      "Implement BGS closure logic (live games on end, replays immediately)",
      "Implement shared BGS for human vs human with pending state",
      "Verify with tsc"
    ],
    "passes": false
  },
  {
    "category": "phase6-client",
    "description": "Update ws-client.ts for long-lived engine",
    "steps": [
      "Start engine once at startup instead of per-move",
      "Implement handleStartGameSession pass-through",
      "Implement handleEvaluatePosition pass-through",
      "Implement handleApplyMove pass-through",
      "Implement handleEndGameSession pass-through",
      "Verify with tsc"
    ],
    "passes": false
  },
  {
    "category": "phase6-client",
    "description": "Rewrite engine-runner.ts for long-lived process",
    "steps": [
      "Create EngineProcess class with spawn method",
      "Implement JSON-lines communication over stdin/stdout",
      "Implement send method with pending request tracking",
      "Implement kill method for cleanup",
      "Verify with tsc"
    ],
    "passes": false
  },
  {
    "category": "phase7-dummy",
    "description": "Rewrite dummy-engine for V3 stateful protocol",
    "steps": [
      "Convert to JSON-lines stdin/stdout protocol",
      "Implement session Map for tracking multiple BGS",
      "Implement start_game_session handler",
      "Implement evaluate_position handler",
      "Implement apply_move handler",
      "Implement end_game_session handler",
      "Verify with tsc and test manually"
    ],
    "passes": false
  },
  {
    "category": "phase8-engine",
    "description": "Design Deep Wallwars BGS adapter interface",
    "steps": [
      "Document bgs_engine.cpp interface in info/",
      "Define BgsSession struct (bgs_id, state, mcts_tree, variant)",
      "Define shared resources (thread pool, batching queues, eval caches)",
      "Define JSON protocol for stdin/stdout",
      "Document MCTS tree reuse strategy for apply_move"
    ],
    "passes": false
  },
  {
    "category": "phase9-frontend",
    "description": "Update game-setup.tsx to hide time control for bot games",
    "steps": [
      "Hide time control selector when mode === 'vs-ai'",
      "Ensure bot game configs don't include time control field",
      "Verify rated: false for bot games",
      "Verify with tsc and manual testing"
    ],
    "passes": false
  },
  {
    "category": "phase9-frontend",
    "description": "Update use-bots.ts and bots-table.tsx",
    "steps": [
      "Remove timeControl from BotsQuerySettings in use-bots.ts",
      "Update API calls to not filter by time control",
      "Remove time control column from bots-table.tsx",
      "Update filtering logic",
      "Verify with tsc"
    ],
    "passes": false
  },
  {
    "category": "phase9-frontend",
    "description": "Update eval-client.ts for V3 history-based protocol",
    "steps": [
      "Handle eval-history message (full history on connect)",
      "Handle eval-update message (streaming updates)",
      "Show pending state during BGS initialization",
      "Verify with tsc"
    ],
    "passes": false
  },
  {
    "category": "phase10-cleanup",
    "description": "Delete V2 stateless engine code",
    "steps": [
      "Remove BotRequestKind, MoveRequestMessage, DrawRequestMessage, EvalRequestMessage",
      "Remove BotResponseAction, BotResponseMessage",
      "Remove SerializedGameState from request messages",
      "Remove spawn-per-move logic from engine-runner.ts",
      "Remove per-request queue logic from custom-bot-store.ts",
      "Verify with tsc"
    ],
    "passes": false
  },
  {
    "category": "phase10-testing",
    "description": "Run full test suite and fix issues",
    "steps": [
      "Run bun run lint",
      "Run bun run test",
      "Fix any failing tests",
      "Run bun run build",
      "Verify clean build"
    ],
    "passes": false
  }
]
```

---

## Agent Instructions

1. Read `activity.md` first to understand current state
2. Find next task with `"passes": false`
3. Complete all steps for that task
4. Verify with `bun run lint` and `tsc --noEmit` (or as specified in steps)
5. Update task to `"passes": true`
6. Log completion in `activity.md`
7. Make one git commit for that task
8. Repeat until all tasks pass

**Important:** Only modify the `passes` field. Do not remove or rewrite tasks.

---

## Completion Criteria

All tasks marked with `"passes": true`
