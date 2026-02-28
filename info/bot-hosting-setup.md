# Bot Hosting Setup (Ubuntu Desktop)

This documents the setup for running the Deep Wallwars bot client as a permanent service on an Ubuntu desktop with an NVIDIA GPU.

## Requirements

- **GPU:** NVIDIA GPU with TensorRT support (tested with RTX 5090)
- **OS:** Ubuntu 24.04 LTS

## What's Running

A systemd service (`wallgame-bot`) runs the official bot client, which connects to the production server at `https://wallgame.fly.dev` and spawns Deep Wallwars BGS engine processes for each bot.

### Bots

| Bot ID | Name | Variant | Model | Samples |
|--------|------|---------|-------|---------|
| dw-classic-8x8 | Hard Bot | classic 5x5–8x8 | `build/8x8_750000.trt` | 1000 |
| dw-standard-8x8 | Normal Bot | standard 5x5–8x8 | `models_8x8_standard/model_27.trt` | 2000 |
| dw-universal | Experimental Bot | classic/standard/freestyle 9x9–12x10 | `models_12x10_universal/model_48.trt` | 40000 |

The `.pt` model weights are in `deep-wallwars/assets/models/`. The `.trt` files are GPU-specific and must be generated from `.pt` → `.onnx` → `.trt` (see Rebuilding section).

## Service Management

```bash
# Check status
sudo systemctl status wallgame-bot

# View live logs
sudo journalctl -u wallgame-bot -f

# Restart (e.g., after config or model changes)
sudo systemctl restart wallgame-bot

# Stop
sudo systemctl stop wallgame-bot

# Start
sudo systemctl start wallgame-bot
```

The service:
- Starts automatically on boot
- Auto-restarts on crash (5 second delay)
- Reconnects indefinitely on WebSocket disconnects (exponential backoff up to 5 min)
- Runs as the `ubuntu` user
- Logs to journald

## Health Monitoring

A systemd timer (`wallgame-bot-monitor.timer`) checks bot health every 5 minutes and sends alerts to Discord:

- 🔴 Alert when the service is not running
- 🟡 Alert when the service is running but can't reach the server
- 🟢 Recovery alert when the bot comes back online

Alerts are sent once per incident (no spam). The Discord webhook URL is in `.env.prod`.

```bash
# Check timer status
systemctl list-timers wallgame-bot-monitor.timer

# Run a manual health check
sudo systemctl start wallgame-bot-monitor.service

# View monitor logs
sudo journalctl -u wallgame-bot-monitor
```

The monitoring script is at `scripts/bot-monitor.sh` and the systemd units are at `scripts/wallgame-bot-monitor.{service,timer}`.

## Config & Secrets

- **Bot config:** `official-custom-bot-client/deep-wallwars.prod.config.json` (committed)
- **Secrets:** `official-custom-bot-client/.env.prod` (not committed, contains `OFFICIAL_BOT_TOKEN` and `DISCORD_WEBHOOK_URL`)

Edit the config and restart the service to change bot configuration.

## Sleep Prevention

The machine is configured to never sleep, suspend, or hibernate:

- systemd targets `sleep`, `suspend`, `hibernate`, `hybrid-sleep` are masked
- logind ignores lid switch, suspend key, hibernate key, and idle
- GNOME screensaver and auto-lock are disabled

## Build Dependencies

The Deep Wallwars engine was built from source with:

- **NVIDIA driver 590** (open kernel modules, required for RTX 5090)
- **CUDA Toolkit 12.8**
- **TensorRT 10.15**
- **Folly** (built from source, v2024.12.02.00)
- **Catch2 v3**, gflags, glog, nlohmann-json, CMake 3.28

TRT model files in `deep-wallwars/build/` are GPU-specific (compiled for RTX 5090). If the GPU changes, delete the `.trt` files and rebuild with `make` to regenerate them from the `.onnx` sources.

## Rebuilding

```bash
cd ~/repos/wallgame/deep-wallwars/build
cmake .. -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_PREFIX_PATH=/usr/local
make -j$(nproc)
sudo systemctl restart wallgame-bot
```
