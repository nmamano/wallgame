# Deep-Wallwars integration notes

Deep-Wallwars, created by [Thorben Tröbst](https://github.com/t-troebst), is integrated into this monorepo as **vendored source code** using
**git subtree with squash**, and is treated as **authoritative local code**.

There is **no ongoing relationship with upstream**.

## Git model (important)

- Deep-Wallwars was imported once using `git subtree add --prefix=deep-wallwars deepwallwars main --squash`
- The monorepo does NOT contain upstream history
- There is NO bidirectional sync
- All changes to Deep-Wallwars are normal monorepo commits

Conceptually:

> Deep-Wallwars is vendored code, not an external dependency.

### Directory layout

- `deep-wallwars/`
  - Contains a snapshot of the Deep-Wallwars engine source
  - All engine modifications live here
  - There is NO nested git repository
  - Files are tracked directly by the monorepo

### Upstream policy (explicit)

- We do NOT pull from upstream
- We do NOT attempt to keep in sync
- We do NOT expect to rebase, merge, or cherry-pick upstream changes

If upstream contributions are ever desired:
- Changes will be manually ported from the monorepo into a clean fork
- There are no plans to keep the fork (https://github.com/nmamano/Deep-Wallwars) up to date with the monorepo.

### Development workflow

- Edit engine code and platform code in the same editor / monorepo.
- Single commits may touch both engine and server/wrapper code
- Engine evolution is driven entirely by this project's needs
- There is no special tooling, no submodules, no subtree pulls

### Rationale

This setup was chosen because:
- We want a single-repo, low-friction dev loop
- Engine internals must be modified deeply (variants, rules)
- Original project is not actively being worked on
- Upstream sync is not a requirement

This is an intentional, irreversible choice.

# Adapter

Deep wallwars is adapted to work as an engine for the official custom-bot client.

- This adapter integrates the Deep-Wallwars engine with the official Wall Game custom-bot client. Currently, it implements the Engine API v1 ("strict request/response protocol").
- More context: @info/proactive_bot_protocol.md
- Example of a dummy engine: dummy-engine/

The adapter is a new binary build along with the normal deep wallwars binary. This binary is designed to evaluate a single decision (what move to make or whether to accept a draw).

Design principle for the adapter: clean code is the most important; a secondary goal is to keep it separate from the existing code.

## Key Features

- **JSON API**: The engine reads a JSON request from stdin and writes a JSON response to stdout.
- **Variants**: Classic only (reach opponent's corner first). That's why the codebase doesn't mentions cats and mice, only pawns (the cats) and home corners.
- **Board dimensions**: Deep wallwars models are trained for specific board dimensions. For now, we only have access to a 8x8 model. That's the only dimension we can support. The model is a flag passed to the deep wallwars binary, and it is set from the parameters to the bot client CLI.
  - Requires 8x8 trained model (`assets/models/8x8_750000.onnx` → `8x8_750000.trt`)
- **Draws**: For draws requests, the adapter runs the engine to evaluate the position and then accepts the draw if it is worse for the engine side.
- **Error handling**:
  - Proper logging to stderr.
  - The engine will automatically resign or decline draws for unsupported configurations (variant or board dimension).
- **CLI flags**: Configurable model, samples, seed, cache size. There is also a thinking time flag, but it is not used for now.

## Files

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

## Build System Changes

Changes to [deep-wallwars/CMakeLists.txt](../deep-wallwars/CMakeLists.txt):
- New nlohmann_json dependency
- New `engine_adapter.cpp` in the core library
- New `deep_ww_engine` executable target
- New 8x8 model conversion to TensorRT

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

# Build Help (notes for myself)

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

## Complete guide

Here is the complete guide to building and running the Deep-Wallwars project on your Windows machine using the WSL2 Ubuntu environment.

### 1. Enter the WSL Environment

Open your Git Bash or Windows terminal and enter your Ubuntu distribution:

```bash
wsl -d Ubuntu
cd /mnt/c/Users/Nilo/repos/Deep-Wallwars
```

### 2. Install Required System Packages

The project requires some additional libraries that need to be installed via apt. Run these commands in your WSL Ubuntu terminal:

```bash
# Update package lists
sudo apt update

# Install nlohmann-json (required for engine adapter)
sudo apt install -y nlohmann-json3-dev

# Install SFML (optional, only needed for --gui flag)
sudo apt install -y libsfml-dev
```

#### What these packages do:

- **nlohmann-json3-dev**: Modern C++ JSON library used by the engine adapter (`deep_ww_engine`) to parse and generate JSON requests/responses for the official custom-bot client.
- **libsfml-dev**: Simple and Fast Multimedia Library, enables the optional GUI for interactive play with the `--gui` flag.

**Note:** These only need to be installed once. After installation, they'll be available for all future builds.

### 3. Build the C++ Self-Play Core

The C++ project uses CUDA, TensorRT, and Folly. Since Folly and its dependencies were installed in a persistent custom location, you must provide the paths to CMake.

```bash
# 1. Enter the build directory (create it if it doesn't exist)
mkdir -p build && cd build

# 2. Configure CMake with the persistent dependency paths
# Note: These paths point to your persistent Folly installation
cmake -DCMAKE_PREFIX_PATH="$HOME/deepwallwars_folly_deps/folly_build_scratch/installed/folly;\
$HOME/deepwallwars_folly_deps/folly_build_scratch/installed/fmt-ay0yhNJPNTdY1lqD870fK2TOdV0tMIrf-S0qJs5-yLw;\
$HOME/deepwallwars_folly_deps/folly_build_scratch/installed/glog-Or4_YcKCBYmwhzpCKzU3rxBin97HeIDv_8yQYRg7CTk" ..

# 3. Build the project using all CPU cores
make -j$(nproc)
```

### 4. Run C++ Tests and Executables

Verify the build works correctly:

```bash
# Run unit tests
./unit_tests

# View help for the main executable
./deep_ww --help

# View help for the engine adapter (for custom-bot client integration)
./deep_ww_engine --help
```

The build now produces two executables:
- `deep_ww` - The original self-play and interactive executable
- `deep_ww_engine` - Engine adapter for the official custom-bot client

### 5. Run Python Training

To run the AlphaGo-inspired training loop, you must use the Python virtual environment where PyTorch and fastai are installed.

```bash
# 1. Activate the virtual environment (from project root)
cd /mnt/c/Users/Nilo/repos/Deep-Wallwars
source .venv/bin/activate

# 2. Navigate to the scripts directory
cd scripts

# 3. Run a test training generation
# (This performs self-play via the C++ core and trains a new ResNet model)
python3 training.py --generations 1 --games 20 --training-games 20 --samples 100 --threads 4
```

## Environment Notes

- Persistent Dependencies: Folly and its specific `fmt` and `glog` versions are stored in `~/deepwallwars_folly_deps/`.
- TensorRT SDK: The native `trtexec` tool is located in `~/opt/TensorRT-10.11.0.33/bin/` and is already added to your WSL `$PATH` via `~/.bashrc`.
- GPU Support: PyTorch and the C++ core are both configured to use your NVIDIA RTX 4090 via CUDA 12.8 and cuDNN 9.7.
- Git Strategy: You are currently set up to push to your fork (`origin`) and fetch updates from the original repository (`upstream`), with direct pushes to `upstream` disabled for safety.

## Troubleshooting

### WSL2 Networking for the Custom-Bot Client

If the official custom-bot client runs inside WSL2 while Vite/backend run on Windows, `localhost` inside WSL2 does **not** point to Windows. You must connect to a Windows-reachable IP.

**Checklist:**
- Start Vite with `server.host = true` (or `bun run dev -- --host 0.0.0.0`) so it binds to a non-loopback address.
- Use one of the "Network" URLs printed by Vite (example: `http://172.27.160.1:5173/`).
- Run the bot client with `--server` set to that address, e.g.:

```bash
WIN_HOST=172.27.160.1
bun run start --server "http://$WIN_HOST:5173" --token cbt_...
```

If the connection still fails, check Windows Firewall for inbound rules on port 5173.

### CMake Path Conflicts (WSL vs Windows)

If you see an error like:
`CMake Error: The current CMakeCache.txt directory ... is different than the directory ... where CMakeCache.txt was created`

This happens because CMake is seeing the project through two different path styles (Windows `C:\...` vs WSL `/mnt/c/...`). 

**Solution:**
Delete the `build` directory and start fresh from within WSL:

```bash
rm -rf build
mkdir build && cd build
# Re-run the cmake command from Step 3
```

### Missing Package Errors

If CMake fails with errors like:

```
Could not find a package configuration file provided by "nlohmann_json"
```

**Solution:**
Install the missing package (see Step 2). For nlohmann_json specifically:

```bash
sudo apt update
sudo apt install -y nlohmann-json3-dev
```

Then re-run the cmake configuration command from the build directory.

# Usage

## Example

```bash
# Build the engine
cd deep-wallwars/build
cmake .. && make deep_ww_engine

# Running with the Official Client
# From the official client directory
./wallgame-bot-client \
  --server https://wallgame.example \
  --token <your-seat-token> \
  --engine "../deep-wallwars/build/deep_ww_engine --model ../deep-wallwars/build/8x8_750000.trt"
```

## Command-Line Flags

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

## Example with Simple Policy

```bash
./deep_ww_engine --model simple < request.json
```

## Testing Manually

Can be tested standalone with sample JSON requests:

```bash
echo '{"engineApiVersion":1,"kind":"move",...}' | ./deep_ww_engine --model simple
```

Or create a test request file (`request.json`):

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

## Appendix: Thorben deep wallwars training notes (8x8)

This appendix summarizes training-related details captured in `info/thorben.txt` that are useful when running or tuning Deep-Wallwars training runs.

### Latest 8x8 runs (Thorben)

- Thorben: ran an 8x8 training run “overnight / work day” and reached ~150k self-play games.
- Later: checked in a trained model snapshot after ~750k games (~100 hours).
- Standard 8x8 setup mentioned: player 1 starts top-left, player 2 top-right.

### Parameters used / implied

- Thorben’s guidance: his `scripts/training.py` run used defaults, except `--rows 8 --columns 8` (defaults otherwise correspond to the script defaults).
- Default self-play count mentioned as 5k games (suggested that this can be reduced for quicker runs).
- Warm-start detail: generation 1 was trained from 5000 games of MCTS guided by a heuristic (instead of the neural net).
- What he considers the primary “progress” metric: Elo (valuation accuracy is an “okay proxy”).
- Validation metrics he referenced at one point: ~91% valuation accuracy and >75% move accuracy (when using a proper train/validation split).

### Terminal commands captured

Build (WSL) example:

```bash
cd .. && rm -rf build && mkdir build && cd build
cmake -DCMAKE_PREFIX_PATH="...folly...;...fmt...;...glog..." ..
make clean && make -j32
```

Run (interactive GUI) example:

```bash
./deep_ww --interactive --model1 ../ignore/models_trained/model_40.trt --samples 5000 --rows 6 --columns 6 --gui &> ../out.txt
```

8x8 training invocation that was pasted in the notes (this is the only fully-expanded 8x8 `training.py` command present):

```bash
python training.py --rows 8 --columns 8 --epochs 2 --generations 10 --games 3000 --samples 1200 --threads 20
```

Threading/debug invocation:

```bash
./deep_ww --model1 simple --samples 50000 --rows 6 --columns 6 -j 20
```

### Recommended settings if you run a similar 8x8 training

- Closest to Thorben’s approach: run `scripts/training.py` with `--rows 8 --columns 8` and otherwise keep defaults (then let it run long enough to accumulate substantial total games).
- Don’t max out CPU threads: leave headroom for CPU work that feeds the GPU; the notes show worse GPU utilization when saturating all cores.
- Avoid accidentally limiting MCTS sampling parallelism: one observed slowdown came from setting “max parallel samples” to 4 instead of the default 256.

### Other valuable training notes / pitfalls

- Small boards can have huge cache-hit rates; that can make training CPU-limited even when you have a strong GPU.
- Increasing “GPU workers” (multiple model instances) can sometimes improve utilization; Thorben suggested 2 is usually enough.
- Data hygiene pitfall: mixing CSVs from different board sizes in the same generation folder can poison training because the loader reads all CSVs present (not just `--games` count).
- Performance work mentioned: using pinned memory for GPU transfers improved utilization; profiling indicated BFS/tensor-prep as a CPU bottleneck in some setups.
- Validation split pitfall: split by whole games, not by individual positions, to avoid leakage from adjacent positions between train/val.
- Windows-specific gotchas: default stack size on Windows is much smaller (~1MB vs ~8MB on Linux), and stack overflows can happen sooner with recursion/coroutine-heavy code; compiling without optimizations can also make this worse (even for debugging).
- Practical note: most of the discussed build + training workflow in the notes is done under WSL (not native Windows).
- The logs show training happening on a Windows machine via WSL paths (e.g. `/mnt/c/...`) and a Python virtual environment prompt `(.venv)`, not a native Windows Python/package-manager workflow.
- The notes do not identify a Python package manager (`pip`/`conda`/`poetry`/etc.); only `(.venv)` is shown.

## Appendix: Standard 8x8 training run setup (WSL sanity check)

This captures the exact setup steps and decisions used to get a Standard 8x8 sanity run working.

### Decisions made

- Run under WSL (not native Windows) because a library (folly IIRC) is not compatible. Also to avoid Windows stack-size issues and match prior logs.
- Use a Python venv inside `deep-wallwars/` (`deep-wallwars/.venv`) to keep ML deps isolated.
- Use GPU training (confirmed `nvidia-smi` and `torch.cuda.is_available()`).
- Keep Standard data/models/logs in separate folders to avoid mixing variants:
  - models: `deep-wallwars/models_8x8_standard`
  - data: `deep-wallwars/data_8x8_standard`
  - log: `deep-wallwars/logs/standard_8x8.log`

### Commands used (sanity check)

Create venv and upgrade pip (from `deep-wallwars/`):

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
```

Install GPU deps (in venv):

```bash
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
pip install fastai
pip install ipython
pip install onnx
```

Verify GPU in PyTorch:

```bash
python3 -c "import torch; print(torch.cuda.is_available(), torch.version.cuda)"
```

Run Standard 8x8 sanity training (from `deep-wallwars/scripts`):

```bash
mkdir -p ../logs
python3 training.py \
  --rows 8 --columns 8 --variant standard \
  --generations 1 --games 20 --training-games 20 \
  --samples 100 --threads 8 \
  --models ../models_8x8_standard --data ../data_8x8_standard \
  --log ../logs/standard_8x8.log
```

### Outcomes / checks

- Training completed and produced:
  - `deep-wallwars/models_8x8_standard/model_1.pt`
  - `deep-wallwars/models_8x8_standard/model_1.onnx`
  - `deep-wallwars/models_8x8_standard/model_1.trt`
- `standard_8x8.log` ends with `&&&& PASSED TensorRT.trtexec ...` which confirms the TRT build.
