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
