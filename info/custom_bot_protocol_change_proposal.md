# How it works now

Currently, users can configure a game, and then set "Custom bot" as one of the seats. Then, the UI shows them a bot token, which the user can feed to a bot client to connect to the server and control that seat.

Example of running the official bot client with the Deep Wallwars engine:

```
$ bun run start --engine "../deep-wallwars/build/deep_ww_engine --model ../deep-wallwars/build/8x8_750000.trt --think_time 3" --server "http://$WIN_HOST:5173" --token cbt_U5bCiFON529vuuz_llag_WUV
```

The same token is good for rematches, but it's still inconvenient because users need to run the bot client again each time they want to play a new match with the bot.

# New model proposal

1. Bot clients connect proactively, no token needed.
2. Connected bot clients are listed in a table below the "Join game" section (where users can play against other users).
3. Users can click "play" in the row for a bot to play against it.

# Context

There are two types of game configuration settings:

- Global: variant and time control
- Variant-specific: board size for Classic and Standard

Bots can support any subset or combination.

# UI in more detail

There will be a new table, "Bots", with two tabs: "Recommended" and "Matching settings".

Both tabs are filtered by variant and time control.

Within that variant and time control, bots are allowed to suggest one or more settings for variant-specific settings. Those are shown in the "Recommended" tab. The "Matching settings" tab filters by the specific settings set by the user.

## Example

During attachment, a bot client signals that it supports board sizes from 5x5 to 8x8, the Classic variant, and all time controls. In addition, it recommends 6x6 as the board dimensions.

Then:

- If the user chooses the Standard variant, this bot won't show up in either tab.
- if the user chooses Classic and 7x7 board dimensions, then: the bot shows up in the "Recommended" tab with 6x6 board dimensions, and it appears in the "Matching settings" tab with 7x7 board dimensions.
- If the user chooses Classic and 10x12 board dimensions, the bot will appear in the "Recommended" tab the same but it won't appear in the "Matching settings" tab.

## Tab descriptions

- Recommended: a list of bots with the settings that the bots themselves recommend when playing against them.
  - The same bot may appear multiple times with different recommended settings.
  - Clicking a recommended row overrides the user's current variant-specific settings with the recommended settings.
- Matching settings: only those bots that support the user's chosen game configuration.

## Example

```
Global settings:
- Variant: Classic
- Time control: Bullet

Variant-specific settings:
- Board size: 7x6

Table: Bots | Classic | Bullet

Tab: Recommended

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

Easy Bot | official | 7x6
Medium Bot | official | 7x6
Hard Bot | official | 7x6
```

"Recommended" is the default tab.


# Protocol details

## Client supported game configurations

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

# Considerations

## Maximum load for bot clients

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

## Users wanting to test private bots

When attaching, bot clients can pass an optional flag: a username. If they do, only the user with that username can see them in the table.

The username is canonicalized to lowercase to do this matching.

This allows an engine creator to privately test their engine and even show it to other users without going fully public.

## How to distinguish official bots

There will be a persistent secret token (saved in .env files) only known to the server and the game's owner. The bot client can pass this token during attachment, identifying it as an official bot. Official bots effectively work the same but with some special UI:

- Listed first in the table.
- Marked as official in the UI.

## How to keep official bots always available

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

## Bot personality expression

- During attachment, let bot clients pick color, pawn styles, and name. That way it's easier to see who you are playing against. Invalid values don't crash - they get replaced by the default value server-side.

## Multiple bots per client

- The same client is allowed to attach multiple bots. All the bots connected share load.

# User journeys

## Wall game creator

- I keep a single bot client running which connects the 3 official bots, "Easy Bot", "Medium Bot", and "Hard Bot". I use the "official" secret token to identify them as official. My bots always show at the top.
- If I want to experiment, I can run additional private bot clients.

## Other engine developers

- Download the official bot client, adapt your engine to the published API, and run it. Then, start playing vs it in the "Bots" table. Others can also play vs it.

# Future work

## Bot vs bot games

I don't see a clean way to address this. The bot table UX implicitly means "Me vs Bot".

It's complicated because bots have different supported game configurations. Since this is not a major user journey (though still important for testing bots), maybe it's best to leave that for an entirely separate/new UI page.
