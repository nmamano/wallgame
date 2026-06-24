# Deploying the Minimax "Legacy" bot

A **non-official** custom bot serving the classic-Wallwars minimax engine in two
fixed board sizes — **8×8 @ 3s/move** and **6×6 @ 1.5s/move**. It runs from this
box (auntie) and connects out to `wallgame.fly.dev`; no server deploy is needed.

## 1. Build the engine (once, and after any engine change)
```bash
cd /home/nil/nil/wallgame/minimax-engine
cmake --preset release && ( cd build_release && make minimax_bgs_engine )
```
Produces `build_release/minimax_bgs_engine` — the path `minimax.prod.config.json`
references (it's gitignored, so it must be built on the host).

## 2. Run it manually (foreground test)
```bash
cd /home/nil/nil/wallgame/official-custom-bot-client
bun run src/index.ts --client-id minimax-prod --config /home/nil/nil/wallgame/minimax-engine/deploy/minimax.prod.config.json --log-level info
```

## 3. Install as a service (survives reboots / Isomux restarts) — needs sudo
```bash
sudo cp /home/nil/nil/wallgame/minimax-engine/deploy/wallgame-minimax.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wallgame-minimax.service
sudo systemctl status wallgame-minimax.service     # verify active
sudo journalctl -u wallgame-minimax.service -f      # follow logs
```

## Notes
- **Non-official:** no `OFFICIAL_BOT_TOKEN` needed; regular custom bots. They are
  not auto-selected as the eval-bar engine in human-vs-human games (that uses an
  official bot). Note: when someone *plays* this bot, the eval bar reuses this
  bot's own session, so it shows the minimax engine's own eval.
- **Two bots** ("Legacy Bot" 8×8 and "Legacy Bot" 6×6) — one client, two engine
  processes (the same binary with `--rows 8` vs `--rows 6`).
- **Separate** from `wallgame-bot.service` (the Deep-Wallwars bots) — independent
  lifecycle; restarting this never touches that.
