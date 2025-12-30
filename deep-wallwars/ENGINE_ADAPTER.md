# Deep-Wallwars Engine Adapter

This adapter integrates the Deep-Wallwars engine with the [official Wall Game custom-bot client](../../info/official_custom_bot_client_api.md).

## Overview

The `deep_ww_engine` executable implements the [Engine API v1](../../info/official_custom_bot_client_api.md), allowing Deep-Wallwars to play games through the official custom-bot client.

## Supported Configurations

- **Variant**: Classic only (reach opponent's corner first)
- **Board Size**: 8x8 only
- **Model**: Requires 8x8 trained model (`assets/models/8x8_750000.onnx` → `8x8_750000.trt`)

The engine will automatically resign or decline draws for unsupported configurations.

## Building

### Prerequisites

- CMake 3.26+
- CUDA Toolkit
- TensorRT
- folly
- gflags, glog
- nlohmann_json (3.2.0+)

### Build Commands

```bash
cd deep-wallwars
mkdir -p build && cd build
cmake ..
make deep_ww_engine
```

This creates the `deep_ww_engine` executable in `build/deep_ww_engine`.

## Usage

### Running with the Official Client

```bash
# From the official client directory
./wallgame-bot-client \
  --server https://wallgame.example \
  --token <your-seat-token> \
  --engine "../deep-wallwars/build/deep_ww_engine --model ../deep-wallwars/build/8x8_750000.trt"
```

### Command-Line Flags

**Required:**

- `--model PATH`: Path to TensorRT model file (.trt) or 'simple' for simple policy

**Optional:**

- `--think_time N`: Thinking time in seconds (default: 5)
- `--samples N`: MCTS samples per move (default: 500)
- `--seed N`: Random seed for MCTS (default: 42)
- `--cache_size N`: MCTS evaluation cache size (default: 100000)

**Simple Policy Options** (when `--model=simple`):

- `--move_prior N`: Likelihood of choosing a pawn move (default: 0.3)
- `--good_move N`: Bias for pawn moves closer to goal (default: 1.5)
- `--bad_move N`: Bias for pawn moves farther from goal (default: 0.75)

### Example with Simple Policy

```bash
./deep_ww_engine --model simple < request.json
```

### Testing Manually

Create a test request file (`request.json`):

```json
{
  "engineApiVersion": 1,
  "kind": "move",
  "requestId": "test-001",
  "server": {
    "matchId": "match-123",
    "gameId": "game-456",
    "serverTime": 1735264000456
  },
  "seat": {
    "role": "host",
    "playerId": 1
  },
  "state": {
    "status": "playing",
    "turn": 1,
    "moveCount": 0,
    "timeLeft": { "1": 300000, "2": 300000 },
    "lastMoveTime": 1735264000000,
    "pawns": {
      "1": { "cat": [7, 0], "mouse": [7, 1] },
      "2": { "cat": [0, 7], "mouse": [0, 6] }
    },
    "walls": [],
    "initialState": {
      "pawns": {
        "1": { "cat": [7, 0], "mouse": [7, 1] },
        "2": { "cat": [0, 7], "mouse": [0, 6] }
      },
      "walls": []
    },
    "history": [],
    "config": {
      "variant": "classic",
      "timeControl": { "initialSeconds": 300, "incrementSeconds": 0 },
      "rated": false,
      "boardWidth": 8,
      "boardHeight": 8
    }
  },
  "snapshot": {
    "id": "game-456",
    "status": "in-progress",
    "config": {
      "variant": "classic",
      "timeControl": { "initialSeconds": 300, "incrementSeconds": 0 },
      "rated": false,
      "boardWidth": 8,
      "boardHeight": 8
    },
    "matchType": "friend",
    "createdAt": 1735264000000,
    "updatedAt": 1735264000000,
    "players": [
      {
        "role": "host",
        "playerId": 1,
        "displayName": "Test Bot",
        "connected": true,
        "ready": true
      },
      {
        "role": "joiner",
        "playerId": 2,
        "displayName": "Opponent",
        "connected": true,
        "ready": true
      }
    ],
    "matchScore": { "1": 0, "2": 0 }
  }
}
```

Run:

```bash
cat request.json | ./deep_ww_engine --model simple
```

Expected output (JSON to stdout):

```json
{
  "engineApiVersion": 1,
  "requestId": "test-001",
  "response": {
    "action": "move",
    "moveNotation": "Ca8"
  }
}
```

## Engine Behavior

### Move Generation

- Uses MCTS with the specified model to find the best move
- Returns moves in standard notation (e.g., `"Ca8.Mb7.>c5"`)
- Resigns if no legal move is available

### Draw Requests

- Evaluates the position using MCTS
- Accepts draws when the engine's evaluation is negative (losing position)
- Declines draws when the engine's evaluation is positive or neutral

### Error Handling

The engine writes:

- **stdout**: JSON response only
- **stderr**: Logs and error messages (use `--log-level` in client to control)

If a request cannot be fulfilled (unsupported variant/size, invalid JSON, etc.), the engine:

- Returns `"action": "resign"` for move requests
- Returns `"action": "decline-draw"` for draw requests
- Logs the reason to stderr

## Architecture

The adapter is kept separate from the existing Deep-Wallwars codebase:

- [engine_adapter.hpp](src/engine_adapter.hpp) - API types and function declarations
- [engine_adapter.cpp](src/engine_adapter.cpp) - State conversion and engine logic
- [engine_main.cpp](src/engine_main.cpp) - Entry point and CLI flag handling

This separation ensures clean, maintainable code that doesn't pollute the original Deep-Wallwars implementation.

## Coordinate System Notes

### Deep-Wallwars Internal Coordinates

- Origin (0, 0) is top-left
- Rows increase downward (row 0 = top)
- Columns increase rightward (col 0 = left)
- Format: `Cell{column, row}`

### Official API Coordinates

- Origin (0, 0) is top-left
- Rows increase downward (row 0 = top)
- Columns increase rightward (col 0 = left)
- Format: `[row, col]`

### Wall Mappings

**Vertical Walls:**

- API: `{cell: [r, c], orientation: "vertical"}` - blocks right of cell
- Deep-Wallwars: `Wall{Cell{c, r}, Wall::Right}`

**Horizontal Walls:**

- API: `{cell: [r, c], orientation: "horizontal"}` - blocks above cell
- Deep-Wallwars: `Wall{Cell{c, r-1}, Wall::Down}`

## Limitations

1. **Variant Support**: Classic only (no Standard or Freestyle)
2. **Board Size**: 8x8 only (models are trained for specific dimensions)
3. **Model Dependency**: Requires pre-converted TensorRT model for 8x8 boards

These limitations are intentional to match the available trained models and the classic variant rules implemented in Deep-Wallwars.
