#!/bin/bash
# Holds a WSL VM open so it does not idle out and take everything with it.
#
# WHY THIS EXISTS: WSL idles out on SESSIONS, not processes. Running systemd
# services do not hold the VM open - this was measured on 2026-07-31, when the
# VM went from Running to Stopped about 35 seconds after the last ssh session
# closed, while both the bot client unit and tailscaled were active. A live
# tmux/login session is the only thing that keeps it up. When the VM dies it
# takes the bot client, the engines, the WSL tailscale node, and any training
# run with it.
#
# Idempotent on purpose: this is called every few minutes, so re-running must be
# a no-op. Note that `tmux new-session -A -d` does NOT work here - with -A, tmux
# behaves like attach-session when the session already exists, and attaching
# needs a TTY that a scheduled task does not have ("open terminal failed: not a
# terminal"). The has-session guard is the correct pattern.
#
# Install (inside WSL):
#   cp scripts/wsl-keepalive.sh ~/wsl-keepalive.sh && chmod +x ~/wsl-keepalive.sh
# Then drive it from Windows Task Scheduler via scripts/wsl-keepalive.vbs.
SESSION="${WSL_KEEPALIVE_SESSION:-keepalive}"
tmux has-session -t "$SESSION" 2>/dev/null || tmux new-session -d -s "$SESSION" "sleep infinity"
