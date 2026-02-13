# Fly.io Deployment Debugging Notes (WallGame)

Use this as a reference for future deploys.

---

The issue was caused by a Dockerfile regex that deleted **everything inside dist**, leaving:

```
/app/frontend → empty
/app/frontend/dist → missing
```

Therefore:

- The server tried to serve ./frontend/dist/index.html
- That file didn't exist
- → GET / returned 404

The regex shouldn't be touched.

---

# Confirming the Issue Inside the Running Fly Machine

SSH into the machine:

```
fly ssh console -a wallgame
```

Then inspect:

```
ls -R /app/frontend
ls -R /app/frontend/dist
```

This confirmed the directory was empty.

Whenever the app returns 404 on `/`, always check whether dist exists inside the container.

---

# Why It Worked Locally but Not in Production

Locally:

- `bun run start` uses your actual project directory
- `frontend/dist` exists
- Everything works

In production:

- The Docker image filesystem is separate
- The destructive find command removed the build output
- → Server had no files to serve

---

# Fly.io Auto-Stop Behavior (“no started VMs”)

Your fly.toml contains:

```
auto_stop_machines = "stop"
auto_start_machines = true
```

This means:

- Machines stop after idle time
- `fly ssh console` may say:

```
Error: app has no started VMs
```

This is normal.  
A new request auto-starts the machine.

```
fly machine list -a wallgame
fly machine start <MACHINE_ID> -a wallgame
```

Or hit: https://wallgame.fly.dev/

---

# Fly Builder 401 Errors (Depot)

Fly's Depot builder sometimes returns:

```
unexpected status ... 401 Unauthorized
```

This is not your fault.

The fix:

```
fly deploy --depot=false -a wallgame
```

This bypasses Depot and uses the regular builder, but it is slow.

The cause was that the fly cli was too old. Downloaded the latest version from the site and updated

---

# Accessing Production Logs

## Server Logs (Fly.io)

The server runs on Fly.io.

**From a terminal (outside Claude Code sandbox):**

```bash
fly logs -a wallgame              # Stream live logs
fly logs -a wallgame --region lax # Filter by region
fly machines list -a wallgame     # List machines
```

**From Claude Code sandbox:**

The `fly` CLI fails in the sandbox due to TLS certificate interception. Use the Fly REST API
with `curl -sk` (skip TLS verification) instead:

```bash
# One-time setup per session: copy fly config to a writable directory
mkdir -p /tmp/claude/fly-config && cp -r ~/.fly/* /tmp/claude/fly-config/ 2>/dev/null

# Fetch recent server logs
TOKEN=$(FLY_CONFIG_DIR=/tmp/claude/fly-config fly auth token 2>/dev/null) && \
curl -sk -H "Authorization: FlyV1 $TOKEN" \
  "https://api.fly.io/api/v1/apps/wallgame/logs" | \
python3 -c "
import json, sys
for e in json.load(sys.stdin).get('data', []):
    print(e['attributes']['timestamp'], e['attributes']['message'])
"
```

Prerequisites:
- `api.fly.io` and `flyctl-metrics.fly.dev` must be in `allowedHosts` in
  `.claude/settings.json` under `sandbox.network`
- `~/.fly/config.yml` must contain a valid access token (run `fly auth login` outside sandbox)

Note: if the machine is stopped (auto-stop is enabled), hit https://wallgame.fly.dev/ first to
wake it up.

## Bot Client Logs (Home Machine)

The bot client (Deep Wallwars) runs on a home machine via Tailscale, not on Fly.io.

**Connection details:**
- IP: `100.110.68.46` (Tailscale)
- SSH user: `nilo`
- SSH password: stored in `~/.claude/ssh-bot-password` (plain text, not checked into repo)
- Remote logs path: `/mnt/c/Users/Nilo/repos/wallgame/logs/bot-client.log`

**Prerequisites:**
- `100.110.68.46` must be in `allowedHosts` in `.claude/settings.json` under `sandbox.network`
- `~/.claude/ssh-bot-password` must contain the SSH password (plain text, no trailing newline)

**Fetching logs from Claude Code sandbox:**

```bash
# One-time setup per session: create an askpass helper script
printf '#!/bin/sh\ncat ~/.claude/ssh-bot-password\n' > /tmp/claude/ssh-askpass && chmod +x /tmp/claude/ssh-askpass

# Fetch recent bot logs (adjust tail count as needed)
DISPLAY=:0 SSH_ASKPASS="/tmp/claude/ssh-askpass" SSH_ASKPASS_REQUIRE=force \
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
  nilo@100.110.68.46 \
  "tail -200 /mnt/c/Users/Nilo/repos/wallgame/logs/bot-client.log" 2>&1

# Or: search for a specific game ID
DISPLAY=:0 SSH_ASKPASS="/tmp/claude/ssh-askpass" SSH_ASKPASS_REQUIRE=force \
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
  nilo@100.110.68.46 \
  "grep 'GAME_ID' /mnt/c/Users/Nilo/repos/wallgame/logs/bot-client.log" 2>&1
```

**Why this works:** `SSH_ASKPASS_REQUIRE=force` makes SSH use the askpass program for password
entry instead of a TTY prompt. `DISPLAY=:0` provides a dummy display value so SSH considers askpass eligible
(some OpenSSH builds require a non-empty `DISPLAY`). The askpass script simply echoes the password to stdout.
