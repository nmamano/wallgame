# Wallgame Custom Bot Server <-> Client Protocol (v1)

This document specifies the public WebSocket protocol between a Wallgame server and a **custom bot client**.

The server is authoritative for rules, legality, clocks, ordering, and match lifecycle. A bot client is untrusted and can only respond to server requests.

Source of truth in this repo:

- `shared/contracts/custom-bot-protocol.ts` (message shapes, codes)
- `shared/domain/game-types.ts` (the `SerializedGameState` and `GameSnapshot` payloads)

## Protocol Model (Request/Response)

- The bot client is **idle** unless there is an outstanding server request.
- The server sends game state with every decision request (`request`). It also sends it at the beginning of a game for information purposes (with `attached` for the first game and `rematch-started` for rematches).
- There is at most **one active request** at a time.
  - A newer request **invalidates** any prior request.
  - If the client responds to an invalidated request, the server replies with `nack` code `STALE_REQUEST`.
- If the client responds with an illegal action, the server replies with `nack` and the **same request remains active** when `retryable: true`.

## Versioning

- The protocol is versioned by a single integer: `protocolVersion`.
- This document describes `protocolVersion = 1`.
- Clients MUST send `protocolVersion` in the initial `attach` message.
- Clients MUST ignore unknown fields in server messages (forward compatibility).
- Servers MAY ignore unknown fields in client messages, but will reject unknown/invalid message shapes.

## Transport

- WebSocket endpoint:
  - Production: `wss://{host}/ws/custom-bot`
  - Local backend: `ws://localhost:3000/ws/custom-bot`
  - Dev via Vite proxy: `ws://localhost:5173/ws/custom-bot`
- All messages are UTF-8 JSON in WebSocket **text** frames.
- Each WebSocket frame MUST contain exactly one JSON object.

## Authentication: `seatToken`

- Authentication is via a bearer token: `seatToken` (shown in the game setup UI when a seat is configured as “Custom bot”).
- A `seatToken` is scoped to exactly one seat in exactly one game (and successive games within the same match).
- Tokens are **single-use** for attachment:
  - After a successful `attach`, reusing the token MUST be rejected (`attach-rejected` code `TOKEN_ALREADY_USED`).
  - The server treats disconnect during `playing` as resignation (so reconnect is not supported).

## IDs and Times

- `requestId`: server-generated string identifying a single decision window.
- `serverTime`: milliseconds since Unix epoch.

## Message Types

### Client -> Server

#### `attach`

Sent once immediately after opening the WebSocket.

```json
{
  "type": "attach",
  "protocolVersion": 1,
  "seatToken": "cbt_...",
  "supportedGame": {
    "variants": ["standard", "classic", "freestyle"],
    "maxBoardWidth": 20,
    "maxBoardHeight": 20
  },
  "client": { "name": "my-bot-client", "version": "0.1.0" }
}
```

Notes:

- All the fields are mandatory.
- `client` is used for logging purposes.
- The server may reject attachment if `supportedGame` does not support the session's configuration.

#### `response`

Response to a single active server `request` (identified by `requestId`).

```json
{
  "type": "response",
  "requestId": "req_...",
  "response": { "action": "move", "moveNotation": "Ce4.Md5.>f3" }
}
```

### Server -> Client

#### `attached`

Sent after successful `attach`.

```json
{
  "type": "attached",
  "protocolVersion": 1,
  "serverTime": 1735264000123,
  "server": { "name": "wallgame", "version": "1.0.0" },
  "match": {
    "matchId": "match_...",
    "gameId": "abcd1234",
    "seat": { "role": "joiner", "playerId": 2 }
  },
  "state": { "...": "SerializedGameState" },
  "snapshot": { "...": "GameSnapshot" },
  "limits": {
    "maxMessageBytes": 65536,
    "minClientMessageIntervalMs": 200,
    "maxInvalidMessages": 10
  }
}
```

Notes:

- `seat.role` is stable across rematches; `seat.playerId` may change across rematches and is updated via `rematch-started`.
- Receiving `attached` does not create a decision window; the client must remain idle until a `request` arrives.

#### `attach-rejected`

Sent when the server rejects `attach`, then the server closes the socket.

```json
{ "type": "attach-rejected", "code": "INVALID_TOKEN", "message": "Seat token is invalid." }
```

`code` values:

- `INVALID_TOKEN`
- `TOKEN_ALREADY_USED`
- `SEAT_NOT_CUSTOM_BOT`
- `SEAT_ALREADY_CONNECTED`
- `UNSUPPORTED_GAME_CONFIG`
- `PROTOCOL_UNSUPPORTED`
- `INVALID_MESSAGE`
- `INTERNAL_ERROR`

#### `request`

The only way the server asks the bot for a decision. The server includes full state in every request.

```json
{
  "type": "request",
  "requestId": "req_...",
  "serverTime": 1735264000456,
  "kind": "move",
  "state": { "...": "SerializedGameState" },
  "snapshot": { "...": "GameSnapshot" }
}
```

For draw requests the server includes `offeredBy`:

```json
{
  "type": "request",
  "requestId": "req_...",
  "serverTime": 1735264000456,
  "kind": "draw",
  "offeredBy": 1,
  "state": { "...": "SerializedGameState" },
  "snapshot": { "...": "GameSnapshot" }
}
```

#### `ack`

Indicates the response was accepted and applied.

```json
{ "type": "ack", "requestId": "req_...", "serverTime": 1735264000789 }
```

#### `nack`

Indicates the response was rejected.

```json
{
  "type": "nack",
  "requestId": "req_...",
  "code": "ILLEGAL_MOVE",
  "message": "Invalid move notation: Invalid action notation: Xz9",
  "retryable": true,
  "serverTime": 1735264000789
}
```

If `retryable` is `true`, the same request is still active and the client may send another `response` with the same `requestId`.

`code` values:

- `NOT_ATTACHED`
- `INVALID_MESSAGE`
- `RATE_LIMITED`
- `STALE_REQUEST`
- `ILLEGAL_MOVE`
- `INVALID_ACTION`
- `INTERNAL_ERROR`

#### `rematch-started`

Sent when a rematch game is created within the same match and the bot connection continues into the new game.

```json
{
  "type": "rematch-started",
  "serverTime": 1735264000999,
  "matchId": "match_...",
  "newGameId": "wxyz9876",
  "seat": { "role": "joiner", "playerId": 1 },
  "state": { "...": "SerializedGameState" },
  "snapshot": { "...": "GameSnapshot" }
}
```

After `rematch-started`, the server may immediately send a new `request` if it needs a decision (for example, a `move` request if it is the bot's turn).

## Request Kinds and Valid Responses

The valid response actions are determined by the request `kind`. Any mismatched action receives `nack` code `INVALID_ACTION`.

### `kind: "move"`

Server expects the bot to either play a move or resign (it is the bot's turn).

Valid `response.action` values:

- `"move"` with `moveNotation`
- `"resign"`

### `kind: "draw"`

Server informs the bot that the opponent offered a draw (the bot is not the active seat).

Valid `response.action` values:

- `"accept-draw"`
- `"decline-draw"`

### `kind: "rematch"`

Server informs the bot that the opponent offered a rematch (the game is finished).

Valid `response.action` values:

- `"accept-rematch"`
- `"decline-rematch"`

## Shared Payloads

Every `request` includes:

- `state`: a `SerializedGameState`
- `snapshot`: a `GameSnapshot`

These are the server's canonical on-wire representations. Clients SHOULD ignore unknown fields.

### `PlayerId`

`PlayerId` is `1` or `2` (this may change later if we add more variants).

In JSON objects keyed by `PlayerId` (e.g. `timeLeft`), keys are strings: `"1"` and `"2"`.

### `SerializedGameState`

```json
{
  "status": "playing",
  "turn": 2,
  "moveCount": 12,
  "timeLeft": { "1": 123000, "2": 98000 },
  "lastMoveTime": 1735264000123,
  "pawns": { "1": { "cat": [8, 0], "mouse": [7, 0] }, "2": { "cat": [0, 8], "mouse": [1, 8] } },
  "walls": [{ "cell": [4, 4], "orientation": "vertical", "playerId": 1 }],
  "initialState": { "pawns": { "1": { "cat": [8, 0], "mouse": [7, 0] }, "2": { "cat": [0, 8], "mouse": [1, 8] } }, "walls": [] },
  "history": [{ "index": 0, "notation": "Ce4.Md5" }],
  "config": {
    "variant": "standard",
    "timeControl": { "initialSeconds": 180, "incrementSeconds": 2, "preset": "blitz" },
    "rated": false,
    "boardWidth": 9,
    "boardHeight": 9
  }
}
```

Key fields:
- `status`: `"playing"` | `"finished"` | `"aborted"`
- `turn`: the `PlayerId` who must act next
- `moveCount`: monotonically increasing revision counter (clients do NOT need to echo this; use `requestId` for ordering)
- `timeLeft`: remaining time in milliseconds per player
- `history[].notation`: standard move notation (see below)

`result.reason` values:
- `capture`
- `timeout`
- `resignation`
- `draw-agreement`
- `one-move-rule`

### `GameSnapshot`

```json
{
  "id": "abcd1234",
  "status": "in-progress",
  "config": { "variant": "standard", "timeControl": { "initialSeconds": 180, "incrementSeconds": 2 }, "rated": false, "boardWidth": 9, "boardHeight": 9 },
  "matchType": "friend",
  "createdAt": 1735263999000,
  "updatedAt": 1735264000123,
  "players": [
    { "role": "host", "playerId": 1, "displayName": "Alice", "connected": true, "ready": true, "appearance": { "pawnColor": "#f00" }, "elo": 1200 },
    { "role": "joiner", "playerId": 2, "displayName": "Bot", "connected": true, "ready": true }
  ],
  "matchScore": { "1": 0, "2": 0 }
}
```

`status` values:
- `waiting` | `ready` | `in-progress` | `completed` | `aborted`

`matchType` values:
- `friend` | `matchmaking`

## Standard Move Notation (`moveNotation`)

Moves are sent as a single string in standard notation (see the [learn page](https://wallgame.io/learn) for more details):

- `"Ce4"`: move the cat to cell `e4`
- `"Md5"`: move the mouse to cell `d5`
- `">f3"`: place a **vertical** wall to the **right** of cell `f3`
- `"^f3"`: place a **horizontal** wall **above** cell `f3`
- Combine multiple actions in one move with `.` separators: `"Ce4.Md5"`
- `"---"` represents an empty move (no actions)

Cell notation:
- Columns use letters (`a`, `b`, `c`, ...) from left to right.
- Rows use numbers from bottom to top, so on a 9-row board the top row is `9` and bottom row is `1`.

## Abuse Controls / Limits

The server sends its current limits in `attached.limits`. Clients SHOULD respect them.

Current server behavior:
- Rate limiting: if the client sends messages too quickly, the server replies `nack` code `RATE_LIMITED` (`retryable: true`).
- Disconnect handling: if the bot disconnects while the game is `playing`, the server treats it as resignation for that seat.
- The server may close the connection if too many invalid messages are received.

## Example Flows

### Move

1. Client connects to `/ws/custom-bot`
2. Client sends `attach`
3. Server sends `attached`
4. Server sends `request` with `kind: "move"`
5. Client sends `response` with `action: "move"`
6. Server sends `ack`
7. Later, the server sends the next `request` when it needs another decision

### Draw

1. Opponent offers draw
2. Server sends `request` with `kind: "draw"` and `offeredBy`
3. Client responds with `accept-draw` or `decline-draw`
4. Server responds with `ack` (or `nack` on invalid/stale)

### Rematch

1. Opponent offers rematch
2. Server sends `request` with `kind: "rematch"`
3. Client responds with `accept-rematch`
4. Server sends `ack`, then `rematch-started`
5. Server sends a new `request` if it needs a decision in the rematch game
