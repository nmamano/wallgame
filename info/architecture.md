# Wallgame Architecture Overview

This document captures the current cross-cutting architecture decisions for Wallgame so future work can build on them consistently.

## Controller-Centric Game Flow

### Shared Interface
- `GamePlayerController` covers all interactions a seat can perform.
- Required methods: `makeMove`, `respondToDrawOffer`, `respondToTakebackRequest`.
- Optional “voluntary action” methods: `resign`, `offerDraw`, `respondToRemoteDraw`, `requestTakeback`, `respondToRemoteTakeback`, `giveTime`, `offerRematch`, `respondToRematch`.
- Controllers also expose `capabilities` (move/draw/takeback/rematch/chat flags) used by the UI.

### Concrete Controllers
- **LocalHumanController**: queues local UI interactions and feeds them to the orchestrator.
- **RemotePlayerController**: wraps `GameClient` but fulfills the same interface by delegating to `LocalHumanController` for staged moves and implementing each voluntary action via socket calls.
- **RemoteSpectatorPlayerController**: read-only controller representing spectator seats (all interactive methods throw by design).
- **Automated / Unsupported**: bots or placeholder seats.

### Registry
- `playerControllersRef` always contains exactly two controllers, irrespective of mode (local, remote, bot, spectator).
- Consumers never touch transport objects directly; they call controller methods and rely on capabilities.

## `use-game-page-controller`
- Orchestrates the entire game page through derived sections: `matching`, `board`, `timers`, `actions`, `chat`, `info`.
- Spectator mode uses the same sections with spectator-aware derivations (e.g., `matchingPlayersForView`, `boardIsMultiplayer`, `rematchHandlersEnabled`).
- No post-hoc mutations: everything is computed before returning the controller object.
- Multiplayer rematch/draw/takeback flows call controller methods only; there are no bespoke socket helpers.

### Spectator Flow
1. Detect `isSpectatorSession` (REST handshake failed, no local config, etc.).
2. Instantiate a `SpectatorSession` and register two `RemoteSpectatorPlayerController`s.
3. Feed REST snapshot + websocket updates through `applySpectatorSnapshotUpdate` / `applySpectatorStateUpdate`.
4. UI derives full read-only state from the same view-model pipeline as players.

## `use-meta-game-actions`
- Handles resign, draw offers, takebacks, give-time, and notifications.
- Always resolves the acting controller from `getSeatController`. Multiplayer vs local logic is purely capability-driven (e.g., does the controller expose `offerDraw`?).
- Incoming remote offers call view-model handlers, which in turn prompt local controllers when appropriate.

## Remaining TODOs
- **Controller polymorphism in tests**: Expand coverage to include spectator controllers and remote voluntary action methods.
- **Spectator chat capability**: Currently disabled via `isSpectatorSession`. If future spectators gain limited chat, wire it through controller capabilities instead of explicit session checks.
- **Session lifecycle**: Consider moving spectator session creation into a dedicated hook so other pages (e.g., replays) can reuse the same infrastructure.
- **Error surfacing**: Voluntary action rejections surface as generic “Connection unavailable.” We could expose more granular error codes (e.g., capability missing vs. temporary socket issue).

Sticking to this architecture ensures that UI/logic changes stay transport-agnostic, spectators remain first-class citizens, and future expansions (additional controller types or transport layers) can slot in with minimal churn.
