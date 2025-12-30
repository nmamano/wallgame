Here is the complete guide to building and running the Deep-Wallwars project on your Windows machine using the WSL2 Ubuntu environment.

1. Enter the WSL Environment

Open your Git Bash or Windows terminal and enter your Ubuntu distribution:

```bash
wsl -d Ubuntu
cd /mnt/c/Users/Nilo/repos/Deep-Wallwars
```

2. Install Required System Packages

The project requires some additional libraries that need to be installed via apt. Run these commands in your WSL Ubuntu terminal:

```bash
# Update package lists
sudo apt update

# Install nlohmann-json (required for engine adapter)
sudo apt install -y nlohmann-json3-dev

# Install SFML (optional, only needed for --gui flag)
sudo apt install -y libsfml-dev
```

**What these packages do:**

- **nlohmann-json3-dev**: Modern C++ JSON library used by the engine adapter (`deep_ww_engine`) to parse and generate JSON requests/responses for the official custom-bot client.
- **libsfml-dev**: Simple and Fast Multimedia Library, enables the optional GUI for interactive play with the `--gui` flag.

**Note:** These only need to be installed once. After installation, they'll be available for all future builds.

3. Build the C++ Self-Play Core

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

4. Run C++ Tests and Executables

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
- `deep_ww_engine` - Engine adapter for the official custom-bot client (see [ENGINE_ADAPTER.md](../deep-wallwars/ENGINE_ADAPTER.md))

5. Run Python Training

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
