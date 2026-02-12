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

The server runs on Fly.io. Stream logs with:

```
fly logs -a wallgame
```

Filter by region:

```
fly logs -a wallgame --region ewr
```

Run a command on the server machine:

```
fly ssh console -a wallgame -C "cat /path/to/log"
```

List running machines:

```
fly machines list -a wallgame
```

Note: if the machine is stopped (auto-stop is enabled), hit https://wallgame.fly.dev/ first or
run `fly machine start <MACHINE_ID> -a wallgame` to wake it up.

## Bot Client Logs (Home Machine)

The bot client (Deep Wallwars) runs on a home machine, not on Fly.io.

**Connection details:**
- IP: `100.110.68.46`
- SSH user: `nilo`
- Remote logs path: `/mnt/c/Users/Nilo/repos/wallgame/logs/`
- Key log file: `bot-client.log`

**Prerequisites:**
- The IP must be in `allowedHosts` in `.claude/settings.json` under `sandbox.network`
- A password file must exist at `~/.claude/ssh-bot-password` (not checked into the repo)

**Fetching logs (SSH_ASKPASS method):**

The sandbox blocks PTY allocation, so `sshpass` and `expect` don't work. Instead, use
`SSH_ASKPASS` to provide the password non-interactively:

1. Create the askpass helper (lives in /tmp, must recreate each session):

```bash
echo '#!/bin/bash\ncat /Users/nmamano/.claude/ssh-bot-password' > /tmp/claude/ssh-askpass.sh
chmod +x /tmp/claude/ssh-askpass.sh
```

2. List remote log files:

```bash
DISPLAY=:0 SSH_ASKPASS=/tmp/claude/ssh-askpass.sh SSH_ASKPASS_REQUIRE=force \
  ssh -o StrictHostKeyChecking=no nilo@100.110.68.46 \
  "ls -la /mnt/c/Users/Nilo/repos/wallgame/logs/" < /dev/null 2>&1
```

3. Download a log file:

```bash
DISPLAY=:0 SSH_ASKPASS=/tmp/claude/ssh-askpass.sh SSH_ASKPASS_REQUIRE=force \
  scp -o StrictHostKeyChecking=no \
  nilo@100.110.68.46:/mnt/c/Users/Nilo/repos/wallgame/logs/bot-client.log \
  /tmp/claude/bot-client.log < /dev/null 2>&1
```

4. Read the downloaded file locally.

**Why SSH_ASKPASS:** SSH normally reads passwords from a TTY. Redirecting stdin from `/dev/null`
removes the TTY, and `SSH_ASKPASS_REQUIRE=force` makes SSH call the askpass program instead.
This works within the sandbox without needing PTY allocation.
