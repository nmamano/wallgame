# Proactive Bot Protocol (v2)

## Goal

Let any user plug their own locally-run bot, without the server running untrusted code or paying compute. The bot's availability is broadcasted to other users for easy discovery.

Engine developers can use our official bot client to take care of the networking layer, and simply plug in their engine programmed in any language via a simple stdin/stdout protocol.

## Protocol being replaced: seat-based bot protocol

In the seat-based protocol, users can configure a game, and then set "Custom bot" as one of the seats. Then, the UI shows them a bot token, which the user can feed to a bot client to connect to the server and control that seat.

Example of running the official bot client with the Deep Wallwars engine:

```
$ bun run start --engine "../deep-wallwars/build/deep_ww_engine --model ../deep-wallwars/build/8x8_750000.trt --think_time 3" --server "http://$WIN_HOST:5173" --token cbt_U5bCiFON529vuuz_llag_WUV
```

In the seat-based protocol, the same token is good for rematches, but it's still inconvenient because users need to run the bot client again each time they want to play a new match with the bot.

## New model proposal

1. Bot clients connect proactively, no token needed.
2. Connected bot clients are listed in a table below the "Join game" section (where users can play against other users).
3. Users can click "play" in the row for a bot to play against it.
   - Users skip the "game setup" modal (the one that shows the bot token in the seat-based protocol) entirely.

## What stays the same in the new protocol

- The bot client does not implement bot logic itself; it runs a local engine process and exchanges messages with it over stdin/stdout.
- The server remains authoritative for rules, legality, clocks, and game state.
- The server-client protocol and the client-engine API are public-facing. They should be implementable by anyone with the spec.

---

# Server <-> Bot Client Protocol Specification

Source of truth in this repo:

- `shared/contracts/custom-bot-protocol.ts` (message shapes, codes)
- `shared/domain/game-types.ts` (`SerializedGameState`)

## Connection Model

Bot clients connect **proactively** to the server without needing a per-game token. Upon connection, the client registers one or more bots with their supported game configurations. Connected bots are listed in the UI for users to play against.

Key characteristics:

- A single bot client can serve multiple bots.
- Clients are identified by a `clientId` (an arbitrary string chosen by the client).
- If a client connects with a `clientId` already in use, the new connection force-disconnects the old one ("latest connection wins").
  - All messages from the old connection are treated as stale. This handles the common crash-restart scenario gracefully.
- The server maintains a FIFO queue of requests per client; only one request is active at a time.

## Protocol Model (Request/Response)

The server-bot protocol is strict **request/response**. The server sends a `request` only when it needs a decision from the bot client, and includes the full authoritative state with each request.

- The bot client is **idle** unless there is an outstanding server request.
- There is at most **one active request** at a time per client.
- If the client responds with an illegal action, the server replies with `nack`. If `retryable: true`, the **same request remains active**.
- Clients CANNOT initiate meta-actions (draw offer, takeback request, give extra time, rematch offer).

## Versioning

- The protocol is versioned by a single integer: `protocolVersion`.
- This document describes `protocolVersion = 2`, nicknamed "proactive bot protocol". V1 was the "seat-based bot protocol".
- Clients MUST send `protocolVersion` in the initial `attach` message.
- Clients MUST ignore unknown fields in server messages (forward compatibility).
- Servers MAY ignore unknown fields in client messages, but will reject unknown/invalid message shapes.

We MUST NOT be backward compatible with V1. V1 is obsolete and dead code that should be deleted.

## Transport

- WebSocket endpoint:
  - Production: `wss://{host}/ws/custom-bot`
  - Local backend: `ws://localhost:3000/ws/custom-bot`
  - Dev via Vite proxy: `ws://localhost:5173/ws/custom-bot`
- All messages are UTF-8 JSON in WebSocket **text** frames.
- Each WebSocket frame MUST contain exactly one JSON object.

## IDs and Times

- `clientId`: client-chosen string identifying the bot client (should be unguessable but not security-critical, as no user data is compromised).
- `botId`: unique identifier for a bot within a client, sent by the client during attachment.
- `requestId`: server-generated string identifying a single decision window.
- `serverTime`: milliseconds since Unix epoch.

---

# Message Types

## Client -> Server

### `attach`

Sent once immediately after opening the WebSocket.

```json
{
  "type": "attach",
  "protocolVersion": 2,
  "clientId": "client_abc123...",
  "bots": [
    {
      "botId": "easy-bot",
      "name": "Easy Bot",  // There could also be similar Medium and Hard bots.
      "officialToken": "secret_...", // Omit for non-official bots.
      "username": null, // null for public bots.
      "appearance": {
        "color": "#ff6b6b",
        "catStyle": "cat1",
        "mouseStyle": "mouse1",
        "homeStyle": "home1",
      },
      "variants": {
        "classic": {
          "timeControls": ["bullet", "blitz", "rapid"],
          "boardWidth": { "min": 5, "max": 12 },
          "boardHeight": { "min": 5, "max": 12 },
          "recommended": [
            { "boardWidth": 6, "boardHeight": 6 },
            { "boardWidth": 8, "boardHeight": 8 },
            { "boardWidth": 12, "boardHeight": 10 }
          ]
        },
        "standard": {
          "timeControls": ["bullet", "blitz", "rapid"],
          "boardWidth": { "min": 5, "max": 12 },
          "boardHeight": { "min": 5, "max": 12 },
          "recommended": [
            { "boardWidth": 6, "boardHeight": 6 },
            { "boardWidth": 8, "boardHeight": 8 },
            { "boardWidth": 12, "boardHeight": 10 }
          ]
        }
      }
    }
  ],
  "client": { "name": "official-deep-wallwars-client", "version": "1.0.0" }
}
```

Field descriptions:

- `clientId`: Unique identifier for this bot client instance. If another client connects with the same ID, this connection is force-closed.
- `bots`: Array of bots served by this client. Cannot be empty.
  - `botId`: Unique identifier for this bot within the client. Used to dispatch requests to the correct bot.
  - `name`: Display name shown to users while playing against this bot.
  - `officialToken`: If set, the bot is official. The token is a secret known only to the server and game owner. Omit for non-official bots.
  - `username`: If set, this bot is only visible to the user with this username (case-insensitive). If `null`, the bot is public.
  - `appearance`: Optional style preferences. Invalid values are replaced with defaults server-side.
    - `color`: Hex color for the bot's pawns.
    - `catStyle`: a string that is the name of the cat style image file in the `public/pawns/cat` directory. Leave empty for the default cat style.
    - `mouseStyle`: a string that is the name of the mouse style image file in the `public/pawns/mouse` directory. Leave empty for the default mouse style.
    - `homeStyle`: a string that is the name of the home style image file in the `public/pawns/home` directory. Leave empty for the default home style.
  - `variants`: Object mapping variant names to supported configurations.
    - `timeControls`: Array of supported time control presets (`"bullet"`, `"blitz"`, `"rapid"`).
    - `boardWidth` / `boardHeight`: Supported board dimension ranges (`min` and `max`).
    - `recommended`: Array of 1-3 recommended variant-specific settings shown in the "Recommended" UI tab. Must be empty for variants without variant-specific settings.
- `client`: Metadata for logging purposes.

### `response`

Response to a single active server `request` (identified by `requestId`).

```json
{
  "type": "response",
  "requestId": "req_...",
  "response": { "action": "move", "moveNotation": "Ce4.Md5.>f3" }
}
```

## Server -> Client

### `attached`

Sent after successful `attach`.

```json
{
  "type": "attached",
  "protocolVersion": 2,
  "serverTime": 1735264000123,
  "server": { "name": "wallgame.io", "version": "1.0.0" },
  "limits": {
    "maxMessageBytes": 65536,
    "minClientMessageIntervalMs": 200
  }
}
```

Notes:

- Receiving `attached` does not create a decision window; the client must remain idle until a `request` arrives.
- No game state is sent with `attached` because attachment is not for a specific game.

### `attach-rejected`

Sent when the server rejects `attach`, then the server closes the socket.

```json
{ "type": "attach-rejected", "code": "NO_BOTS", "message": "At least one bot must be provided." }
```

`code` values:

- `NO_BOTS` - The `bots` array is empty.
- `INVALID_BOT_CONFIG` - A bot has invalid configuration (e.g., empty name, invalid variant settings).
- `INVALID_OFFICIAL_TOKEN` - A bot claims to be official but the token is wrong.
- `DUPLICATE_BOT_ID` - Multiple bots have the same `botId`.
- `TOO_MANY_CLIENTS` - Connection limit reached (max 10 bot clients).
- `PROTOCOL_UNSUPPORTED` - Unsupported `protocolVersion`.
- `INVALID_MESSAGE` - Message does not match expected schema.
- `INTERNAL_ERROR` - Unexpected server error.

### `request`

The only way the server asks the bot for a decision.

Every `request` includes a full game state, as a `SerializedGameState`. This is the server's canonical on-wire representation.

#### Move request

```json
{
  "type": "request",
  "requestId": "req_...",
  "botId": "easy-bot",
  "gameId": "abcd1234",
  "serverTime": 1735264000456,
  "kind": "move",
  "playerId": 2,
  "opponentName": "Alice", // For logging purposes.
  "state": { "...": "SerializedGameState" }
}
```

Field descriptions:

- `botId`: Which bot this request is for (matches the `botId` from attachment).
- `gameId`: The game this request is for.
- `playerId`: The `PlayerId` the bot is playing as in this game.
  - `PlayerId` is `1` or `2` (this may change later if we add more variants).
  - In JSON objects keyed by `PlayerId` (e.g. `timeLeft`), keys are strings: `"1"` and `"2"`.
- `kind`: The type of decision needed (`"move"` or `"draw"`).
- `state`: Full `SerializedGameState` (see below).

#### Draw request

For draw requests the server includes `offeredBy`:

```json
{
  "type": "request",
  "requestId": "req_...",
  "botId": "easy-bot",
  "gameId": "abcd1234",
  "serverTime": 1735264000456,
  "kind": "draw",
  "playerId": 2,
  "opponentName": "Alice", // For logging purposes.
  "offeredBy": 1,
  "state": { "...": "SerializedGameState" }
}
```

#### `SerializedGameState`

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

Clients SHOULD ignore unknown fields.

### Request lifetime

A request is active from the moment it is sent until exactly one of:

- the server sends `ack` or non-retryable `nack`
- the server sends a newer `request` to the same client
- the client disconnects

While a request is active, the client should send only one response for the same requestId, it MUST NOT send a response for any other requestId.

### `ack`

Indicates the response was accepted and applied.

```json
{ "type": "ack", "requestId": "req_...", "serverTime": 1735264000789 }
```

### `nack`

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

- `NOT_ATTACHED` - Client sent a response before attaching.
- `INVALID_MESSAGE` - Message does not match expected schema.
- `RATE_LIMITED` - Client sent messages too quickly.
- `STALE_REQUEST` - Response is for an old/invalidated request.
- `ILLEGAL_MOVE` - Move is not legal in the current position.
- `INVALID_ACTION` - Action type doesn't match the request kind.
- `INTERNAL_ERROR` - Unexpected server error.

---

# Request Kinds and Valid Responses

The valid response actions are determined by the request `kind`. Any mismatched action receives `nack` code `INVALID_ACTION`.

## `kind: "move"`

When the bot is required to make a move:

- Server sends a `request` of kind `move` (includes the full authoritative state).
- Server waits for a `response`.
  - The client can manage their time as they wish, like a human player. If the bot runs out of time, they lose as usual.
  - Server validates and applies the response if legal.

Valid `response.action` values:

- `"move"` with `moveNotation`
- `"resign"`

## `kind: "draw"`

Server informs the bot that the opponent offered a draw (it is not the bot's turn).

Valid `response.action` values:

- `"accept-draw"`
- `"decline-draw"`

Behavior:

- Draw requests do not block play.
- If the opponent offers a draw when it is the bot's turn, the server automatically rejects it. The client doesn't receive the offer.
- Draw requests are queued with move requests for the same client.
- Draw requests sent to the client are invalidated when the server sends any subsequent request to the same client, even if it is for a different game.
- If the client responds to an invalidated request, the server replies with `nack` code `STALE_REQUEST`.
- For the V2 protocol, clients MUST NOT consult their engine; they MUST auto-decline.

---

# Server-Handled Actions

The following actions are handled automatically by the server and not exposed to the bot client:

## Takebacks

- Takebacks are not exposed to the bot client.
- The server automatically accepts takebacks in unrated games and rejects them in rated games.
- Bot games are always unrated, so takebacks are always accepted.
- The client never needs to know about takeback requests.

## Rematches

- Rematches are transparent to the bot client.
- The server automatically accepts rematches.
- The server simply starts sending new `request` messages for the new game—the client doesn't need to track game relationships.
- `rematch-started` messages from the seat-based protocol are obsolete in V2.

---

# Standard Move Notation (`moveNotation`)

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

---

# WebSocket Gateway

The dedicated WS endpoint for custom bot clients has these responsibilities:

- Accept connection attempts.
- Enforce single active connection per Client ID.
- Schema validation and size caps for all messages.
- Disconnect handling: If the bot client disconnects, the server resigns all active games for bots from that client. This is not a big deal since bot games are unrated.
- Enforce limits (see Abuse Controls below).

## Ping and Pong

- The server pings attached bot clients every 30s and relies on WS pong responses.
- If no pong is received within 30s, the server marks the client disconnected and drops the WS connection.
- Only the server sends periodic pings; bot clients do not send independent heartbeats.

## Reconnection

- The official bot client automatically reconnects (with backoff + jitter) and re-attaches to re-register their bots.
- Re-attaching with the same Client ID is idempotent; bots are re-registered and any previous presence for the same client is replaced.

## Abuse Controls / Limits

The server sends its current limits in `attached.limits`. Clients SHOULD respect them.

- **Rate limiting:** At most 1 message per 0.2 seconds from the client. Violations receive `nack` code `RATE_LIMITED` (`retryable: true`).
- **Invalid message limit:** If a bot client sends 10 invalid or stale messages for a game (each game has its own counter), the server treats it as a resignation for that game but doesn't disconnect the client.
- **Connection limit:** At most 10 bot clients can be connected at the same time. Additional connections are rejected.

# Maximum Load for Bot Clients

Regardless of the number of bots in a client, the server only sends a single request at a time to the client. The server maintains a FIFO queue of requests for each bot client.

If the queue length for a bot client reaches a threshold (10), the UI should stop showing bots from that client to users in the Bots table.

Notes:

- The official Easy / Medium / Hard bots will share a queue. That's intended.
- A user may click "play" right before the queue reaches the threshold, surpassing it. That's allowed.

---

# UI Design

## Game Configuration Context

There are two types of game configuration settings:

- Global: variant and time control
- Variant-specific: board size for Classic and Standard

Bots can support any subset or combination.

## Bots Table

There will be a new table, "Bots", with two tabs: "Recommended" and "Matching settings".

Both tabs are filtered by global settings (variant and time control).

Within a given variant, bots are allowed to suggest one or more settings for variant-specific settings (see protocol above). Those are shown in the "Recommended" tab. The "Matching settings" tab filters by the specific settings set by the user.

### Tab Descriptions

- **Recommended:** A list of bots with the settings that the bots themselves recommend when playing against them.
  - The same bot may appear multiple times with 1-3 recommended settings.
  - Clicking a recommended row overrides the user's current variant-specific settings with the recommended settings.
- **Matching settings:** Only those bots that support the user's chosen game configuration.

"Recommended" is the default tab.

### Example

During attachment, a bot client signals that it supports board sizes from 5x5 to 8x8, the Classic variant, and all time controls. In addition, it recommends 6x6 as the board dimensions.

Then:

- If the user chooses the Standard variant, this bot won't show up in either tab.
- If the user chooses Classic and 7x7 board dimensions, then: the bot shows up in the "Recommended" tab with 6x6 board dimensions, and it appears in the "Matching settings" tab with 7x7 board dimensions.
- If the user chooses Classic and 10x12 board dimensions, the bot will appear in the "Recommended" tab the same but it won't appear in the "Matching settings" tab.

### Full Example

```
Global settings:
- Variant: Classic
- Time control: Bullet

Variant-specific settings:
- Board size: 7x6

Table: "Bots (Classic · Bullet · Unrated)"

Tab: Recommended

Name | Type | Board size
Easy Bot | official | 5x5
Easy Bot | official | 8x8
Easy Bot | official | 10x12
Medium Bot | official | 5x5
Medium Bot | official | 8x8
Medium Bot | official | 10x12
Hard Bot | official | 5x5
Hard Bot | official | 8x8
Hard Bot | official | 10x12
SomeCustomBot | custom | 3x8

Tab: Matching settings

Name | Type | Board size
Easy Bot | official | 7x6
Medium Bot | official | 7x6
Hard Bot | official | 7x6
```

---

# Considerations

## Users Wanting to Test Private Bots

When attaching, bot clients can pass an optional flag: a username. If they do, only the user with that username can see them in the table.

The username is canonicalized to lowercase to do this matching.

This allows an engine creator to privately test their engine and even show it to other users without going fully public.

## How to Distinguish Official Bots

There will be a persistent secret token (saved in .env files) only known to the server and the game's owner. The bot client can pass this token during attachment, identifying it as an official bot. Official bots effectively work the same but with some special UI:

- Listed first in the table.
- Marked as official in the UI.

## Bot Personality Expression

During attachment, let bot clients pick color, pawn styles, and name. That way it's easier to see who you are playing against. Invalid values don't crash—they get replaced by the default value server-side.

## Multiple Bots Per Client

The same client is allowed to attach multiple bots. All the bots connected share load.

---

# Example Flows

## Attachment

1. Client connects to `/ws/custom-bot`
2. Client sends `attach` with `clientId` and `bots` array
3. Server sends `attached` with limits
4. Client waits for `request` messages

## Move

1. User starts a game against a bot
2. Server sends `request` with `kind: "move"`, `botId`, and full game state
3. Client runs its engine and sends `response` with `action: "move"`
4. Server sends `ack`
5. Later, the server sends the next `request` when it needs another decision

## Draw

1. Opponent offers draw (and it's not the bot's turn)
2. Server sends `request` with `kind: "draw"`, `offeredBy`, and full state
3. Client responds with `decline-draw` immediately (V2 behavior)
4. Server responds with `ack` (or `nack` on invalid/stale)

## Reconnection

1. Bot client crashes or disconnects
2. Server resigns all active games for that client's bots
3. Bot client reconnects with the same `clientId`
4. Server sends `attached`, replacing any previous presence for that client
5. Client's bots are available for new games

---

# Official Bot Client

The official bot client is a CLI:

```plaintext
wallgame-bot-client \
  --config config.json \
  --log-level info \
  --client-id 1234567890 \
  --official-token abc1234567890
```

Flags:

- `--config <file_path>`
- `--log-level <level>`: optional (`debug|info|warn|error`). Defaults to `info`.
- `--client-id <client-id>`
- `--official-token <official-token>`

The config file is a JSON file including:
  - The server to connect to. It's the base URL used to derive the WebSocket URL (default: `http://localhost:5173` in dev).
  - The JSON for the `attach` message, except for the `clientId` and `officialToken` fields, which are filled dynamically by the client from the flags.
  - The command to run the engine for each (bot, supported variant) combination.
    - If omitted, the Official Client runs a built-in "dumb bot" for testing purposes.

## Responsibilities

- Maintains the WS connection to the server.
- Converts server events into engine requests sent over engine stdin.
- Converts engine responses from stdout into server commands.

## Local Engine Interface (stdin/stdout, Language-Agnostic)

- The engine is any executable or script (in any language).
- The client communicates with the engine using JSON:
  - Client -> Engine: turn or draw request (draw request is not used for V2 but it's fine to leave it in the API for now)
  - Engine -> Client: chosen move or draw response
- The engine does not implement networking.

---

# User Journeys

## Wall Game Creator

- I keep a single bot client running which connects the 3 official bots, "Easy Bot", "Medium Bot", and "Hard Bot". I use the "official" secret token to identify them as official. My bots always show at the top.
- If I want to experiment, I can run additional private bot clients.

## Other Engine Developers

- Download the official bot client, adapt your engine to the published API, and run the official bot client. Then, start playing vs it in the "Bots" table. Others can also play vs it.

---

# Future Work

## Bot vs Bot Games

I don't see a clean way to address this. The bot table UX implicitly means "Me vs Bot".

It's complicated because bots have different supported game configurations. Since this is not a major user journey (though still important for testing bots), maybe it's best to leave that for an entirely separate/new UI page.

## Long-Lived Engines

In the proactive bot protocol, the engine is stateless and spawn-per-decision.

This is clean but can be costly for ML-backed engines.

Long-lived engines are out of scope for now, but may be added in the future.

---

# Official Custom-Bot Client Engine API (v2)

This section specifies the public, language-agnostic interface between the **official custom-bot client** (networking + orchestration) and a **bot engine** (decision making).

It is directed at Wall Game engine developers who want to leverage the Official Client (see above).

## Terminology

- **Server**: Wallgame backend.
- **Custom-bot client**: a user-run program that connects to the server.
- **Official Client**: the custom-bot client provided by the Wall Game team.
- **Engine**: a local executable/script that makes decisions given a request.
  - does **not** speak WebSocket / HTTP
  - reads a single JSON request from stdin
  - writes a single JSON response to stdout
  - may write logs to stderr
- **Request**: one decision prompt (move or draw decision).

The Official Client exposes a CLI which handles networking and makes calls to the engine. See above for details on the CLI.

## Engine Execution Model

For each decision prompt, the Official Client starts the engine as a new process:

1. spawn engine process
2. write exactly one JSON object to engine stdin
3. close engine stdin
4. read engine stdout until EOF
5. parse exactly one JSON object from stdout
6. kill the engine if it exceeds a client-defined timeout (based on clock time left)

Engines MUST be treated as untrusted.

## Official Client behavior

- The Official Client automatically accepts rematch offers from the server without consulting the engine.
- If the Official Client receives a retryable `nack` response from the server, it re-runs the engine once with the same request payload. If it gets a `nack` again, it treats it as resignation.
- The Official Client automatically rejects draw offers from the server without consulting the engine. (There is existing engine logic for draw evaluation; this code can stay for now.)
- The Official Client treats it as resignation if the engine crashes, times out, or produces invalid output.

## Wire format (Official Client <-> Engine)

- Encoding: UTF-8.
- Engine stdin: exactly one JSON object.
- Engine stdout: exactly one JSON object (whitespace allowed around it).
- Engines SHOULD write logs to stderr, not stdout.

If the engine writes invalid JSON or no JSON to stdout, the Official Client treats it as resignation.

## Engine API Version

The engine API is versioned independently. The current version is `2`.

- `engineApiVersion: 2`

The Official Client includes `engineApiVersion` in requests. Engines MUST reject unknown versions.

## Requests

Request message: see above.

- `requestId` comes from the triggering server `request` message and MUST be echoed back in the response.
- `server.serverTime` is the server's time in ms since epoch from the triggering server message (useful for clock math).

### Move requests

- For `kind: "move"`, the engine may return either `response.action: "move"` or `response.action: "resign"`.
- The server protocol is request/response: if a newer server `request` arrives, the previous `requestId` is invalidated and the engine result for the old request MUST be discarded.

### Draw requests

- If a newer server `request` arrives while the engine is evaluating this request, the Official Client kills the engine and doesn't send any response for the `requestId`, which is now invalid. The engine doesn't need to know about this.

## Responses

- All responses MUST include `engineApiVersion` and MUST echo `requestId`.
- The response MUST be valid for the request `kind`.
- See above for move, resign, and draw decision responses.

## Error handling (Engine-side)

Engines SHOULD fail fast and clearly:

- If the request is unsupported, write a valid JSON response with a deterministic safe default (for example `resign` on `kind: "move"`, or `decline-draw`).
- Write human-readable diagnostics to stderr.

---

# Implementation prompt

We need to migrate the current monorepo from the "seat-based bot protocol" (V1), to the new V2 "proactive bot protocol" (V2).

Important: we don't need to maintain backward compatibility with V1. That's dead code that needs to be deleted.

V2 is described entirely in @info/proactive_bot_protocol.md 

We need to update:

1. The server backend logic (I believe no DB changes are needed).
2. The frontend UI.
3. The official bot client.
4. The dummy engine
5. The Deep Wallwars adaptor.
6. The integration tests.
