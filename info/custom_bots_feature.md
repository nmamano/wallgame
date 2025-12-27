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
- The connection can be reused for rematch games within the same "match". The seatToken is only used for initial attachment; after attachment, the server assigns a connection-scoped seat identity that persists across rematches within the same match created from the initial game. The same token CANNOT be used for unrelated games.
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

When it is the bot-controlled seat's turn:

- Server sends an event to the bot client including:
  - remaining time and time controls
- The current position/state is delivered via the normal `state` snapshot stream; the turn prompt itself should not need to embed state.
- Server waits for a response (move or resign). If the client runs out of time, they lose as usual.
  - The client can manage their time as they wish. There is no additional "liveness" ping or heartbeat.
  - Server validates and applies the response if legal.
- Clients CANNOT initiate meta-actions.

Draw offers (simplified, advisory):

- Offers are created at a specific moveCount and are associated with the position at that moveCount.
- The server only delivers a draw offer to a bot-controlled client when:
  - the bot is NOT the activeSeat, and
  - offer.moveCount == current moveCount.
- The server rejects draw offers automatically otherwise.
- The client is NOT required to respond to a draw offer. It MAY evaluate the offer via its engine and respond accept/decline.
- An offer expires immediately when moveCount increases. Moves increment moveCount and implicitly decline existing offers.
- If the client is evaluating an offer and receives a state with a higher moveCount, the evaluation MUST be discarded and no response is sent for the expired offer.
- Offers are advisory and cannot block, pause, or delay play.

Takebacks vs bots (server-only):

- Takebacks are not exposed to the bot client.
- The server automatically accepts takebacks in unrated games and rejects them in rated games. The client never needs to know.

### 4. Validation and Enforcement

- The server validates all moves:
  - legal in current position
  - correct seat to act
  - within time budget
  - consistent with current game revision (reject stale responses)
- Invalid or late responses return an error to the client.

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

### Handshake

- Client connects to server WS endpoint and sends seatToken.
- Server replies accepted/rejected with:
  - gameId, seatId, game config (variant, time controls, board width/height, ...)
  - protocol version info (server + client)
- Connection is considered "attached" after acceptance.

### Gameplay Events

Server -> Client:
- `state` snapshots: authoritative position + clocks + config
- `turn` prompts: indicates it is the bot's turn to act for a specific `moveCount`
- meta-action events: draw offered, rematch offered.
- game-over
- error responses for invalid or stale moves (the client logs these)

Client -> Server:
- move submission (using standard notation)
- meta-action responses (accept/decline draw, rematch)

## State Snapshot Strategy

- Server sends a minimal, canonical representation sufficient for decision-making:
  - board state
  - player to act
  - game config (variant, time controls, board width/height, ...)
  - move history index for stale-response rejection
  - clocks/time remaining
- Server remains authoritative regardless.

## Security and Abuse Controls

- Seat tokens are unguessable and scoped to a single seat in a single game.
