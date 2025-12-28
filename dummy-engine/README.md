# Wall Game Dummy Engine

Simple test engine for Wall Game. It walks its cat toward the goal using the
shared dummy AI and standard notation helpers. It never places walls and always
declines draw offers.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime (v1.0 or later)

### Install

```bash
cd dummy-engine
bun install
```

### Build Standalone Executable

```bash
bun run build
# Creates: ./wallgame-dummy-engine (standalone binary)
```

### Use With The Official Client

```bash
# From the official client folder
bun run start --token <your-seat-token> --engine "../dummy-engine/wallgame-dummy-engine"
```

### Run Directly (for testing)

```bash
cat request.json | bun run src/index.ts
```

## Engine API (v1)

The engine:

1. Reads a single JSON request from stdin
2. Writes a single JSON response to stdout
3. Exits after producing the response

### Move Response Example

```json
{
  "engineApiVersion": 1,
  "requestId": "req_abc123",
  "response": {
    "action": "move",
    "moveNotation": "Ce4"
  }
}
```

### Draw Response Example

```json
{
  "engineApiVersion": 1,
  "requestId": "req_def456",
  "response": { "action": "decline-draw" }
}
```

## Behavior

- Standard/Freestyle: cat walks toward the opponent's mouse
- Classic: cat walks toward the opponent's home corner
- No walls, no resignations, no draw acceptance
