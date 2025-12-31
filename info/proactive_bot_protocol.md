# Proactive Bot Protocol

## Goal

Let any user plug their own locally-run bot, without the server running untrusted code or paying compute. The bot's availability is broadcasted to other users for easy discovery.

Engine developers can use our official bot client to take care of the networking layer, and simply plug in their engine programmed in any language via a simple stdin/stdout protocol.

## Protocol being replaced: seat-based bot protocol

Currently, users can configure a game, and then set "Custom bot" as one of the seats. Then, the UI shows them a bot token, which the user can feed to a bot client to connect to the server and control that seat.

Example of running the official bot client with the Deep Wallwars engine:

```
$ bun run start --engine "../deep-wallwars/build/deep_ww_engine --model ../deep-wallwars/build/8x8_750000.trt --think_time 3" --server "http://$WIN_HOST:5173" --token cbt_U5bCiFON529vuuz_llag_WUV
```

In the seat-based protocol,e the same token is good for rematches, but it's still inconvenient because users need to run the bot client again each time they want to play a new match with the bot.

## What stays the same in the new protocol

- The bot client does not implement bot logic itself; it runs a local engine process and exchanges messages with it over stdin/stdout.
- The server remains authoritative for rules, legality, clocks, and game state.
- The server-client protocol and the client-engine API are public-facing. They should be implementable by anyone with the spec.

### Custom Bot WebSocket Gateway

Like in the seat-based protocol, there is a dedicated WS endpoint for custom bot clients. The responsibilities are a bit different:

- Accept connection attempts.
- Enforce single active connection per Client ID.
- Disconnect handling (more on that below).
- Schema validation and size caps for all messages.
- If a bot client sends 10 invalid or stale messages for a game (each game has its own counter), the server treats it as a resignation, but doesn't disconnect the client.
- Rate limiting: at most 1 message per 0.2 seconds from the client to the server
  - This allows the client to play fast in bullet games, but it can't be abused since 10 invalid messages will kill the connection.
- Connection limiting: at most 10 bot clients can be connected at the same time. More than that will be rejected.

### Turn and Offer Dispatcher

The server-bot protocol is strict **request/response**. The server sends a `request` only when it needs a decision from the bot client, and includes the full authoritative state with each request. See `info/custom_bot_protocol.md` for the exact message shapes and semantics.

When the bot is required to make a move:

- Server sends a `request` of kind `move` (includes the full authoritative state).
- Server waits for a `response` (move or resign). If the bot runs out of time, they lose as usual.
  - The client can manage their time as they wish, like a human player.
  - Server validates and applies the response if legal.
- Clients CANNOT initiate meta-actions (draw offer, takeback request, give extra time, rematch offer).

Draw offers:

- If the opponent offers a draw and it's not the bot's turn, the server sends a `request` of kind `draw`.
- Draw requests do not block play: the server may send a newer `request` (which invalidates the previous one) if the game advances.
- The client is not required to consult its engine; it may auto-decline or ignore the request.
- If the opponent offers a draw when it is the bot's turn, the server automatically rejects it. The client doesn't get the offer.

Takebacks vs bots (server-only):

- Takebacks are not exposed to the bot client.
- The server automatically accepts takebacks in unrated games and rejects them in rated games (note that, to start, all games against bots are unrated). The client never needs to know.

### Validation and Enforcement

- The server validates all bot responses:
  - legal in current position
  - correct seat to act
  - within time budget
  - not stale (responses must match the currently active `requestId`)
- Invalid responses produce a server `nack`; retryable errors allow re-responding to the same request (see `info/custom_bot_protocol.md`).

## New model proposal

1. Bot clients connect proactively, no token needed.
2. Connected bot clients are listed in a table below the "Join game" section (where users can play against other users).
3. Users can click "play" in the row for a bot to play against it.
  - Users skip the "game setup" modal (the one that shows the bot token in the seat-based protocol) entirely.

## Context

There are two types of game configuration settings:

- Global: variant and time control
- Variant-specific: board size for Classic and Standard

Bots can support any subset or combination.

## UI in more detail

There will be a new table, "Bots", with two tabs: "Recommended" and "Matching settings".

Both tabs are filtered by variant and time control.

Within that variant and time control, bots are allowed to suggest one or more settings for variant-specific settings. Those are shown in the "Recommended" tab. The "Matching settings" tab filters by the specific settings set by the user.

### Example

During attachment, a bot client signals that it supports board sizes from 5x5 to 8x8, the Classic variant, and all time controls. In addition, it recommends 6x6 as the board dimensions.

Then:

- If the user chooses the Standard variant, this bot won't show up in either tab.
- if the user chooses Classic and 7x7 board dimensions, then: the bot shows up in the "Recommended" tab with 6x6 board dimensions, and it appears in the "Matching settings" tab with 7x7 board dimensions.
- If the user chooses Classic and 10x12 board dimensions, the bot will appear in the "Recommended" tab the same but it won't appear in the "Matching settings" tab.

### Tab descriptions

- Recommended: a list of bots with the settings that the bots themselves recommend when playing against them.
  - The same bot may appear multiple times with different recommended settings.
  - Clicking a recommended row overrides the user's current variant-specific settings with the recommended settings.
- Matching settings: only those bots that support the user's chosen game configuration.

### Example

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

"Recommended" is the default tab.


## Protocol details

### Client supported game configurations

Upon attachment, bot clients tell the server:

- Client ID
- A list of bots, each with:
  - Name (for display purposes)
  - An optional username (determines whether the bot is public or only visible to the user with that username)
  - Official or custom (official must pass the secret token for official bots)
  - Optional style preferences
    - Color (optional)
    - Pawn (cat, mouse, home) styles (optional)
  - A list of supported variants
  - For each variant:
    - Supported time controls
    - Supported variant-specific settings
      - In particular, board dimensions are specified as ranges: minimum and maximum board width and height
    - If the variant has variant-specific settings, a list of 1 to 3 recommended configurations for them (if the variant doesn't, leave the list empty)

## Considerations

### Maximum load for bot clients

Regardless of the number of bots in a client, the server only sends a single request at a time to the client. The server maintains a FIFO queue of requests for each bot client.

If the queue length for a bot client reaches a threshold (10), the UI should stop showing bots from that client to users in the Bots table until it goes back down to another threshold (5).

The server notifies the user when their request is queued vs being processed. So the user may see:

"Queued (3)"
"Queued (2)"
"Queued (1)"
"Thinking..."

While the request is queued, the bot's clock doesn't tick down. It resumes once it starts thinking.

- Consistency: the bot doesn't get stronger or weaker depending on server load.
- User advantage: the user gets extra time to think, and that's OK. Bot games are not rated.

Notes:

- The official Easy / Medium / Hard bots will block each other. That's intended.
- A user may click "play" right before the queue reaches the threshold, surpassing it. That's not a problem.
- If the server asks a bot client for a decision on a draw offer, and there are other requests in the queue, the server will wait for a given amount of time (2s). After this time expires, the server will treat a non-answer as a rejection and send the next request in the queue.

### Users wanting to test private bots

When attaching, bot clients can pass an optional flag: a username. If they do, only the user with that username can see them in the table.

The username is canonicalized to lowercase to do this matching.

This allows an engine creator to privately test their engine and even show it to other users without going fully public.

### How to distinguish official bots

There will be a persistent secret token (saved in .env files) only known to the server and the game's owner. The bot client can pass this token during attachment, identifying it as an official bot. Official bots effectively work the same but with some special UI:

- Listed first in the table.
- Marked as official in the UI.

### How to keep official bots always available

Clients are identified by the Client ID, not the WS connection.

- The Client ID is an arbitrary string, which the server stores in RAM.
- The client should try to keep the Client ID unguessable but this is not a critical safety requirement (no user data is compromised).
- If a bot client tries to connect with a Client ID already in use, we follow the "latest connection wins" rule: the new connection force-disconnects the old one.
  - This handles the common crash-restart scenario gracefully.
- The server pings attached bot clients every 30s and relies on WS pong responses. If no pong is received within 10s, the server marks the client disconnected and drops the WS connection. 
  - Only the server sends periodic pings; bot clients do not send independent heartbeats.
  - If a bot client disconnects, the server treats it as a resignation and resigns all the games against bots from that client. This is not a big deal since bot games are unrated.
- The official bot client automatically reconnects (with backoff + jitter) and re-attaches to re-register their bots.
  - Re-attaching with the same Client ID is idempotent; bots are re-registered and any previous presence for the same client is replaced.

### Bot personality expression

- During attachment, let bot clients pick color, pawn styles, and name. That way it's easier to see who you are playing against. Invalid values don't crash - they get replaced by the default value server-side.

### Multiple bots per client

- The same client is allowed to attach multiple bots. All the bots connected share load.

## User journeys

### Wall game creator

- I keep a single bot client running which connects the 3 official bots, "Easy Bot", "Medium Bot", and "Hard Bot". I use the "official" secret token to identify them as official. My bots always show at the top.
- If I want to experiment, I can run additional private bot clients.

### Other engine developers

- Download the official bot client, adapt your engine to the published API, and run it. Then, start playing vs it in the "Bots" table. Others can also play vs it.

## Official Bot Client

The official bot client is a CLI with flags:

- `--config <file_path>`
- `--log-level <level>`
- `--username <username>`

The config file is a JSON file including:
  - The client ID
  - For each bot served by the client (the list can't be empty)
    - supported game configurations and other metadata sent during attachment
    - the command to run the engine for each supported variant

### Responsibilities

- Maintains the WS connection to the server.
- Converts server events into engine requests sent over engine stdin.
- Converts engine responses from stdout into server commands.

### Local Engine Interface (stdin/stdout, Language-Agnostic)

This hasn't changed from the seat-driven protocol:

- The engine is any executable or script (in any language).
- The client communicates with the engine using JSON:
  - Client -> Engine: turn request or meta-action prompt
  - Engine -> Client: chosen move or meta-action response
- The engine does not implement networking.

### Client vs Engine Life Cycle

- The client lives potentially forever.
- The engine is launched and killed for every decision (move or draw).
- The client treats the engine as a standalone, stateless command that expects a single JSON message on stdin and produces a single JSON message on stdout.

## Protocol Overview (Server <-> Bot Client)

For the full public protocol spec, see `info/custom_bot_protocol.md`.

### Handshake

- Client connects to the custom bot WebSocket endpoint and sends an `attach` message.
- Server replies with `attached` or `attach-rejected`.

### Gameplay Events

#### Server -> Client:

- `request` when the server needs a decision (move/draw), always including which bot the request is for and the full authoritative state
- `ack` / `nack` responses to bot `response` messages

#### Client -> Server:

Clients should treat each `request` as a complete, self-contained snapshot suitable for decision making, and should ignore any unknown fields for forward compatibility.

- `attach`
- `response` (answering a single active `requestId`)

Unlike in the seat-based protocol, the server does not send `rematch-started` messages because now the bot client doesn't care if two games are related. It also doesn't send state with the `attached` message because now attachment is not for a specific game.

### Ping and pong

See above.

## Future work

### Bot vs bot games

I don't see a clean way to address this. The bot table UX implicitly means "Me vs Bot".

It's complicated because bots have different supported game configurations. Since this is not a major user journey (though still important for testing bots), maybe it's best to leave that for an entirely separate/new UI page.

### Long-lived engines

In the proactive bot protocol, the engine is stateless and spawn-per-decision:

This is clean but can be costly for ML-backed engines.

Long-lived engines are out of scope for now, but may be added in the future.
