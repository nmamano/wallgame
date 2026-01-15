# V3 bot client-engine API: Game Sessions

This design replaces V2 protocol: proactive bot protocol.

It still keeps the proactive aspect, where bots connect proactively to the server. But the difference is that now there is a concept of stateful "Bot Game Sessions" (BGS) instead of assuming that the engine is just a cli command completely stateless.

## Overview

- Proactive bot attachment works like in V2.
- The bot client starts the engine on startup, not for each move request.
  - The bot client tears down the engine at the end.
  - The engine binary is always running in the meantime, awaiting requests.
  - During startup the engine can do expensive setup, like loading the models to GPU.
    - Avoids wasting time on environment setup for each move request.
  - The engine can save memory across move requests, like MCTS trees and evaluation caches.
  - As in V2, the bot client and engine communicate via stdin/stdout with JSON objects.
- New notion: "Bot Game Sessions" (BGS).
  - Every communication between the bot client and the engine is scoped to a BGS.  
  - The MCTS tree (and shared cache) can be reused across moves for the same BGS.  
  - Bot client - engine communication for each BGS is strictly sequential. There is only one valid request at a time per BGS.
  - The bot client may send multiple valid requests to the engine in parallel, but they are for different BGSs.
- There can be multiple parallel BGSs.  
  - Multiple BGSs can run on different threads, which means that Deep Wallwars can even batch model samples together in a single batch.

### Simplifying assumptions

- Bot games don't have time control. They are unlimited. The bot is allowed to take as much time as it wants.
- Bot games are unrated.
- Bots always reject draw offers. The server does this on behalf of the bot.
- The eval bar always starts off for any game, and it has to be turned on manually by the user for each game/replay.
- All the protocol messages have no optional fields.
- There's no time control involvement for bot games or anything related to the protocol.
- The exact same message payloads go from the server to the bot client and from the bot client to the engine.
- The server guarantees BGS IDs are unique.

## BGS

### Components

- Server: it's the source of truth for BGSs.
  - It creates BGS IDs: they are the nanoid for the game (to help with tracing logs).
  - It maintains the BGS history, which it can send to multiple frontend clients.
- Bot client: mostly a message passer between the server and the engine.
- Engine (Deep Wallwars): maintains state for each BGS.
  - E.g., it keeps an MCTS in memory for each BGS.
- Frontend client: when it needs to show evaluations, it requests the BGS history from the server.

There is no database involvement.

### State

The BGS state consists of a position in the game.

### Invariants

- The BGS history always has evaluations/best moves for all positions from the initial configuration to the latest move.
- The BGS history is built by making move requests to the bot client.

### Server - Bot client - engine protocol messages

All the following messages are scoped to a BGS. They go all the way from the server to the engine, across two API layers (server -> bot client -> engine).

- `start_game_session`: starts a new BGS.
  - Fields:
    - BGS ID.
    - Game variant.
    - Any variant-specific settings: board size, starting pawn positions, starting walls, etc.
  - The following is not included or needed:
    - Rated status.
    - Time control.
    - Who starts.
    - Who is human or who is a bot.
    - Name or metadata of the players.
- `game_session_started`: response to `start_game_session` to confirm the BGS has started.
  - Fields:
    - BGS ID.
    - Success: boolean.
    - Error message: string (empty if success is true).

- `end_game_session`: End the BGS.
  - No more messages can be sent to the engine for this BGS.
  - Fields:
    - BGS ID.
- `game_session_ended`: response to `end_game_session` to confirm the BGS has ended.
  - Fields:
    - BGS ID.
    - Success: boolean.
    - Error message: string (empty if success is true).

- `evaluate_position`: Requests a move/evaluation. Doesn't modify state.
  - It is based on the current BGS state, which is not part of the `evaluate` message.
  - Fields:
    - BGS ID.
- `evaluate_response`: response to `evaluate_position`.
  - Fields:
    - BGS ID.
    - Best move (using standard notation).
    - Evaluation (range: [-1, +1] where +1 = P1 winning, 0 = even, -1 = P2 winning).
    - Success: boolean.
    - Error message: string (empty if success is true).

- `apply_move`: Applies a move to the BGS state. It is implicit in the request that the move is for the player to move according to the BGS state.
  - Fields:
    - BGS ID.
    - Move to apply (using standard notation).
- `move_applied`: response to `apply_move` to confirm the move has been applied.
  - Fields:
    - BGS ID.
    - Success: boolean. If false, then the BGS state doesn't change.
    - Error message: string (empty if success is true).

### Error handling

- The server resigns the game and logs the reason under the following circumstances:
  - If the bot client sends an error response.
  - If the server doesn't receive a response from the bot client after a timeout.
  - If the bot client sends an illegal move for the current position according to the BGS state.

## Server BGS history data structure

A BGS exists for:

- An ongoing game vs a bot.
- An ongoing (unrated) game between two humans where at least one of the players turned on the eval bar.
- An ongoing rated (or unrated) game between two humans where at least one spectator turned on the eval bar.

For each BGS, the server maintains a data structure called the "BGS history".

- BGS history: For each position from the initial configuration to the latest move, the BGS history contains the evaluation and best move for each position (from the POV of both players).
- The BGS history is created empty when the BGS is created with `start_game_session`.
- After creation, the BGS may need to catch up to the latest position (e.g., if the game is at move 5 when the eval bar is turned on). To catch up, the server sends move requests and 'apply move' messages to the bot client, one by one, replaying the moves, to fill the BGS history.
- This counts as initialization and frontend client eval bars should show as pending during this process.
- Once initialization is complete, the BGS history is updated whenever a move happens in the game.
  - If the move is made by the bot, then the bot's evaluation and best move are stored directly in the BGS history (for the position from the bot's POV).
  - If the move is made by a human, then the server sends a move request to the bot client, to get the evaluation from the human's perspective. When that response is received, the BGS history is updated with the bot's chosen evaluation and best move for the human's position.
- When the game ends, the BGS ends and the BGS history is deleted.
  - The frontend client may retain the BGS history so the player can continue to see the evaluations for the move history until they leave the page.
  - BGS history is not saved to the database.


### Rollbacks

If there is a rollback:
  - the server ends the BGS session
  - the server waits for confirmation
  - the server starts a new BGS (with the same BGS ID).
  - the BGS history is updated to the rollback position by replaying the moves with `evaluate_position` and `apply_move` messages, getting evaluations from the bot for both sides.

### Past game replay with eval bar

If a player turns on the eval bar for a past game replay, it is similar to a rollback:
  - the server starts a BGS
    - the BGS ID is the nanoid of the game + `_` + the canonical name of the user viewing the replay
      - This is to avoid BGS ID clashes if multiple users view the same replay at the same time.
  - the server fills the entire BGS history by replaying the moves one by one
    - it doesn't matter what position the user is at when they turn on the eval bar
  - the server sends the entire BGS history to the client
  - the server ends the BGS session immediately after sending it

## Use cases

### Playing a game vs a bot

- The game is created
  - The server creates a BGS (initializes the BGS state and history, and sends a `start_game_session` message to the bot client).
  - The server sends an evaluation request to the bot to get an evaluation for the initial position.
  - When the bot response is received, the server saves it in the BGS history.
  - The game actually starts (it is now the bot's turn or the human's turn).

- When it's the bot's turn
  - invariant: the server already knows the evaluation of the bot's position
  - the server sends an apply move message to the bot client with the best move for this position (based on top of the BGS history)
  - the server sends a new evaluation request to the bot to get an evaluation for the position (the human's turn)
  - when it gets the response, it saves it in the BGS history
  - the server sends the move played by the bot to the human player (as well as the evaluations if the eval bar is turned on)
  - it's now the human's turn

- When it's the human's turn
  - invariant: the server already knows the evaluation of the human's position
  - the server waits for the human to make a move
  - the server sends an apply move message to the bot client with the human's move
  - the bot client confirms the update
  - the server sends an evaluation request to the bot to get an evaluation for the position (the bot's turn)
  - the response is saved in the BGS history.
  - it's now the bot's turn

- When the game ends
  - the server sends an end game session message to the bot client
  - the server ends the BGS

### Playing a game vs a bot with eval bar

- When the eval bar is turned on, the server sends the entire BGS history to the client. This means that the client immediately can see evaluations for all the move history.
- The invariant is that the server always knows the evaluation of the current and past positions, so it can always give the evaluations to the frontend client.

### Playing an (unrated) game vs a human with eval bar

- When a player turns on the eval bar, the server creates a BGS and BGS history, initializing it with all the moves.
  - This can take a while to do all the evaluations. It's important for the UI to show a "pending" state until the initialization is complete.
- Then, it sends the entire BGS history to the frontend client.
- When players make moves, the server updates the BGS history and sends the updates to the client.
- If both players have the eval bar turned on, both receive the same updates.
- If spectators have the eval bar turned on, they receive the same updates.

### Spectator with eval bar

- Basically the same as if one of the players turns on the eval bar.
- The server's BGS is shared between spectators and players.

### Past game replay with eval bar

- See above.

## Deep Wallwars

### Configuration

- A single binary for all variants, models, and games.  
- All models are loaded on the GPU at initialization time (about \~1 per variant, \~2 total).  
  - Each model has its own batching queue.  
    - Different games can reuse it. This is how it already works.  
    - The multi-model batching mechanism, where each model has its own queue and any position evals using the same model are queued together, is already implemented and doesn't need to be changed.
  - Each model has its own evaluation cache.  
    - The cache is sharded for parallel writes.  
    - controlled by `--cache_size` (default `100,000` entries).  
    - Each evaluation contains evals for all moves, so it is quite big.  
    - It should be fine to have multiple caches as long as the number of models loaded into memory is in the low single digits. If not, we'll lower the cache size.  
- We have a thread pool for the bot client, with a fixed number of threads. Like 12.
- All active BGSs are maintained in parallel just like in self-play.
  - Coroutines sleep while waiting for model inference, allowing the threads to be used for other BGSs.
- There is a maximum of BGSs: 256, like in self-play.
  - We set `max_parallel_games` to `256`.
  - After that, we return an error.
- BGSs can use multiple threads if available. Up to 4.  
  - One thread is not enough to saturate the GPU.
- Each BGS has its own MCTS tree in memory.
- Batch size is `batch_size = 256` regardless of model size.
- Max parallel samples is set to `max_parallel_samples = 4`.
  - Higher parallel samples for a given number of total samples makes MCTS worse. Example: 256 parallel samples with only 500 samples total is bad.
- We set samples to `samples_per_move = 1000` (similar to self-play).

### Protocol

- `start_game_session`: starts a new parallel game, similar to self-play.
  - It shares the same thread pool as other parallel games.
  - It shares the batching queue with other parallel games using the same model.
  - It shares the LRU cache with other parallel games using the same model.
  - It has its own MCTS tree.

- `end_game_session`: ends a parallel game.
  - Deletes the MCTS tree from memory.

- `apply_move`: applies a move to the game.
  - Deletes the branches of the MCTS that are unreachable, effectively moving the root.

- `evaluate_position`:
  - collects samples from the MCTS tree for the game.
  - returns the best move and the evaluation.
