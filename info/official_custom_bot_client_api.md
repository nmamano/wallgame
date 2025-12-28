# Official Custom-Bot Client Engine API (v1)

This document specifies the public, language-agnostic interface between the **official custom-bot client** (networking + orchestration) and a **bot engine** (decision making).

It is directed at Wall Game engine developers who want to leverage the Official Client. For developers who want to build their own client, see `info/custom_bot_protocol.md`.

## Terminology

- **Server**: Wallgame backend.
- **Custom-bot client**: a user-run program that connects to the server and controls a single seat using a `seatToken`.
- **Official Client**: the custom-bot client provided by the Wall Game team (as source, compiled locally).
- **Engine**: a local executable/script that makes decisions given a request.
  - does **not** speak WebSocket / HTTP
  - reads a single JSON request from stdin
  - writes a single JSON response to stdout
  - may write logs to stderr
- **Request**: one decision prompt (move or draw decision).

## Custom-bot client CLI

The Official Client exposes a CLI:

```plaintext
wallgame-bot-client \
  --server https://wallgame.example \
  --token <seatToken> \
  --engine "<command to run your engine>"
```

Flags:

- `--server <url>`: base URL used to derive the WebSocket URL (default: `http://localhost:5173` in dev).
- `--token <seatToken>`: required; the per-seat token from the UI.
- `--engine <command>`: optional; if omitted, the Official Client runs a built-in "dumb bot" for testing purposes.
- `--log-level <level>`: optional (`debug|info|warn|error`). Defaults to `info`.

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
- Draw requests are advisory and do not block play (the server may send a newer request that invalidates the draw request), but the Official Client chooses to consult the engine.
- The Official Client treats it as resignation if the engine crashes, times out, or produces invalid output.

## Wire format (Official Client <-> Engine)

- Encoding: UTF-8.
- Engine stdin: exactly one JSON object.
- Engine stdout: exactly one JSON object (whitespace allowed around it).
- Engines SHOULD write logs to stderr, not stdout.

If the engine writes invalid JSON or no JSON to stdout, the Official Client treats it as resignation.

## Engine API Version

The engine API is versioned independently, but in v1 it intentionally matches the server protocol version:

- `engineApiVersion: 1`

The Official Client includes `engineApiVersion` in requests. Engines MUST reject unknown versions.

## Common types

### `SerializedGameState`

Requests embed the canonical `SerializedGameState` object from the server protocol. See `info/custom_bot_protocol.md` for full details.

### `GameSnapshot`

Requests also embed the canonical `GameSnapshot` (match status / player metadata) from the server protocol. See `info/custom_bot_protocol.md` for full details.

## Requests

All requests share these fields:

```json
{
  "engineApiVersion": 1,
  "kind": "move",
  "requestId": "...",
  "server": {
    "matchId": "...",
    "gameId": "abcd1234",
    "serverTime": 1735264000456
  },
  "seat": { "role": "host", "playerId": 1 },
  "state": { "...": "SerializedGameState" },
  "snapshot": { "...": "GameSnapshot" }
}
```

- `requestId` comes from the triggering server `request` message and MUST be echoed back in the response.
- `server.serverTime` is the server's time in ms since epoch from the triggering server message (useful for clock math).

### `kind: "move"`

Sent when it is the bot's turn and a move (or equivalent action) is expected.

```json
{
  "engineApiVersion": 1,
  "kind": "move",
  "requestId": "...",
  "server": { "matchId": "...", "gameId": "abcd1234", "serverTime": 1735264000456 },
  "seat": { "role": "host", "playerId": 1 },
  "state": { "...": "SerializedGameState" },
  "snapshot": { "...": "GameSnapshot" }
}
```

Notes:

- For `kind: "move"`, the engine may return either `response.action: "move"` or `response.action: "resign"`.
- The server protocol is request/response: if a newer server `request` arrives, the previous `requestId` is invalidated and the engine result for the old request MUST be discarded.

### `kind: "draw"`

Sent when the Official Client receives a server `request` that is not a move request.

Draw offer request:

```json
{
  "engineApiVersion": 1,
  "kind": "draw",
  "requestId": "...",
  "server": { "matchId": "...", "gameId": "abcd1234", "serverTime": 1735264000123 },
  "seat": { "role": "host", "playerId": 1 },
  "offeredBy": 2,
  "state": { "...": "SerializedGameState" },
  "snapshot": { "...": "GameSnapshot" }
}
```

Notes:

- If a newer server `request` arrives while the engine is evaluating this request, the Official Client discards the engine's result and no server response is sent for the invalidated `requestId`.

## Responses

All responses MUST include `engineApiVersion` and MUST echo `requestId`.

Response rule:

- The response MUST be valid for the request `kind` (see `info/custom_bot_protocol.md`).

### Move response

```json
{
  "engineApiVersion": 1,
  "requestId": "...",
  "response": { "action": "move", "moveNotation": "Ce4.Md5.>f3" }
}
```

- `moveNotation` uses standard move notation (`info/custom_bot_protocol.md`).
- Use `---` for a pass move.

### Resign response

```json
{
  "engineApiVersion": 1,
  "requestId": "...",
  "response": { "action": "resign" }
}
```

### Draw decision response

```json
{
  "engineApiVersion": 1,
  "requestId": "...",
  "response": { "action": "accept-draw" }
}
```

For declining a draw:

```json
{
  "engineApiVersion": 1,
  "requestId": "...",
  "response": { "action": "decline-draw" }
}
```

## Error handling (Engine-side)

Engines SHOULD fail fast and clearly:

- If the request is unsupported, write a valid JSON response with a deterministic safe default (for example `resign` on `kind: "move"`, or `decline-draw`).
- Write human-readable diagnostics to stderr.
