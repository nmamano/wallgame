Here is the complete guide to building and running the Deep-Wallwars project on your Windows machine using the WSL2 Ubuntu environment.

1. Enter the WSL Environment

Open your Git Bash or Windows terminal and enter your Ubuntu distribution:

```bash
wsl -d Ubuntu
cd /mnt/c/Users/Nilo/repos/Deep-Wallwars
```

2. Build the C++ Self-Play Core

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

### GUI Support (Optional)

If you want to use the `--gui` flag, you need to install SFML before running CMake:

```bash
sudo apt update
sudo apt install libsfml-dev
```

Then rebuild with CMake. The build system will automatically detect SFML and enable `GUI_ENABLED`.
```

3. Run C++ Tests and Executables

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

4. Run Python Training

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

### CMake Path Conflicts (WSL vs Windows)

If you see an error like:
`CMake Error: The current CMakeCache.txt directory ... is different than the directory ... where CMakeCache.txt was created`

This happens because CMake is seeing the project through two different path styles (Windows `C:\...` vs WSL `/mnt/c/...`). 

**Solution:**
Delete the `build` directory and start fresh from within WSL:
```bash
rm -rf build
mkdir build && cd build
# Re-run the cmake command from Step 2
```
