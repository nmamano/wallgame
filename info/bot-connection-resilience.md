# Bot Connection Resilience

How the wallgame bot client maintains a persistent WebSocket connection to the
server and recovers from failures.

## The Problem

The bot client connects from a home server to the Fly.io-hosted game server over
a long-lived WebSocket. Several things can silently kill this connection:

- **Fly.io machine restarts** — the server process moves to a new VM
- **NAT timeout** — intermediate routers drop idle TCP mappings (~2–5 minutes)
- **Network blips** — ISP hiccups, Wi-Fi drops, route changes

When the TCP connection dies silently, no `close` event fires on the client.
The WebSocket sits in a zombie state — `readyState` says OPEN, but nothing
reaches the server. The bot appears online but never responds to game requests.

## Solution: Three Layers of Defence

### Layer 1: Application-Level Ping/Pong

**Client** (`official-custom-bot-client/src/ws-client.ts`):
- After attaching, sends `{"type":"ping"}` every **30 seconds**
- Tracks whether a pong was received before sending the next ping
- If no pong → connection is dead → calls `ws.close()` to trigger reconnect
- On each pong, touches the heartbeat file (for Layer 3)

**Server** (`server/routes/custom-bot-socket.ts`):
- Responds to `{"type":"ping"}` with `{"type":"pong"}` immediately
- Handled via exact string match *before* typed JSON parsing (ping/pong is
  outside the typed protocol contract to avoid polluting the message types)

**Detection time:** 30–60 seconds (one missed pong cycle).

**Key implementation detail:** `pongReceived` is set to `false` *after* the
`ws.send()` succeeds, not before. If send throws, the flag stays true and the
catch handler closes the socket. This avoids false dead-connection detection on
transient send failures.

### Layer 2: Automatic Reconnection with Exponential Backoff

When the WebSocket closes (whether from a ping timeout, server restart, or
network error), the client reconnects automatically:

| Attempt | Base Delay | With Jitter (0–2s) |
|---------|-----------|---------------------|
| 1       | 1s        | 1–3s                |
| 2       | 2s        | 2–4s                |
| 3       | 4s        | 4–6s                |
| 4       | 8s        | 8–10s               |
| ...     | ...       | ...                 |
| cap     | 5 min     | 5:00–5:02           |

Engine processes (the C++ MCTS engines) are **long-lived** — they survive
reconnections. Only the WebSocket is re-established and a new `attach` message
sent. This avoids the ~2s engine startup cost on every reconnect.

**Permanent failures** that disable reconnection:
- `INVALID_OFFICIAL_TOKEN` — wrong credentials
- `PROTOCOL_UNSUPPORTED` — version mismatch
- `INVALID_BOT_CONFIG` — bad bot configuration
- `NO_BOTS` — empty bot list

### Layer 3: External Health Monitor

**Script:** `scripts/bot-monitor.sh`
**Schedule:** systemd timer, every 5 minutes

Three checks, in order:

1. **Is the systemd service running?**
   `systemctl is-active wallgame-bot` — catches process crashes

2. **Are there recent errors without a subsequent attach?**
   Scans `journalctl` for WebSocket errors in the last 10 minutes — catches
   the case where the service is running but stuck in a reconnect loop

3. **Is the heartbeat file fresh?**
   Checks if `.wallgame-bot-heartbeat` was modified in the last **2 minutes**
   — catches the zombie state that checks 1 and 2 miss (service running, no
   errors in logs, but WebSocket is silently dead)

A **90-second grace period** after service start skips the heartbeat check,
since the first pong won't arrive until ~30s after attach.

Alerts go to Discord via `DISCORD_WEBHOOK_URL`. A state file
(`/tmp/wallgame-bot-monitor-state`) prevents duplicate alerts.

## File Locations

| File | Purpose |
|------|---------|
| `official-custom-bot-client/src/ws-client.ts` | Ping loop, reconnect logic |
| `server/routes/custom-bot-socket.ts` | Server-side pong response |
| `scripts/bot-monitor.sh` | External health monitor |
| `scripts/wallgame-bot-monitor.service` | systemd oneshot for monitor |
| `scripts/wallgame-bot-monitor.timer` | 5-minute timer trigger |
| `.wallgame-bot-heartbeat` | Heartbeat file (repo root, gitignored) |

## Constants

```
PING_INTERVAL_MS        = 30,000      (30s between pings)
HEARTBEAT_MAX_AGE       = 120         (2 min before monitor alerts)
STARTUP_GRACE_SECONDS   = 90          (grace period after restart)
RECONNECT_BASE_DELAY_MS = 1,000       (1s initial backoff)
RECONNECT_MAX_DELAY_MS  = 300,000     (5 min backoff cap)
RECONNECT_JITTER_MAX_MS = 2,000       (0–2s random jitter)
BGS_REQUEST_TIMEOUT_MS  = 10,000      (10s per game request)
```

## Gotchas

**PrivateTmp:** The bot systemd service uses `PrivateTmp=yes`, so its `/tmp` is
isolated. The heartbeat file must be written outside `/tmp` — we use
`.wallgame-bot-heartbeat` in the repo root.

**Exact string matching:** Both client and server use exact string comparison
(`data === '{"type":"pong"}'`) rather than JSON parsing for ping/pong. This is
faster and avoids type-system conflicts, but means the serialized form must
match exactly. `JSON.stringify({ type: "pong" })` always produces
`{"type":"pong"}` for a single-key object, so this is safe.

**Deploy ordering:** When deploying server changes, the server restarts on
Fly.io and the bot's existing connection drops. The bot reconnects automatically
via Layer 2. If the ping handler isn't deployed yet, the first ping will go
unanswered and the bot will reconnect — this is fine, it just adds one extra
30s cycle. Deploy server first, then restart bot.

## Useful Commands

```bash
# Service management
sudo systemctl status wallgame-bot
sudo systemctl restart wallgame-bot
journalctl -u wallgame-bot -f             # Live logs

# Verify ping/pong
journalctl -u wallgame-bot --since "5 min ago" | grep -i pong

# Check heartbeat
stat .wallgame-bot-heartbeat              # Should be <60s old

# Run monitor manually
bash scripts/bot-monitor.sh && echo "OK"

# Check monitor timer
systemctl list-timers wallgame-bot-monitor.timer
```
