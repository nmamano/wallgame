# Evaluation bar

This is a vertical integration feature.

## UI

### New toggle

- Reorganize the info panel in the game page to put the variant and time control next to each other in the same row.
- Use the space where the time control was to add a new toggle: evaluation bar.
- Overall height and width of the info panel should be the same as before.

The evaluation bar is grayed out when:

1. The game is active, the user is a player, AND the game is rated

OR

2. There is no official bot that supports the game variant/time control/variant-specific configuration.
  - If there is more than one candidate, pick any.

This means: as long as there is an official bot, the toggle is not grayed out for spectators, replays, games vs bots, unrated games between two humans.

### Evaluation bar

- The bar only displayed when the toggle is ON.
- The bar is horizontal and thin.
- It appears on the board panel, **above** the board.
- Preallocate the necessary space for it. Turning the toggle ON shouldn't change thei height of the board panel.
- Follow styling of a site like Lichess, but with the bar being horizontal, and using the players' colors instead of black and white.

## Logic

### Evaluation computation

- Positive means P1 is winning.
- Negative means P2 is winning.
- 0 means the position is equal.

It doesn't matter if the user is P1 or P2. It's not about seats, it's about P1 (the player starting first) and P2.

### Finding a matching bot

The user's client is already querying for available bots for the "Ready to join" table. We need to do something similar to find a matching bot for the evaluation bar.

### Requesting an evaluation

This happens whenever the board position changes.

- When a move is made.
- When looking at the history.

It doesn't happen for:

- Premoveed actions.
- Staged actions.

The bar should indicate visually (without text) when the evaluation hasn't been received yet.

### WS connection

"Requesting an evaluation" goes through a WS connection. That means switching the toggle to ON should create a WS connection if there isn't one yet.

- For players in server-managed games, and spectators, the WS connection is already established.
- For replays, and local games, the WS connection needs to be established.

## Bot protocol

- The current bot protocol only asks the AI for a move.
- We need to extend it to return a tuple: best move and evaluation.

### Client changes

The move and the evaluation make it all the way from the engine to the client. It is the client who decides when to use each:

- When playing vs a bot and the bot makes a move and the toggle is ON, we use both.
- When playing vs a bot and the bot makes a move and the toggle is OFF, we only use the move and discard the evaluation.
- When the toggle is ON and the opponent is not a bot making a move, we only use the evaluation and discard the move.

### Server changes

- We need to support WS connections for new modes, like watching replays or local games that require engine evaluation (toggle is ON). This is just a subset of existing connections.
- Requesting evaluation is forwarded to the official bot client, just like in games vs bots.

### Server-bot client protocol

- We change the API for requesting moves to also return an evaluation.

### Bot client changes

- We need to request evaluations from the engine and return it.

### Dummy engine changes

- We need to return an evaluation, which can be computed as P2 distance - P1 distance.
- Distances are to goals or mice, depending on the variant.

### Deep Wallwars adaptor changes

- We need to return the evaluation computed by the engine.


# Claude feedback

Based on the codebase architecture, here's my feedback:

## Hard to Implement

1. **WS connection for replays/local games (lines 58-63)**  
   Currently you have:
   - **GameClient** – authenticated player connection
   - **SpectatorClient** – read-only viewer connection
   - **Replay mode** – no WebSocket at all, just REST-fetched snapshots

   Creating an "evaluation-only" WebSocket connection for replays and local games is new infrastructure. The server's `game-socket.ts` expects either a player token or spectator mode – there's no concept of a "detached evaluation consumer."

2. **Evaluation on history navigation (lines 45-50)**  
   When a user scrubs through history quickly, you'll fire dozens of evaluation requests. You need:
   - Debouncing/throttling
   - Request cancellation (what if position changes before response arrives?)
   - Handling out-of-order responses (request for move 5 arrives after request for move 7)

3. **Bot protocol change is invasive (lines 64-68)**  
   Changing the protocol to return (move, evaluation) touches:
   - `custom-bot-socket.ts` message schema
   - Both bot clients (dummy engine, deep wallwars)
   - Any external bot clients (backwards compatibility?)

## Easier to Do Differently

1. **Separate evaluation endpoint instead of piggybacking on moves**

   The design couples evaluation with move responses, but for "evaluate current position" (when it's not the bot's turn), you need a separate request type anyway. Consider:

   - Always use a dedicated "evaluate" request
   - Move responses can optionally include evaluation as a bonus
   - Cleaner protocol, easier to test each piece independently

2. **Preallocating bar space (line 26)**  
   "Preallocate the necessary space for it. Turning the toggle ON shouldn't change the height of the board panel."
   - This means the empty space is always visible when toggle is OFF.
   - Alternative: animate the height change smoothly (CSS transition). Less wasted space, still no jarring layout shift.

## Underspecified

| Topic                      | Question                                                                                          |
|----------------------------|---------------------------------------------------------------------------------------------------|
| Bot availability           | What happens when the official bot is offline? Gray out toggle? Show error? How is availability detected – real-time or cached? |
| Evaluation scale           | What's the numeric range? How does the bar map values? What about forced wins (mate-equivalent)? |
| "Pick any" (line 17)       | If multiple official bots qualify, different engines may give different evaluations. Inconsistent UX. |
| Rate limiting              | How often can we request evaluations? What if the bot queue backs up?                            |
| Error handling             | Timeout? Bot disconnects? Network failure?                                                       |
| Toggle persistence         | Per-game? Per-session? Saved to user preferences?                                                |
| "Variant-specific configuration" (line 16) | What counts? Board size? Mouse count? Goal positions?                                   |
| Evaluation caching         | Cache evaluations for positions already seen? History browsing revisits positions.               |
| Bar at 0                   | How does equal position display? Split 50/50? Special indicator?                                 |
| Animation                  | Transitions when evaluation changes? Instant snap or smooth interpolation?                       |

**Biggest risk:** The WS connection architecture. I'd suggest scoping an MVP where evaluation bar only works for modes that already have a WebSocket (online games, spectating), and defer replay/local game support.

# Codex feedback

## Hard To Implement

- Reusing the existing `/ws/games/:id` socket for players/spectators while also supporting replays/local games (which currently don’t need a game WS) without violating “one WS per (gameId, role)” lifecycle rules.
- Making evaluation requests fit the current custom-bot protocol, which is designed around “bot is a seat in a real game” (gameId/playerId/opponentName), not “analyze an arbitrary position”.
- Coordinating a cross-cutting protocol change (`shared contracts` + server + bot client + dummy engine + deep wallwars adapter + integration tests).
- Avoiding evaluation spam: “whenever board position changes” + history scrubbing needs debouncing, cancellation, stale-response handling, and server-side rate limits/quotas.
- Anti-cheat enforcement: greying out the toggle is not enough; the server must reject evaluation requests for rated in-progress players (and you should explicitly decide whether spectators are allowed, since that’s an easy loophole).
- “Preallocate space above the board” is easy to state but fiddly with the current fixed height calculations and the existing absolute “loading/error” overlay at the top of `BoardPanel`.

## Easier To Do Differently

- Use an HTTP endpoint for evaluation (client→server), while keeping server→bot as WS; this removes the need to invent “WS for local/replay” semantics and makes request/response/caching simpler.
- Add an explicit analyze request kind in the bot protocol that returns `{ evaluation, bestMove? }` instead of always asking for a move and discarding it.
- Standardize evaluation to a UI-friendly value (e.g. `p1WinProbability: 0..1` or `p1Advantage: -1..1`) and map engine-specific scores server-side; otherwise the bar mapping/clamping will be a recurring problem.
- Relax matching rules (e.g., don’t key on time control, or allow a best-available official fallback) to reduce “toggle disabled” cases.

## Underspecified

- What exactly counts as “active” (waiting/ready/in-progress/finished/aborted), and what happens if the toggle is ON but becomes disallowed (auto-off? keep state but block rendering?).
- Evaluation semantics: units/range/clamping, terminal positions, and whether the score is always from P1’s perspective vs “side to move” (especially important for “use eval returned with bot move”).
- Position identity and ordering: what payload you send (full `SerializedGameState` vs hash/ply), and how you ignore out-of-order responses when the user moves/scrubs.
- UX for “pending/no eval yet” and for failure: do you show last value with a “pending” overlay, show neutral, retry/backoff, etc. (also accessibility if you require “no text”).
- Bot selection when multiple candidates: needs a deterministic/stable rule, and “variant-specific configuration” should be explicitly enumerated (board size only? more?).
- Whether the toggle should persist as a user setting across games (seems likely, but not specified).
