#!/bin/bash
# Bot monitor - checks if the wallgame bot service is healthy and alerts via Discord.
#
# Checks:
# 1. systemd service is active
# 2. Recent logs show successful attachment (within last check interval)
#
# Usage: Called by systemd timer. Requires DISCORD_WEBHOOK_URL env var.
#
# State file tracks whether we've already alerted to avoid spam.

STATE_FILE="/tmp/wallgame-bot-monitor-state"
SERVICE="wallgame-bot"

alert() {
    local message="$1"
    if [ -z "$DISCORD_WEBHOOK_URL" ]; then
        echo "ALERT (no webhook configured): $message"
        return
    fi
    curl -s -H "Content-Type: application/json" \
        -d "{\"content\":\"$message\"}" \
        "$DISCORD_WEBHOOK_URL" > /dev/null
}

# Check if service is running
if ! systemctl is-active --quiet "$SERVICE"; then
    if [ ! -f "$STATE_FILE" ]; then
        alert "🔴 **Wallgame bot is down.** Service \`$SERVICE\` is not running."
        touch "$STATE_FILE"
    fi
    exit 1
fi

# Check recent logs for WebSocket errors without subsequent successful attach
last_attached=$(journalctl -u "$SERVICE" --no-pager -g "Successfully attached" --since "10 minutes ago" 2>/dev/null | tail -1)
last_error=$(journalctl -u "$SERVICE" --no-pager -g "Failed to connect|WebSocket error" --since "10 minutes ago" 2>/dev/null | tail -1)

if [ -n "$last_error" ] && [ -z "$last_attached" ]; then
    if [ ! -f "$STATE_FILE" ]; then
        alert "🟡 **Wallgame bot is disconnected.** Service is running but can't reach the server. It will keep retrying."
        touch "$STATE_FILE"
    fi
    exit 1
fi

# All good - clear alert state if previously alerted
if [ -f "$STATE_FILE" ]; then
    rm "$STATE_FILE"
    alert "🟢 **Wallgame bot is back online.**"
fi

exit 0
