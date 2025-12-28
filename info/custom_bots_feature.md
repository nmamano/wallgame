# Community Bots Feature Design

## Goal

Let any user plug their own locally-run bot into a specific game seat, without the server running untrusted code or paying compute. The user receives a per-seat token during game setup, runs a Golang client we provide (from source, compiled locally), and that client bridges the game to a local engine via stdin/stdout.

## Core UX

### Create Game

The Create Game screen has a "Custom bot" option for the player seat, which needs to be wired correctly as part of this feature.

- UI text: "You'll get an access token so that you can connect your own bot. See here for more information."
- Links to a blog post (to be written as part of this feature) describing the flow and the local engine protocol.

### Game Setup

When a game is created with one or more Custom Bot seats:

- The setup screen reveals a unique, per-seat token for each Custom Bot seat (similar  UI as for the link shown for Friend games).
- The token is intended to be used by exactly one local client connection.
- The UI also shows a sample command line to run the client with the token.

## High-Level Architecture

- Existing: browser players and spectators connect to the server via WebSockets.
- New: a user-run "custom-bot client" connects outbound to the server via WebSocket using the seat token.
- The server matches the seat token to a specific gameId + seat assignment and attaches the connection as the controller for that seat.
- The client does not implement bot logic itself; it runs a local engine process and exchanges messages with it over stdin/stdout.
- The server remains authoritative for rules, legality, clocks, and game state.
- The connection can be reused for rematch games within the same "match". The `seatToken` is only used for initial attachment; after attachment, the server keeps the same socket attached to the same seat role across rematches and notifies the client on rematch transitions. The same token CANNOT be used for unrelated games.
- The server-client protocol and the client-engine API are public-facing. They should be implementable by anyone with the spec.

## Trust and Invariants

- The server is the source of truth for game state and legality.
- The custom bot client and engine are untrusted and can only propose actions.

## Token Model (Seat-Scoped Tokens)

- Each Custom Bot seat gets a seatToken generated at game creation time.
- seatToken encodes or maps to:
  - gameId
  - seatId (which seat it controls)
- Tokens are single-use for attachment.
- Token rotation is not needed because tokens are per-game ephemeral.

## Server Components

### 1. Seat Token Issuance

- When creating a game:

  - For each seat marked "Custom Bot", generate seatToken.
  - Persist mapping: seatToken -> (gameId, seatId, status).
  - Return seatTokens in the game setup response.

### 2. Custom Bot WebSocket Gateway

A dedicated WS endpoint for custom bot clients.

Responsibilities:

- Accept connection attempts with seatToken.
- Validate seatToken and confirm the seat is eligible for attachment.
- Bind the socket to (gameId, seatId) as the controller for that seat.
- Enforce single active connection per seat.
- Disconnect handling. If the client disconnects while the game is in progress, treat it as an immediate resignation loss for that seat.
- Schema validation and size caps for all messages.
- If a client sends 10 invalid or stale messages, the server disconnects the client and treats it as a resignation.
- Rate limiting: at most 1 message per 0.2 seconds from the client to the server. (Note: This allows the client to play fast in bullet games, but it can't be abused since 10 invalid messages will kill the connection.)

### 3. Turn and Offer Dispatcher

The server-bot protocol is strict **request/response**. The server sends a `request` only when it needs a decision from the bot, and includes the full authoritative state with each request. See `info/custom_bot_protocol.md` for the exact message shapes and semantics.

When the bot is required to make a move:

- Server sends a `request` of kind `move` (includes current state and match snapshot).
- Server waits for a `response` (move or resign). If the bot runs out of time, they lose as usual.
  - The client can manage their time as they wish. There is no additional "liveness" ping or heartbeat.
  - Server validates and applies the response if legal.
- Clients CANNOT initiate meta-actions (draw offer, takeback request, give extra time, rematch offer).

Draw offers:

- If the opponent offers a draw and it's not the bot's turn, the server sends a `request` of kind `draw`.
- Draw requests do not block play: the server may send a newer `request` (which invalidates the previous one) if the game advances.
- The client is not required to consult its engine; it may auto-decline or ignore the request.
- If the opponent offers a draw when it is the bot's turn, the server automatically rejects it. The client doesn't get the offer.

Takebacks vs bots (server-only):

- Takebacks are not exposed to the bot client.
- The server automatically accepts takebacks in unrated games and rejects them in rated games. The client never needs to know.

### 4. Validation and Enforcement

- The server validates all bot responses:
  - legal in current position
  - correct seat to act
  - within time budget
  - not stale (responses must match the currently active `requestId`)
- Invalid responses produce a server `nack`; retryable errors allow re-responding to the same request (see `info/custom_bot_protocol.md`).

## Client Components (Go, Source-Distributed)

### Custom Bot Client Responsibilities

- CLI that accepts:
  - --token <seatToken>
  - --engine "<command to launch local engine>" (optional, default is a dumb bot)
  - optional logging flag
- Maintains the WS connection to the server.
- Converts server events into engine requests sent over engine stdin.
- Converts engine responses from stdout into server commands.

### Local Engine Interface (stdin/stdout, Language-Agnostic)

- The engine is any executable or script (in any language).
- The client communicates with the engine using JSON:
  - Client -> Engine: turn request or meta-action prompt
  - Engine -> Client: chosen move or meta-action response
- The engine does not implement networking.

### Client vs Engine Life Cycle

- The client lives for the duration of the game, including rematches.
- The engine is launched and killed for every move.
- The client treats the engine as a standalone, stateless command that expects a single JSON message on stdin and produces a single JSON message on stdout.

## Protocol Overview (Server <-> Bot Client)

This is intentionally high-level. For the full public protocol spec, see `info/custom_bot_protocol.md`.

### Handshake

- Client connects to the custom bot WebSocket endpoint and sends an `attach` message including `seatToken`.
- Server replies with `attached` or `attach-rejected`.

### Gameplay Events

Server -> Client (high-level):
- `request` when the server needs a decision (move/draw/rematch), always including full state + snapshot
- `ack` / `nack` responses to bot `response` messages
- `rematch-started` when a rematch game is created and the bot connection continues into the new game

Client -> Server (high-level):
- `attach`
- `response` (answering a single active `requestId`)

## State Snapshot Strategy

- The server sends authoritative state snapshots:
  - once on successful attachment (`attached`)
  - whenever it needs a bot decision (embedded in `request`)
  - on rematch transition (`rematch-started`)
- Clients should treat each `request` as a complete, self-contained snapshot suitable for decision making, and should ignore any unknown fields for forward compatibility.

## Security and Abuse Controls

- Seat tokens are unguessable and scoped to a single seat in a single game.
