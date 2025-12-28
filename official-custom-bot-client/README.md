# Wall Game Custom Bot Client

The official custom bot client for [Wall Game](https://wallgame.io). This client connects to the Wall Game server and controls a game seat using either your own bot engine or the built-in test bot.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime (v1.0 or later)

### Download (Sparse Checkout)

The bot client lives in the Wall Game monorepo. Use sparse checkout to get only the relevant files:

```bash
# Create a new directory and initialize git
mkdir wallgame-bot && cd wallgame-bot
git init

# Add the remote
git remote add origin https://github.com/anthropics/wallgame.git

# Enable sparse checkout
git config core.sparseCheckout true

# Specify which directories to check out
cat > .git/info/sparse-checkout << 'EOF'
/official-custom-bot-client/
/shared/
EOF

# Pull the files
git pull origin main
```

### Install and Build

```bash
cd official-custom-bot-client
bun install
```

### Run

```bash
# With the built-in test bot
bun run start --token <your-seat-token>

# With your own engine
bun run start --token <your-seat-token> --engine "python my_engine.py"

# Connecting to production
bun run start --server https://wallgame.io --token <your-seat-token> --engine "./my-engine"
```

### Build Standalone Executable

```bash
bun run build
# Creates: ./wallgame-bot-client (standalone binary)
```

## CLI Reference

```
wallgame-bot-client --token <seatToken> [OPTIONS]

OPTIONS:
  --server <url>       Server URL (default: http://localhost:5173)
  --token <token>      Seat token from the game setup UI (required)
  --engine "<cmd>"     Command to run your engine (optional)
  --log-level <level>  Log level: debug, info, warn, error (default: info)
  --help               Show help message
  --version            Show version
```

## How It Works

1. Create a game on Wall Game with "Custom Bot" selected for a player seat
2. Copy the seat token shown on the game setup screen
3. Run this client with your token
4. The client connects to the server and controls the seat

### Without an Engine (Test Mode)

If you don't provide `--engine`, the client uses a built-in "dumb bot" that simply moves its cat toward the opponent's mouse. This is useful for testing your setup.

### With Your Own Engine

When you provide `--engine`, the client spawns your engine as a new process for each decision. Your engine:

1. Reads a single JSON request from stdin
2. Writes a single JSON response to stdout
3. May write logs to stderr
4. Exits after producing the response

## Engine API (v1)

Your engine receives requests and must produce responses in JSON format.

### Move Request

When it's your turn to move:

```json
{
  "engineApiVersion": 1,
  "kind": "move",
  "requestId": "req_abc123",
  "server": {
    "matchId": "match_xyz",
    "gameId": "game_123",
    "serverTime": 1735264000456
  },
  "seat": {
    "role": "host",
    "playerId": 1
  },
  "state": {
    /* SerializedGameState */
  },
  "snapshot": {
    /* GameSnapshot */
  }
}
```

### Move Response

```json
{
  "engineApiVersion": 1,
  "requestId": "req_abc123",
  "response": {
    "action": "move",
    "moveNotation": "Ce4.Md5.>f3"
  }
}
```

Or to resign:

```json
{
  "engineApiVersion": 1,
  "requestId": "req_abc123",
  "response": { "action": "resign" }
}
```

### Draw Request

When the opponent offers a draw (and it's not your turn):

```json
{
  "engineApiVersion": 1,
  "kind": "draw",
  "requestId": "req_def456",
  "offeredBy": 2,
  "server": {
    /* ... */
  },
  "seat": {
    /* ... */
  },
  "state": {
    /* ... */
  },
  "snapshot": {
    /* ... */
  }
}
```

### Draw Response

```json
{
  "engineApiVersion": 1,
  "requestId": "req_def456",
  "response": { "action": "accept-draw" }
}
```

Or:

```json
{
  "engineApiVersion": 1,
  "requestId": "req_def456",
  "response": { "action": "decline-draw" }
}
```

## Move Notation

Moves use standard Wall Game notation:

- `Ce4` - Move cat to cell e4
- `Md5` - Move mouse to cell d5
- `>f3` - Place vertical wall to the right of f3
- `^f3` - Place horizontal wall above f3
- `Ce4.Md5` - Combine actions with `.` separators
- `---` - Empty move (pass)

Cell notation uses letters (a-z) for columns (left to right) and numbers for rows (1 at bottom, increasing upward).

## Game State

The `state` field contains the full game state:

```json
{
  "status": "playing",
  "turn": 2,
  "moveCount": 12,
  "timeLeft": { "1": 123000, "2": 98000 },
  "lastMoveTime": 1735264000123,
  "pawns": {
    "1": { "cat": [8, 0], "mouse": [7, 0] },
    "2": { "cat": [0, 8], "mouse": [1, 8] }
  },
  "walls": [{ "cell": [4, 4], "orientation": "vertical", "playerId": 1 }],
  "history": [{ "index": 0, "notation": "Ce4.Md5" }],
  "config": {
    "variant": "standard",
    "timeControl": { "initialSeconds": 180, "incrementSeconds": 2 },
    "rated": false,
    "boardWidth": 9,
    "boardHeight": 9
  }
}
```

Key fields:

- `status`: "playing", "finished", or "aborted"
- `turn`: PlayerId (1 or 2) who must move next
- `timeLeft`: Remaining time in milliseconds per player
- `pawns`: Current positions of cats and mice (row, col from top-left)
- `walls`: All walls on the board
- `config.variant`: "standard", "classic", or "freestyle"

## Behavior Notes

- **Rematches**: The client automatically accepts rematch offers without consulting your engine
- **Retries**: If your engine fails or returns an invalid move, the client retries once with the same request
- **Resignation**: If your engine crashes, times out, or produces invalid output twice, the client resigns
- **Draw offers**: Draw requests are forwarded to your engine, but they don't block play (the server may invalidate them)
- **Timeouts**: The client calculates a timeout based on your remaining clock time

## Example Engine (Python)

```python
#!/usr/bin/env python3
import json
import sys

def main():
    # Read request from stdin
    request = json.loads(sys.stdin.read())

    # Parse the game state
    state = request['state']
    my_id = request['seat']['playerId']

    # Get my cat position
    cat_pos = state['pawns'][str(my_id)]['cat']

    # Simple strategy: move cat one step right if possible
    new_col = cat_pos[1] + 1
    if new_col < state['config']['boardWidth']:
        col_letter = chr(ord('a') + new_col)
        row_number = state['config']['boardHeight'] - cat_pos[0]
        move = f"C{col_letter}{row_number}"
    else:
        move = "---"  # Pass if can't move

    # Write response to stdout
    response = {
        "engineApiVersion": 1,
        "requestId": request['requestId'],
        "response": {
            "action": "move",
            "moveNotation": move
        }
    }
    print(json.dumps(response))

if __name__ == "__main__":
    main()
```

## Development

```bash
# Type check
bun run typecheck

# Run with debug logging
bun run start --token <token> --log-level debug
```

## Troubleshooting

### "WebSocket connection failed"

- Check that the server URL is correct
- Ensure the server is running and accessible

### "Attachment rejected: INVALID_TOKEN"

- The seat token is invalid or expired
- Create a new game and get a fresh token

### "Attachment rejected: TOKEN_ALREADY_USED"

- The token was already used by another connection
- Create a new game for a new token

### Engine not responding

- Ensure your engine reads from stdin completely before processing
- Ensure your engine outputs valid JSON to stdout
- Check stderr for any error messages from your engine
