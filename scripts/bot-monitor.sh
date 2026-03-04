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

# Check heartbeat file staleness (catches zombie WebSocket connections)
# Skip this check if service started recently (allow time for first pong)
HEARTBEAT_FILE="/home/ubuntu/repos/wallgame/.wallgame-bot-heartbeat"
HEARTBEAT_MAX_AGE=120 # 2 minutes
STARTUP_GRACE_SECONDS=90

service_start_epoch=$(date -d "$(systemctl show "$SERVICE" --property=ActiveEnterTimestamp --value 2>/dev/null)" +%s 2>/dev/null)
now_epoch=$(date +%s)
if [ -n "$service_start_epoch" ] && [ "$service_start_epoch" -gt 0 ] 2>/dev/null; then
    service_uptime_seconds=$(( now_epoch - service_start_epoch ))
    if [ "$service_uptime_seconds" -lt "$STARTUP_GRACE_SECONDS" ]; then
        # Service just started — skip heartbeat check
        :
    else
        if [ ! -f "$HEARTBEAT_FILE" ]; then
            if [ ! -f "$STATE_FILE" ]; then
                alert "🟡 **Wallgame bot has no heartbeat.** Service is running but no pong received. May be a zombie connection."
                touch "$STATE_FILE"
            fi
            exit 1
        fi

        heartbeat_age=$(( $(date +%s) - $(stat -c %Y "$HEARTBEAT_FILE") ))
        if [ "$heartbeat_age" -gt "$HEARTBEAT_MAX_AGE" ]; then
            if [ ! -f "$STATE_FILE" ]; then
                alert "🟡 **Wallgame bot heartbeat stale** (${heartbeat_age}s old). WebSocket may be in zombie state."
                touch "$STATE_FILE"
            fi
            exit 1
        fi
    fi
fi

# All good - clear alert state if previously alerted
if [ -f "$STATE_FILE" ]; then
    rm "$STATE_FILE"
    alert "🟢 **Wallgame bot is back online.**"
fi

exit 0
