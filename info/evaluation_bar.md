# Evaluation bar

This is a vertical integration feature.

## UI

### New toggle

- Reorganize the info panel in the game page to put the variant and time control next to each other in the same row.
- Use the space where the time control was to add a new toggle: evaluation bar.
- Overall height and width of the info panel should be the same as before.
- The toggle always starts in the OFF position for a game.
  - It must be turned on manually by the user for every game.
  - It doesn't persist in any way.
  - Refresh turns it off.
- The evaluation bar is grayed out when (1) the game is active, (2) the user is a player, AND (3) the game is rated.
  - This means: the toggle is not grayed out for spectators, replays, games vs bots, unrated games between two humans.
  - Not available for puzzles.
- The toggle should have a "getting ready"/"loading" visual indicator when it is turned on, which appears during the evaluation handshake.
- If the evaluation handshake fails, the toggle should be turned off automatically, and we should show an error message to the user.
  - The error message should be contained within the info panel, and not modify its size.

### Evaluation bar

- The bar only displayed when the toggle is ON.
- The bar is horizontal and thin.
- It appears on the board panel, **above** the board.
- Preallocate the necessary space for it. Turning the toggle ON shouldn't change the height of the board panel.
  - This means the empty space is always visible when toggle is OFF.
- Follow styling of a site like Lichess, but with the bar being horizontal, and using the players' colors (P1 left, P2 right) instead of black and white.
  - I don't care if it transitions smoothly or not. Either is fine.
  - Eval goes from +1 (P1 is completely winning) to -1 (P2 is completely winning), with 0 being the position is equal. If eval is 1, the bar should be completely the color of P1. If eval is -1, the bar should be completely the color of P2. If eval is 0, the bar should be half the color of P1 (left) and half the color of P2 (right).
  - The actual eval number can be displayed next to the bar (without increasing vertical space).
  - It doesn't matter if the user is P1 or P2. It's not about seats, it's about P1 (the player starting first) and P2.
- The bar should indicate visually (without text) when the evaluation hasn't been received yet.
  - Show last value with a "pending" overlay.
  - The initial pending state (no last value yet) should show a neutral split (50/50) plus the overlay.

## Protocol for getting evaluations

### Handshake

Evaluation handshake starts when the user turns the toggle ON (which must not be grayed out in the first place).

This attempts to establish a new WS connection between the user's client and the server. We'll call this the "eval connection" or "eval WS".

1. The client asks the server: "Is there an official bot that can provide evaluations for this game?"
2. The server looks at attached official bots and finds a matching one.
  - If it cannot find any, returns an error.
  - If it finds more than one (shouldn't happen since I decide which bots are attached, but not technically impossible), picks any and allows the eval connection.
  - The server must reject evaluation requests for rated in-progress players (spectators are allowed, even if it's an easy loophole).
  - Server doesn't expose bot identity.
 
Notes:

- User clients are already querying for available bots for the "Ready to join" table. We need to do something similar to find a matching bot for the evaluation bar, but server side.
- Eval WS can happen over modes that usually didn't need WS, like watching replays or "local" games (like You vs Also You; as soon as you click the toggle, it's not technically purely local anymore).

### Eval WS Closing

Eval WS closes when:

- Toggle is turned OFF.
- Game ends.
- User navigates away.

### When eval requests happpen

This happens whenever the board position changes.

- When a move is made (and the game is still active (ready or in-progress)).
- When looking at the move history.
  - When looking a history move, wait 1s before requesting the evaluation. This will help with the situation where the user is scrubbing through history quickly.

It doesn't happen for:

- Premoved actions.
- Staged actions.
- Ended games.

## Bot protocol

- The current server <-> bot client protocol always returns a tuple: best move and evaluation.
- For the eval connection, we will use the same protocol, and we will return the tuple as is to the user's client. The client then uses the evaluation to update the evaluation bar and discards the move (for now; we may use it later).

### Load handling

- Bots currently have a move request queue. Evaluation requests go into the same queue.
- Even if the queue is full, we still add any evaluation requests to it (we'll improve this later).

### Correctness

- Eval requests include an ID and are only valid on the position that was requested.
- If the position changes before the evaluation is received, the request is discarded.
- If the toggle is turned OFF, any requests are discarded.

### Error handling

- Any error from the server's side (timeout, bot disconnect, network failure, etc.) should turn off the toggle and be reported to the user's client inside the info panel.

### Optimization

- For now, we don't do eval caching.

# Alternatives considered

- Use an HTTP endpoint for evaluation. Makes request/response/caching simpler.
