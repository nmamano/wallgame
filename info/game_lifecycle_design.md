# Game Identity, Entry, and Lifecycle - North Star Design

This document captures the non-negotiable invariants and the clean architecture for game identity, URLs, entry semantics, rematches, spectating, and future replay support.

This is the reference point.
If code diverges from this, the code is wrong.

The current UI is fine. We are not making functional changes. We are preparing the codebase for future features (like game persistence in the DB for past game replays).

## Principles

- The app is not finished/launched yet, so we want the architecture to be correct from the start. Don't add things for backward compatibility - there is no data yet.
- Correct abstractions, not hacks.
- It is encouraged to identify issues as we move toward the north star design and take detours to clean them up.
- Avoid optionality. Optionality hides bugs because it collapses "unknown" and "not provided." If a value is required for correctness, it must be: non-optional, and explicitly nullable when unknown.
- If UI bugs persist, stop coding and trace truth flow.
- Unknown beats wrong. When the client infers instead of being told, we often end with a race condition. Avoid this pattern.
- Avoid temporary flows or dual flows.

## Lifecycle

### 1. User creates a game (host)

- **Client**
  - The user clicks **"Create game"** on the setup page.
  - The client calls **`POST /api/games`** with:
    - the selected configuration (variant, time control, rated flag, board size),
    - the creator's display name and appearance.

- **Server**
  - Generates a fresh **`gameId`** with `nanoid(8)` and creates a new in-memory `GameSession` with:
    - `status: "waiting"` (there is still at least one seat to fill),
    - a **host** seat bound to the creator (including `authUserId` if logged in),
    - a **joiner** seat with placeholder display name (`"Friend"` or `"Player 2"`), `ready: false`.
  - Randomly decides whether the host will be **Player 1** or **Player 2** (which determines who moves first and pawn positions).
  - Returns a JSON response (typed as `GameCreateResponse`) with:
    - `gameId` (the session id),
    - `snapshot: GameSnapshot` (the initial match status, including `status: "waiting"` and both seats),
    - host seat credentials: `hostToken` (HTTP/seat credential) and `hostSocketToken` (WS credential),
    - `shareUrl` for `/game/:gameId`.

- **Client (after POST)**
  - Locates the host entry in `snapshot.players` to extract the host's `playerId`.
  - Saves a local **handshake** for this game:
    - `{ gameId, token: hostToken, socketToken: hostSocketToken, role: "host", playerId, shareUrl }`.
  - Navigates to **`/game/:gameId`**.

- **Client (game page)**
  - On mount, the game page controller:
    - Reads any stored handshake for `gameId` (from `sessionStorage`).
    - Calls **`GET /api/games/:gameId`** (via `resolveGameAccess`) with:
      - `gameId`,
      - the stored `token` (if present).
  - The server resolves access as **`kind: "player"`** for the host and responds with:
    - a fresh `matchStatus: GameSnapshot`,
    - full `state: SerializedGameState`,
    - a `seat` object containing the host seat's `role`, `playerId`, `token`, and `socketToken`.
  - The client updates the stored handshake if the server rotated the seat credentials.
  - Using the `socketToken`, the client creates a `RemotePlayerController` for the host seat and opens the **player WebSocket** for this game.
  - While `matchStatus.status === "waiting"`:
    - The UI displays a **"waiting for players"** state (matching panel / placeholder),
    - The host's controller exposes `canMove = false` (and other move/meta actions are disabled),
    - The board is rendered in a non-interactive or partially-initialized state until the match becomes ready.

- **Server (WebSocket)**
  - Once the host connects its player WebSocket, the server:
    - Pushes authoritative game state and match-status snapshots over the socket,
    - Will later send updates when the joiner claims the open seat or when the game transitions to `"in-progress"` or `"completed"`.

### 2. Second player joins an existing online game

- **Client (initial resolve)**
  - The second user opens **`/game/:gameId`** (e.g. via the host's `shareUrl` or from the live-games / matchmaking list).
  - On load, the game page controller:
    - Attempts to read a stored handshake for `gameId` (usually none on a first visit from this browser/device),
    - Calls **`GET /api/games/:gameId`** via `resolveGameAccess`, passing:
      - `gameId`,
      - `token` from the stored handshake if present (often `undefined` for a first-time joiner).

- **Server (resolve access)**
  - Looks up the `GameSession` by `gameId`.
  - Attempts to resolve the caller's role:
    - **By token**: if the provided `token` matches the host or joiner seat, the caller is that player.
    - **By auth user id**: if the authenticated user id matches the stored owner of a seat (`authUserId`), the server:
      - refreshes that seat's `token` and `socketToken`,
      - returns `kind: "player"` with updated seat credentials.
    - Otherwise, if the match is still waiting for a joiner (`status: "waiting"` and joiner not ready), returns `kind: "waiting"`.
    - If the match is already active and the caller owns no seat, returns `kind: "spectator"` (or `kind: "replay"` for completed games).
  - **Important:** `GET /api/games/:gameId` never assigns a brand-new seat owner; it only **resolves or refreshes** existing ownership.

- **Client (claiming the open seat)**
  - If the resolve call returns `kind: "waiting"` and the UI is in a mode where joining is allowed (e.g. invite-friend or matchmaking), the game page exposes a **"Join game" / "Claim seat"** action.
  - When the user chooses to claim the open seat, the client calls **`POST /api/games/:gameId/join`** (via `joinGameSession`) with:
    - `gameId`,
    - the joiner's chosen display name and appearance.

- **Server (seat claim via POST /join)**
  - `joinGameSession` checks the joiner seat:
    - If the seat is still unclaimed (`ready === false`):
      - Marks it as ready,
      - Sets display name and appearance from the request,
      - Ties it to the caller's `authUserId` (if logged in),
      - Updates the match `status` to `"ready"` if the host is already ready.
      - Returns a JSON response (typed as `JoinGameResponse`) with:
        - `role: "player"`,
        - `seat` (host/joiner role for this player),
        - `playerId`,
        - `token` and `socketToken` for the claimed seat,
        - `snapshot: GameSnapshot` (now typically with `status: "ready"`),
        - `shareUrl`.
    - If the seat is already claimed but the same authenticated user calls again, the server may refresh that seat's credentials and still return `role: "player"`.
    - Otherwise, the server returns `role: "spectator"` (the join slot is full and the caller becomes a spectator).
  - After a successful join as a player, the server:
    - Broadcasts the updated match snapshot to all connected player WebSockets for that game (the host learns that the game is now ready),
    - For matchmaking games, removes the game from the lobby list and broadcasts an updated matchmaking snapshot.

- **Client (after seat claim)**
  - If the `POST /join` response indicates `role: "player"`:
    - The joiner's client saves a handshake `{ gameId, token, socketToken, role, playerId, shareUrl }`.
    - It may trigger a fresh **`GET /api/games/:gameId`** via `resolveGameAccess` to:
      - confirm `kind: "player"`,
      - obtain the latest `matchStatus` and serialized `state`,
      - synchronize with any rotated seat credentials.
    - Using the `socketToken`, the joiner establishes a `RemotePlayerController` and opens the **player WebSocket**.
    - Once both seats are ready (`status: "ready"`), the client:
      - hides or minimizes the waiting UI,
      - enables move/meta actions for the appropriate local player id.
  - If the `POST /join` response indicates `role: "spectator"`:
    - The client stores no player handshake for this game,
    - Opens a **spectator WebSocket** instead,
    - Renders the game in spectate-only mode (no move actions, no seat ownership).

### 3. Spectator joins an existing game

- **Client (initial resolve)**
  - A third party opens **`/game/:gameId`** (e.g. via the host's `shareUrl`, a live-games list, or a rematch link).
  - On load, the game page controller:
    - Reads any stored handshake for `gameId` (typically none for first-time spectators),
    - Calls **`GET /api/games/:gameId`** via `resolveGameAccess`, passing:
      - `gameId`,
      - `token` from any stored handshake if present (often `undefined` for spectators).
  - The server resolves access as **`kind: "spectator"`** when:
    - The caller does not own a seat (token and `authUserId` do not match any seat owner),
    - And the game is in a spectatable lifecycle state (`status: "ready"` or `"in-progress"`).
  - The response includes:
    - `gameId`,
    - `matchStatus: GameSnapshot` (including lifecycle state and players),
    - `state: SerializedGameState`.
  - No seat credentials (`token` / `socketToken`) are returned for spectators.

- **Client (spectator session setup)**
  - When `resolveGameAccess` returns `kind: "spectator"`:
    - The client **does not** create any `GamePlayerController` entries for this browser (no controllable seats),
    - Instead, it instantiates a **`SpectatorSession`**:
      - Derives seat views from `matchStatus` (`seatViewsRef` only),
      - Exposes read-only board, timers, and history derived from `state`,
      - Marks `isSpectatorSession = true` so meta-actions (resign, draw, rematch, etc.) are disabled.
    - Any stale player handshakes for this `gameId` are cleared to avoid leaking seat credentials across roles.

- **Client (spectator WebSocket)**
  - After resolve (and only after), the client opens the **spectator WebSocket** for this `gameId`:
    - Uses `gameId` and any server-provided spectator credentials (if applicable) to subscribe to:
      - `matchStatus` updates (lifecycle transitions, seat connectivity, scores),
      - `state` updates (moves, clocks, history).
  - Incoming snapshots are fed through the same view-model pipeline as for players:
    - `applySpectatorSnapshotUpdate` / `applySpectatorStateUpdate` update the spectator session,
    - The UI re-renders from derived read-only state.
  - Spectators cannot:
    - Make moves,
    - Offer/accept draws or takebacks,
    - Offer rematches.
    - All such affordances are gated behind controller capabilities and are absent in spectator sessions.
    - **Server gate:** the spectator WebSocket accepts upgrades only when the authoritative lifecycle is `"ready"` or `"in-progress"`. Waiting, completed, or aborted games reject spectator sockets so ready (0-move) games remain watchable without waiting for the first move.

- **Lifecycle and rematch behavior**
  - **Waiting games (`status: "waiting"`)** are **not spectatable**; `GET /api/games/:gameId` returns `kind: "waiting"` instead of `kind: "spectator"` until both seats are filled.
  - **Ready and in-progress games** are always spectatable:
    - Third parties resolve directly to `kind: "spectator"`,
    - Seat owners resolve to `kind: "player"` with credentials.
  - **Completed games** will eventually resolve as `kind: "replay"` (future), which:
    - Uses the same neutral `/game/:gameId` URL,
    - Does not open a live spectator WebSocket (replay is offline from the server's perspective).
  - When a rematch is accepted and a **new `gameId`** is created:
    - Spectators receive a `rematch-started` message containing `newGameId` (but no seat credentials),
    - The UI offers a link to `/game/:newGameId`, where the same spectator flow applies.

### 4. Rematch flow

- **Triggering a rematch (completed game)**  
  - Once a game reaches `status: "completed"`, the game page controller exposes rematch actions for eligible players (typically both seats of the finished game).
  - A player initiates a rematch by invoking a voluntary controller action (e.g. `controller.offerRematch()`), which:
    - Sends a rematch request over the **player WebSocket** for the current `gameId`,
    - References the completed game instance so the server can fork configuration and series metadata.
  - The opponent receives a rematch offer via a socket message, which the client surfaces in the UI.
  - The opponent can accept or decline the offer via controller methods (e.g. `controller.respondToRemoteRematch("accept" | "decline")`).

- **Server behavior on rematch acceptance**  
  - When a rematch offer is **accepted**:
    - The server creates a new `GameSession` with a fresh `newGameId` (using `nanoid(8)`), never reusing the old `gameId`.
    - It **forks configuration and series metadata** from the completed game:
      - Variant, time control, rated flag, board size, and `matchType` are copied,
      - Series score / match history is continued via series metadata, not by mutating the completed game.
    - Seats are re-established for the new game:
      - The original host/joiner (Player A/B) remain the same roles for identity and URL semantics,
      - Player 1/2 (who moves first and pawn positions) may be re-determined according to the configured rematch policy.
    - The old game becomes **immutable** (`status: "completed"` with no further moves or meta-actions).
  - **Messaging invariant:**
    - The server **first** sends an `actionAck` confirming the rematch acceptance (acknowledging the voluntary action),
    - **Then** it broadcasts a `rematch-started` message to all connected sockets for that `gameId`.

- **Message shapes and recipients**  
  - **Players** (seat owners of the completed game) receive:
    - `rematch-started` containing:
      - `newGameId`,
      - full seat credentials for the new game:
        - `role` (host/joiner for this player),
        - `playerId` for the new game,
        - `token` and `socketToken` for the new seat,
      - initial `snapshot: GameSnapshot` for `newGameId`,
      - `shareUrl` for `/game/:newGameId`.
  - **Spectators** of the completed game receive:
    - `rematch-started` containing:
      - `newGameId`,
      - initial `snapshot: GameSnapshot` for `newGameId` (no seat credentials),
      - `shareUrl` for `/game/:newGameId`.
  - Clients must be robust to both variants:
    - Players expect seat credentials and set up a player session,
    - Spectators expect no credentials and set up a spectator session.

- **Client behavior for players (navigating to the new game)**  
  - On receiving `rematch-started` with seat credentials:
    - The client saves a new **handshake**:
      - `{ gameId: newGameId, token, socketToken, role, playerId, shareUrl }`.
    - It **closes the current WebSocket** for the old `gameId` (respecting the "one WS per (gameId, role)" invariant).
    - It navigates to **`/game/:newGameId`**.
  - On the new game page:
    - The game page controller reads the stored handshake for `newGameId`,
    - Calls **`GET /api/games/:newGameId`** via `resolveGameAccess`:
      - Expects `kind: "player"` for rightful seat owners,
      - Receives `matchStatus: GameSnapshot`, `state: SerializedGameState`, and a `seat` object.
    - It updates the handshake if the server rotates credentials, then:
      - Creates a `RemotePlayerController` using `socketToken`,
      - Opens the **player WebSocket** for `newGameId`,
      - Renders the game as a fresh lifecycle (`waiting` → `ready` → `in-progress` → `completed`) independent of the old one.

- **Client behavior for spectators (following the rematch)**  
  - On receiving `rematch-started` **without** seat credentials:
    - The client does **not** store a player handshake for `newGameId`.
    - The UI surfaces a **CTA / link** to `/game/:newGameId` (e.g. "Game continues in a new match").
    - Spectators remain on the completed game until they explicitly follow the link.
  - When a spectator later visits `/game/:newGameId`:
    - They enter via the standard flow:
      - Call `GET /api/games/:newGameId`,
      - Resolve as `kind: "spectator"` or `kind: "player"` depending on seat ownership and lifecycle.
    - A **spectator WebSocket** is opened only after resolve, and only for `newGameId`.

- **Invariants and guardrails**  
  - **One lifecycle per gameId:**  
    - The original `gameId` and the `newGameId` are distinct lifecycles; rematch never "resets in place".
  - **URL semantics:**  
    - Both games use the canonical URL form `/game/:gameId`,
    - The old URL continues to show the completed game; the new URL shows the new lifecycle.
  - **Access resolution:**  
    - Even after a rematch, **all entry** to `/game/:newGameId` goes through `GET /api/games/:newGameId -> { kind: ... }` with no client-side guessing.
    - Seat credentials in `rematch-started` are a **convenience for continuity**, not a bypass of resolve semantics.
  - **WebSocket lifecycle:**  
    - Clients must close the old socket for the completed game before or while navigating to `/game/:newGameId`,
    - There must never be duplicate sockets for the same `(gameId, role)`,
    - Rejected or invalid rematch sockets must never crash the server, and `onClose` must remain idempotent.

# Concepts

## 1. Core Identity Invariant

One NanoID corresponds to exactly one game lifecycle.

A game lifecycle includes:
- creation / matchmaking
- waiting / ready
- in-progress
- completed
- replay (future)

A game lifecycle never resets.

Consequences:
- Rematches always create a new gameId
- Bots, friend games, matchmaking games all follow the same rule
- URLs are stable and unambiguous
- Persistence (not implemented yet) is 1:1 with URLs
- Any "reset in place" is a design bug

## 2. URL Semantics

There is exactly one canonical URL:

/game/:gameId

This URL must work for:
- joining a game as a player
- spectating a live game
- viewing a completed game (replay, future)

The URL never changes. The URL never encodes role. Only the resolved access role changes. The server resolves the role.

No /spectate, no /bootstrap, no variant URLs.

## 3. Entry Is Resolved, Not Guessed

The client never tries to join and falls back.

Entering /game/:gameId always begins with one server call:

GET /api/games/:gameId -> { kind: ... }

It returns a discriminated union describing what the caller is allowed to do. The kinds are:

- player
- spectator
- waiting
- replay (future)
- not-found

Rules:

- Only rightful owners get seat credentials.
- Everyone else is a spectator.
- Full matchmaking never throws.
- 0-move ready games are spectatable.

This endpoint never throws for normal game states.

## 4. Resolve Access Contract

GET /api/games/:gameId returns exactly one of:

- kind: player
  - includes: gameId, seat credentials, initial state, matchStatus
- kind: spectator
  - includes: gameId, initial state, matchStatus
- kind: waiting
  - includes: gameId, reason
- kind: replay (future, not supported yet)
  - includes: gameId, replayRef
- kind: not-found

Rules:
- Seat credentials are returned only to the rightful seat owner
- All other callers get spectator
- No client-side inference, no retries, no fallback logic

Identity is server-owned and atomic. No partial identity, no reconstruction, no intent-based guessing.

## 5. Game State Machine

A game is always in exactly one state:

waiting -> seats not filled
ready -> both seats filled, 0 moves
in-progress
completed

Spectating rules:
- waiting: not spectatable
- ready: spectatable (even with 0 moves)
- in-progress: spectatable
- completed: live spectate disabled (replay only, in the future, not supported yet)

Spectatability is based on state, not moves.
Move count is never used as a proxy for state.

## 6. Rematches

A rematch is a fork, not a reset.

Rules:
- Accepting a rematch:
  - creates a new gameId.
  - forks configuration plus series metadata.
  - old game becomes immutable.
- Players navigate to /game/:newGameId.
- Spectators are offered a link to the new game.

Messaging invariant:
- Action request -> actionAck first.
- Then broadcast rematch-started.

Message shapes:
- players receive: rematch-started with newGameId plus seat credentials.
- spectators receive: rematch-started with newGameId only.

Clients must be robust if they receive either variant.

## 7. WebSocket Lifecycle (Critical)

Exactly one WebSocket connection per (gameId, role).

Rules:
- Resolve access is pure (no WS side effects).
- Only one owning hook/component (e.g., useOnlineGameSession) creates and tears down the WS.
- Effects must be guarded against re-runs. Re-renders must not create new WS connections.
- Old WS must be closed before navigating to a new gameId.
- Duplicate WS connects for the same token are a bug.

Server safety:
- Rejected or unauthenticated sockets must never crash the server.
- onClose must be idempotent and non-throwing.

Don't use refs to "freeze" values. It may help short-term, but the real fix is:

- branch purely on access.kind
- ensure WS ownership is centralized

### Resolve-before-WS is needed for correctness

Opening the WebSocket before resolving introduces ambiguity:

- WS snapshots can arrive before identity is known.
- Later resolve data cannot fully undo that misclassification.

Invariant: Resolve game access is a pure, authoritative step. Side effects (WS, controllers, timers) come after resolve.

Network order is not what matters.

## 8. Matchmaking Semantics

- Matchmaking games that are full:
  - never throw
  - resolve to spectator for third parties
- "Game is no longer accepting players" is never surfaced to the UI
- Live games list includes:
  - ready
  - in-progress

## 9. Offline / Bot Games

Offline games follow the exact same invariants:
- one gameId per lifecycle
- rematch equals new gameId
- same /game/:id URL semantics
- persistance is not implemented yet local or remote

## 10. Client Architecture Rules

- No legacy paths
- No parallel entry logic
- No /spectate endpoint
- No cached "latest access" driving behavior
- No implicit auto-join or auto-ready

The UI:
- switches solely on resolve.kind
- renders state directly from resolved data
- opens exactly one WS accordingly

## 11. Testing Invariants (Must Never Regress)

At minimum, tests must assert:

1. A ready game with 0 moves is spectatable
2. A full matchmaking game resolves to spectator
3. A rightful owner resolves to player with seat creds
4. Rematch:
   - sends actionAck before rematch-started
   - forks new gameId
5. No duplicate WebSocket connections for a single gameId

Tests will be added eventually.

## 12. Mental Model Summary

- GameId equals identity
- Resolve access, do not guess
- No resets
- No hidden state machines
- No special cases

### Match type invariants

- `matchType` (e.g., "friend" or "matchmaking") is immutable once a game is created.

The user requests to create a game of a given `matchType`, but it is the server who authoritatively says the match type. The client must follow the server's authority rather than try to derive the match type.

We sometimes hit bugs because some layer still behaved as if:

what the user asked for = what the game is

The invariant to enforce is stronger and non-negotiable:

Game identity is created by the server, and identity includes `matchType` and lifecycle.

- `matchType` is not recoverable from intent, handshake, or route.
- If the server has not said it yet, the correct client state is unknown, not a guess.
- If a value is part of identity, any fallback is a correctness bug.

`Unknown` is a first-class state, not an error or loading glitch.

Treating `Unknown` as `temporarily friend` or `temporarily board-visible` causes semantic corruption, not cosmetic bugs.

We should explicitly represent:

- `matchType: null`
- `lifecycle: waiting`

And tell the UI that these are valid, stable states.

If the server has not resolved something yet, the UI must render a neutral, non-committal state - never the closest guess. This applies equally to:

- match type
- opponent identity
- playability
- spectator vs player affordances

### Presence of data is never a lifecycle signal

One of the biggest hidden bugs we have had:

"We have state, so we can render the board."

- State existence != playability.
- State existence != lifecycle advancement.

Invariant:

UI transitions must key only off explicit lifecycle fields (waiting, ready, in-progress, completed), never off structural signals like:

- state presence
- move count
- player list length
- websocket connection

This invariant eliminates race conditions.

### Server rules

Server must be defensive, never fatal.

- Rejected or invalid sockets must never crash the process.
- `onClose` must be idempotent and non-throwing.

