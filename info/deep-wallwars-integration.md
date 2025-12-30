# Deep-Wallwars integration notes

## What this is

Deep-Wallwars, created by [Thorben Tröbst](https://github.com/t-troebst), is integrated into this monorepo as **vendored source code** using
**git subtree with squash**, and is treated as **authoritative local code**.

There is **no ongoing relationship with upstream**.

## Directory layout

- `deep-wallwars/`
  - Contains a snapshot of the Deep-Wallwars engine source
  - All engine modifications live here
  - There is NO nested git repository
  - Files are tracked directly by the monorepo

## Git model (important)

- Deep-Wallwars was imported once using `git subtree add --prefix=deep-wallwars deepwallwars main --squash`
- The monorepo does NOT contain upstream history
- There is NO bidirectional sync
- All changes to Deep-Wallwars are normal monorepo commits

Conceptually:

> Deep-Wallwars is vendored code, not an external dependency.

## Upstream policy (explicit)

- We do NOT pull from upstream
- We do NOT attempt to keep in sync
- We do NOT expect to rebase, merge, or cherry-pick upstream changes

If upstream contributions are ever desired:
- Changes will be manually ported from the monorepo into a clean fork
- There are no plans to keep the fork (https://github.com/nmamano/Deep-Wallwars) up to date with the monorepo.

## Development workflow

- Edit engine code and platform code in the same editor / monorepo.
- Single commits may touch both engine and server/wrapper code
- Engine evolution is driven entirely by this project's needs
- There is no special tooling, no submodules, no subtree pulls

## Rationale

This setup was chosen because:
- We want a single-repo, low-friction dev loop
- Engine internals must be modified deeply (variants, rules)
- Original project is not actively being worked on
- Upstream sync is not a requirement

This is an intentional, irreversible choice.

# Prompt for the integration

Adapt deep-wallwars/ to work as an engine for the official custom-bot client.

- API description, to be implemented exactly: @info/official_custom_bot_client_api.md
- More context: @info/custom_bots_feature.md
- Example of a dummy engine: dummy-engine/

Notes:

1. Deep wallwars only supports the Classic variant (not the Standard one). That's why the codebase doesn't mentions cats and mice, only pawns (the cats) and home corners. If asked for a move / draw decision for an unsupported variant, the adapter should resign / decline the draw and log the reason.
2. Deep wallwars models are trained for specific board dimensions. For now, we only have access to a 8x8 model. That's the only dimension we can support. Let the model be a flag to the CLI which the client sets. If asked for a move / draw decision for an unsupported board dimension, the adapter should resign / decline the draw and log the reason.
3. Most important: clean code; secondary: keep the adaptor separate from the existing code.
4. Maybe you can add a new CLI flag for this new use case, which is to evaluate a single decision (what move to make or whether to accept a draw).
5. For draws requests, the adapter should run the engine to evaluate the position and then accept the draw if it is worse for the engine side.
6. For simplicity, make the amount of thinking time, in seconds, a flag. We'll later make the client set it.

# Implementation Comments

### New Files

1. **[deep-wallwars/src/engine_adapter.hpp](../deep-wallwars/src/engine_adapter.hpp)**
   - API types and function declarations
   - State validation and conversion functions
   - Clean separation from existing codebase

2. **[deep-wallwars/src/engine_adapter.cpp](../deep-wallwars/src/engine_adapter.cpp)**
   - State conversion (SerializedGameState → Board)
   - Move generation using MCTS
   - Draw evaluation logic
   - Request/response handling

3. **[deep-wallwars/src/engine_main.cpp](../deep-wallwars/src/engine_main.cpp)**
   - CLI entry point
   - Model loading (TensorRT or simple policy)
   - stdin/stdout JSON processing

4. **[deep-wallwars/ENGINE_ADAPTER.md](../deep-wallwars/ENGINE_ADAPTER.md)**
   - Complete usage documentation
   - Build instructions
   - Testing examples

### Build System Updates

Modified [deep-wallwars/CMakeLists.txt](../deep-wallwars/CMakeLists.txt):
- Added nlohmann_json dependency
- Added engine_adapter.cpp to core library
- Created new `deep_ww_engine` executable target
- Added 8x8 model conversion to TensorRT

### Key Features

- **Model flexibility**: Supports both TensorRT models and simple policy
- **MCTS integration**: Uses existing deep-wallwars MCTS for move generation
- **Draw evaluation**: Evaluates position and accepts when losing
- **Error handling**: Proper logging to stderr, JSON responses to stdout
- **CLI flags**: Configurable model, thinking time, samples, seed, cache size

### Usage Example

```bash
# Build the engine
cd deep-wallwars/build
cmake .. && make deep_ww_engine

# Use with official client
./wallgame-bot-client \
  --server https://wallgame.example \
  --token <seat-token> \
  --engine "./deep-wallwars/build/deep_ww_engine --model ./deep-wallwars/build/8x8_750000.trt --think_time 10"
```

### Testing

Can be tested standalone with sample JSON requests:

```bash
echo '{"engineApiVersion":1,"kind":"move",...}' | ./deep_ww_engine --model simple
```

See [ENGINE_ADAPTER.md](../deep-wallwars/ENGINE_ADAPTER.md) for detailed testing examples.

## Next Steps (Optional)

- [ ] Integration testing with actual official client
- [ ] Performance tuning (sample count, cache size)
- [ ] Support for time-based move generation (use remaining clock time)
- [ ] Multi-board size support (requires training models for other sizes)

# Appendix: Invalid move bug log
 
This is a bug that happens sometimes that makes Deep Wallwars return an illegal move.

Client debug logs:

[2025-12-29T12:37:43.178Z] [INFO] Received move request (req_XoxK0r24ZYA3)
[2025-12-29T12:37:43.178Z] [DEBUG] Running engine: ../deep-wallwars/build/deep_ww_engine --model ../deep-wallwars/build/8x8_750000.trt --think_time 3
[2025-12-29T12:37:43.178Z] [DEBUG] Request: {"engineApiVersion":1,"kind":"move","requestId":"req_XoxK0r24ZYA3","server":{"matchId":"h5j_Yr3e","gameId":"-23j8QB5","serverTime":1767011863109},"seat":{"role":"joiner","playerId":1},"state":{"status":"playing","turn":1,"moveCount":20,"timeLeft":{"1":1792.471,"2":1752.27},"lastMoveTime":1767011863106,"pawns":{"1":{"cat":[1,4],"mouse":[7,0]},"2":{"cat":[0,2],"mouse":[7,7]}},"walls":[{"cell":[0,3],"orientation":"vertical","playerId":1},{"cell":[1,1],"orientation":"vertical","playerId":2},{"cell":[1,4],"orientation":"horizontal","playerId":1},{"cell":[1,5],"orientation":"vertical","playerId":1},{"cell":[2,0],"orientation":"vertical","playerId":1},{"cell":[2,1],"orientation":"horizontal","playerId":1},{"cell":[2,2],"orientation":"horizontal","playerId":2},{"cell":[2,3],"orientation":"horizontal","playerId":1},{"cell":[2,4],"orientation":"horizontal","playerId":1},{"cell":[2,5],"orientation":"horizontal","playerId":1},{"cell":[2,6],"orientation":"horizontal","playerId":1},{"cell":[2,7],"orientation":"horizontal","playerId":2},{"cell":[3,1],"orientation":"vertical","playerId":1},{"cell":[3,2],"orientation":"horizontal","playerId":1},{"cell":[3,3],"orientation":"vertical","playerId":2},{"cell":[4,0],"orientation":"horizontal","playerId":1},{"cell":[4,1],"orientation":"horizontal","playerId":1},{"cell":[4,2],"orientation":"vertical","playerId":2},{"cell":[4,3],"orientation":"horizontal","playerId":2},{"cell":[5,2],"orientation":"vertical","playerId":2},{"cell":[6,2],"orientation":"vertical","playerId":2},{"cell":[7,0],"orientation":"horizontal","playerId":1},{"cell":[7,1],"orientation":"horizontal","playerId":1},{"cell":[7,2],"orientation":"vertical","playerId":2}],"initialState":{"pawns":{"1":{"cat":[0,0],"mouse":[7,0]},"2":{"cat":[0,7],"mouse":[7,7]}},"walls":[]},"history":[{"index":1,"notation":"Cc8"},{"index":2,"notation":"Cg8.Cg7"},{"index":3,"notation":">f7.^g6"},{"index":4,"notation":"Cg8.^h6"},{"index":5,"notation":"Cc7.^f6"},{"index":6,"notation":"Cf8.Ce8"},{"index":7,"notation":">d8.^e7"},{"index":8,"notation":"Cf8.Cf7"},{"index":9,"notation":"^d6.^e6"},{"index":10,"notation":">b7.^c6"},{"index":11,"notation":"Cd7.^a1"},{"index":12,"notation":">c2.>c1"},{"index":13,"notation":"^b6.^b1"},{"index":14,"notation":"Ce7.Cd7"},{"index":15,"notation":"^a4.^b4"},{"index":16,"notation":">c4.>c3"},{"index":17,"notation":">b5.^c5"},{"index":18,"notation":">d5.^d4"},{"index":19,"notation":"Ce7.>a6"},{"index":20,"notation":"Cc7.Cc8"}],"config":{"boardWidth":8,"boardHeight":8,"variant":"classic","rated":false,"timeControl":{"initialSeconds":1800,"incrementSeconds":0,"preset":"classical"}}},"snapshot":{"id":"-23j8QB5","status":"in-progress","config":{"timeControl":{"initialSeconds":1800,"incrementSeconds":0,"preset":"classical"},"rated":false,"variant":"classic","boardWidth":8,"boardHeight":8},"matchType":"friend","createdAt":1767011806962,"updatedAt":1767011863106,"players":[{"role":"host","playerId":2,"displayName":"Beana","connected":true,"ready":true,"configType":"human","appearance":{"pawnColor":"red","catSkin":"cat121.svg","mouseSkin":"mouse25.svg","homeSkin":"home2.svg"}},{"role":"joiner","playerId":1,"displayName":"Custom Bot","connected":true,"ready":true,"configType":"custom-bot","appearance":{}}],"matchScore":{"1":0.5,"2":0.5}}}
[2025-12-29T12:37:43.972Z] [DEBUG] Engine stderr: I1229 04:37:43.438395 36353 engine_main.cpp:80] Loading TensorRT engine from: ../deep-wallwars/build/8x8_750000.trt
I1229 04:37:43.473149 36353 tensorrt_model.cpp:66] Loaded engine size: 13.238155364990234 MiB
I1229 04:37:43.473195 36353 engine_main.cpp:48] Loaded engine size: 13 MiB
I1229 04:37:43.489972 36353 engine_main.cpp:48] [MS] Running engine with multi stream info
I1229 04:37:43.489997 36353 engine_main.cpp:48] [MS] Number of aux streams is 1
I1229 04:37:43.490000 36353 engine_main.cpp:48] [MS] Number of total worker streams is 2
I1229 04:37:43.490003 36353 engine_main.cpp:48] [MS] The main stream provided by execute/enqueue calls is the first worker stream
I1229 04:37:43.493097 36353 engine_main.cpp:48] [MemUsageChange] TensorRT-managed allocation in IExecutionContext creation: CPU +0, GPU +12, now: CPU 0, GPU 24 (MiB)
I1229 04:37:43.497832 36353 engine_adapter.cpp:242] Handling move request (id: req_XoxK0r24ZYA3)
I1229 04:37:43.942077 36353 engine_adapter.cpp:170] Best move: Cf7.>d7

[2025-12-29T12:37:43.975Z] [DEBUG] Engine exit code: 0
[2025-12-29T12:37:43.975Z] [DEBUG] Sending: {"type":"response","requestId":"req_XoxK0r24ZYA3","response":{"action":"move","moveNotation":"Cf7.>d7"}}
[2025-12-29T12:37:43.977Z] [DEBUG] Received: {"type":"nack","requestId":"req_XoxK0r24ZYA3","code":"ILLEGAL_MOVE","message":"Illegal wall placement","retryable":true,"serverTime":1767011863907}
[2025-12-29T12:37:43.978Z] [WARN] Response req_XoxK0r24ZYA3 rejected: ILLEGAL_MOVE - Illegal wall placement
[2025-12-29T12:37:43.978Z] [ERROR] Illegal move context: {
  requestId: "req_XoxK0r24ZYA3",
  serverMessage: "Illegal wall placement",
  retryable: true,
  response: {
    action: "move",
    moveNotation: "Cf7.>d7",
  },
  request: {
    kind: "move",
    serverTime: 1767011863109,
    seat: {
      role: "joiner",
      playerId: 1,
    },
    state: {
      status: "playing",
      turn: 1,
      moveCount: 20,
      timeLeft: [Object ...],
      lastMoveTime: 1767011863106,
      pawns: [Object ...],
      walls: [
        [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...]
      ],
      initialState: [Object ...],
      history: [
        [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...]
      ],
      config: [Object ...],
    },
    snapshot: {
      id: "-23j8QB5",
      status: "in-progress",
      config: [Object ...],
      matchType: "friend",
      createdAt: 1767011806962,
      updatedAt: 1767011863106,
      players: [
        [Object ...], [Object ...]
      ],
      matchScore: [Object ...],
    },
  },
}
[2025-12-29T12:37:43.978Z] [INFO] Retryable NACK - retrying (attempt 1/1)
[2025-12-29T12:37:43.978Z] [DEBUG] Running engine: ../deep-wallwars/build/deep_ww_engine --model ../deep-wallwars/build/8x8_750000.trt --think_time 3
[2025-12-29T12:37:43.978Z] [DEBUG] Request: {"engineApiVersion":1,"kind":"move","requestId":"req_XoxK0r24ZYA3","server":{"matchId":"h5j_Yr3e","gameId":"-23j8QB5","serverTime":1767011863109},"seat":{"role":"joiner","playerId":1},"state":{"status":"playing","turn":1,"moveCount":20,"timeLeft":{"1":1792.471,"2":1752.27},"lastMoveTime":1767011863106,"pawns":{"1":{"cat":[1,4],"mouse":[7,0]},"2":{"cat":[0,2],"mouse":[7,7]}},"walls":[{"cell":[0,3],"orientation":"vertical","playerId":1},{"cell":[1,1],"orientation":"vertical","playerId":2},{"cell":[1,4],"orientation":"horizontal","playerId":1},{"cell":[1,5],"orientation":"vertical","playerId":1},{"cell":[2,0],"orientation":"vertical","playerId":1},{"cell":[2,1],"orientation":"horizontal","playerId":1},{"cell":[2,2],"orientation":"horizontal","playerId":2},{"cell":[2,3],"orientation":"horizontal","playerId":1},{"cell":[2,4],"orientation":"horizontal","playerId":1},{"cell":[2,5],"orientation":"horizontal","playerId":1},{"cell":[2,6],"orientation":"horizontal","playerId":1},{"cell":[2,7],"orientation":"horizontal","playerId":2},{"cell":[3,1],"orientation":"vertical","playerId":1},{"cell":[3,2],"orientation":"horizontal","playerId":1},{"cell":[3,3],"orientation":"vertical","playerId":2},{"cell":[4,0],"orientation":"horizontal","playerId":1},{"cell":[4,1],"orientation":"horizontal","playerId":1},{"cell":[4,2],"orientation":"vertical","playerId":2},{"cell":[4,3],"orientation":"horizontal","playerId":2},{"cell":[5,2],"orientation":"vertical","playerId":2},{"cell":[6,2],"orientation":"vertical","playerId":2},{"cell":[7,0],"orientation":"horizontal","playerId":1},{"cell":[7,1],"orientation":"horizontal","playerId":1},{"cell":[7,2],"orientation":"vertical","playerId":2}],"initialState":{"pawns":{"1":{"cat":[0,0],"mouse":[7,0]},"2":{"cat":[0,7],"mouse":[7,7]}},"walls":[]},"history":[{"index":1,"notation":"Cc8"},{"index":2,"notation":"Cg8.Cg7"},{"index":3,"notation":">f7.^g6"},{"index":4,"notation":"Cg8.^h6"},{"index":5,"notation":"Cc7.^f6"},{"index":6,"notation":"Cf8.Ce8"},{"index":7,"notation":">d8.^e7"},{"index":8,"notation":"Cf8.Cf7"},{"index":9,"notation":"^d6.^e6"},{"index":10,"notation":">b7.^c6"},{"index":11,"notation":"Cd7.^a1"},{"index":12,"notation":">c2.>c1"},{"index":13,"notation":"^b6.^b1"},{"index":14,"notation":"Ce7.Cd7"},{"index":15,"notation":"^a4.^b4"},{"index":16,"notation":">c4.>c3"},{"index":17,"notation":">b5.^c5"},{"index":18,"notation":">d5.^d4"},{"index":19,"notation":"Ce7.>a6"},{"index":20,"notation":"Cc7.Cc8"}],"config":{"boardWidth":8,"boardHeight":8,"variant":"classic","rated":false,"timeControl":{"initialSeconds":1800,"incrementSeconds":0,"preset":"classical"}}},"snapshot":{"id":"-23j8QB5","status":"in-progress","config":{"timeControl":{"initialSeconds":1800,"incrementSeconds":0,"preset":"classical"},"rated":false,"variant":"classic","boardWidth":8,"boardHeight":8},"matchType":"friend","createdAt":1767011806962,"updatedAt":1767011863106,"players":[{"role":"host","playerId":2,"displayName":"Beana","connected":true,"ready":true,"configType":"human","appearance":{"pawnColor":"red","catSkin":"cat121.svg","mouseSkin":"mouse25.svg","homeSkin":"home2.svg"}},{"role":"joiner","playerId":1,"displayName":"Custom Bot","connected":true,"ready":true,"configType":"custom-bot","appearance":{}}],"matchScore":{"1":0.5,"2":0.5}}}
[2025-12-29T12:37:44.739Z] [DEBUG] Engine stderr: I1229 04:37:44.210302 36362 engine_main.cpp:80] Loading TensorRT engine from: ../deep-wallwars/build/8x8_750000.trt
I1229 04:37:44.248116 36362 tensorrt_model.cpp:66] Loaded engine size: 13.238155364990234 MiB
I1229 04:37:44.248167 36362 engine_main.cpp:48] Loaded engine size: 13 MiB
I1229 04:37:44.262092 36362 engine_main.cpp:48] [MS] Running engine with multi stream info
I1229 04:37:44.262121 36362 engine_main.cpp:48] [MS] Number of aux streams is 1
I1229 04:37:44.262125 36362 engine_main.cpp:48] [MS] Number of total worker streams is 2
I1229 04:37:44.262127 36362 engine_main.cpp:48] [MS] The main stream provided by execute/enqueue calls is the first worker stream
I1229 04:37:44.265215 36362 engine_main.cpp:48] [MemUsageChange] TensorRT-managed allocation in IExecutionContext creation: CPU +0, GPU +12, now: CPU 0, GPU 24 (MiB)
I1229 04:37:44.269779 36362 engine_adapter.cpp:242] Handling move request (id: req_XoxK0r24ZYA3)
I1229 04:37:44.711989 36362 engine_adapter.cpp:170] Best move: Cf7.>d7

[2025-12-29T12:37:44.743Z] [DEBUG] Engine exit code: 0
[2025-12-29T12:37:44.743Z] [DEBUG] Sending: {"type":"response","requestId":"req_XoxK0r24ZYA3","response":{"action":"move","moveNotation":"Cf7.>d7"}}
[2025-12-29T12:37:44.745Z] [DEBUG] Received: {"type":"nack","requestId":"req_XoxK0r24ZYA3","code":"ILLEGAL_MOVE","message":"Illegal wall placement","retryable":true,"serverTime":1767011864672}
[2025-12-29T12:37:44.745Z] [WARN] Response req_XoxK0r24ZYA3 rejected: ILLEGAL_MOVE - Illegal wall placement
[2025-12-29T12:37:44.745Z] [ERROR] Illegal move context: {
  requestId: "req_XoxK0r24ZYA3",
  serverMessage: "Illegal wall placement",
  retryable: true,
  response: {
    action: "move",
    moveNotation: "Cf7.>d7",
  },
  request: {
    kind: "move",
    serverTime: 1767011863109,
    seat: {
      role: "joiner",
      playerId: 1,
    },
    state: {
      status: "playing",
      turn: 1,
      moveCount: 20,
      timeLeft: [Object ...],
      lastMoveTime: 1767011863106,
      pawns: [Object ...],
      walls: [
        [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...]
      ],
      initialState: [Object ...],
      history: [
        [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...], [Object ...]
      ],
      config: [Object ...],
    },
    snapshot: {
      id: "-23j8QB5",
      status: "in-progress",
      config: [Object ...],
      matchType: "friend",
      createdAt: 1767011806962,
      updatedAt: 1767011863106,
      players: [
        [Object ...], [Object ...]
      ],
      matchScore: [Object ...],
    },
  },
}
[2025-12-29T12:37:44.745Z] [ERROR] Max NACK retries exceeded, resigning
[2025-12-29T12:37:44.745Z] [DEBUG] Rate limiting: waiting 198ms before send
[2025-12-29T12:37:44.944Z] [DEBUG] Sending: {"type":"response","requestId":"req_XoxK0r24ZYA3","response":{"action":"resign"}}
[2025-12-29T12:37:44.955Z] [DEBUG] Received: {"type":"ack","requestId":"req_XoxK0r24ZYA3","serverTime":1767011864877}
[2025-12-29T12:37:44.955Z] [DEBUG] Response req_XoxK0r24ZYA3 acknowledged

