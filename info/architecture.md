# Wallgame Architecture Overview

This document captures the current cross-cutting architecture decisions for Wallgame so future work can build on them consistently.

Sticking to this architecture ensures that UI/logic changes stay transport-agnostic, spectators remain first-class citizens, and future expansions (additional controller types or transport layers) can slot in with minimal churn.

## Controller-Centric Game Flow

UI/meta-logic should not care about whether we're in a "multiplayer" or "local" game; it should only care about what the controller for that seat can do.

Example:

- To show a draw button, you'd check `controller.capabilities.canOfferDraw`.
- When clicked, you'd call `controller.offerDraw()`.
- Whether that internally sends a WebSocket message or applies a local rule is the controller's job.

### Shared Interface

`GamePlayerController` covers all interactions a seat can perform.

- Required methods: `makeMove`, `respondToDrawOffer`, `respondToTakebackRequest`. These are methods initiated by the orchestrator: "What does the seat want to do in this situation?"
- Optional "voluntary" initiating actions: `resign`, `offerDraw`, `requestTakeback`, `giveTime`, `offerRematch`. Voluntary actions are side-actions a player chooses to initiate that are not forced by the core move/turn flow.
- Optional network response methods (only for remote controllers): `respondToRemoteDraw`, `respondToRemoteTakeback`, `respondToRemoteRematch`.

Controllers also expose `capabilities` (move/draw/takeback/rematch/chat flags), which determine the actions the seat can perform. For instance, a spectator cannot make moves (`canMove` is false).

### Concrete Controllers

All of these conform to the `GamePlayerController` union:

- **LocalHumanController**: Used for "your" seat in offline games. Queues local UI interactions and feeds them to the orchestrator.
- **RemotePlayerController**: Used for "your" seat in online games. Wraps `GameClient` (the WebSocket transport client for an online game seat) but fulfills the same interface by delegating to `LocalHumanController` for staged moves (which are purely local) and implementing each voluntary action via socket calls. Initialization: when `useOnlineGameSession` has a `gameHandshake` for this browser tab, `use-game-page-controller` installs a RemotePlayerController for that `playerId`.
- **EasyBotController**: a bot that makes moves automatically.
- **UnsupportedController**: For seat types that are not wired yet.

Opponents in online games have no controller. In an online game, the opponent's actions arrive via game-state updates from the server and managed directly by the orchestrator.

The UI always talks to a "manual controller", and that controller internally decides whether to apply the move locally or ship it over the network via GameClient. A manual controller (implements `ManualPlayerController`), in addition to being asked asynchronously for decisions (`makeMove`, `respondToDrawOffer`, `respondToTakebackRequest`), allows the UI to "push back" decisions via (`submitMove`, `submitDrawDecision`, `submitTakebackDecision`).

`PlayerControllerContext` is the input bundle passed to controllers when they're asked to act. It contains the current game state, the player ID, and the opponent ID. Draw and takeback contexts extend it to add `offeredBy` / `requestedBy`.

### Registry

## `seatActionsRef`

- Stores the current map from `PlayerId` to `GamePlayerController | null`.
- Only seats this client may command have a controller entry; uncontrollable seats (remote opponents, spectatated players) use `null`.
- Consumers never touch transport objects directly; they call controller methods acquired via `getSeatController(playerId)` and rely on capabilities/availability.

## `seatViewsRef`

- Holds the latest seat metadata (name, avatar, clock color, connection indicator) derived from the match snapshot.
- Every seat always has a view. When a match snapshot is unavailable (e.g., offline setup), the fallback view is built from the local placeholder configuration.
- UI rendering code reads from this ref to stay transport-agnostic, while action logic relies on `seatActionsRef`.

## Game page controller

This is the orchestrator.

- Creates the controllers and stores them in `seatActionsRef`. No post-hoc mutations: everything is computed before returning the controller object.
- Drives the main loop.
- Owns the logic of waiting for server game updates.
  - Details: when the game page controller calls `makeMove` on "your" `RemotePlayerController`, the controller sends your move via `GameClient.sendMove`. In the `then` of `makeMove`, the game page controller does not apply the move locally; instead it waits for the server.
- Orchestrates the entire game page through derived sections: `matching`, `board`, `timers`, `actions`, `chat`, `info`.
- Multiplayer rematch/draw/takeback flows call controller methods only.
- UI buttons call handlers from the orchestrator, which then flow to the correct controller.

- Spectator mode uses the same sections with spectator-aware derivations (e.g., `matchingPlayersForView`, `boardIsMultiplayer`, `rematchHandlersEnabled`).

### Spectator Flow

1. Detect `isSpectatorSession` (REST handshake failed, no local config, etc.).
2. Instantiate a `SpectatorSession` (spectator seats have seat views only, no controllers).
3. Feed REST snapshot + websocket updates through `applySpectatorSnapshotUpdate` / `applySpectatorStateUpdate`.
4. UI derives full read-only state from the same view-model pipeline as players.

## `use-meta-game-actions`

- Handles resign, draw offers, takebacks, give-time, and notifications.
- Always ooks up the current controller instance for that seat via the registry function (with `getSeatController(playerId)`). Multiplayer vs local logic is purely capability-driven (e.g., does the controller expose `offerDraw`?).
- Incoming remote offers call view-model handlers, which in turn prompt local controllers when appropriate.

## Class hierarchy

- Interface `BasePlayerController`: all controllers
  - Interface `ManualPlayerController`: UI-driven humans
    - Interface `LocalPlayerController`: Local browser-controlled human
      - Class `LocalHumanController`
    - Interface `RemoteHumanController`: Human seat whose game state lives on the server
      - Class `RemotePlayerController`
  - Interface `AutomatedPlayerController`: Automated bot seat
    - Class `EasyBotController`
  - Interface `UnsupportedPlayerController`: Placeholder seat
    - Class `UnsupportedController`

`GamePlayerController` is the union of all of those interfaces.


## Potential future TODOs

### Minor things

- Controller polymorphism in tests: Expand coverage to include spectator controllers and remote voluntary action methods.
- Spectator chat capability: Currently disabled via `isSpectatorSession`. If future spectators gain limited chat, wire it through controller capabilities instead of explicit session checks.
- Session lifecycle: Consider moving spectator session creation into a dedicated hook so other pages (e.g., replays) can reuse the same infrastructure.
