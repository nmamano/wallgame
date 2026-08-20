#!/bin/bash
# Wallgame bot health monitor.
#
# Polls the live bot list and alerts a Discord webhook when a bot drops off
# (crash OR websocket disconnect) or recovers, and restarts the bot client when
# it can. Run this from a machine OTHER than the one hosting the bot client:
# the whole point is to survive the failures that take the bot host down.
#
# Nothing host-specific lives in this file. Every deployment-specific value
# comes from a config file that is NOT in the repo - see the CONFIG block below
# and scripts/bot-monitor.env.example. Without a config it still runs: it just
# reports to stdout instead of Discord, and skips auto-restart.
#
# WHAT IT CHECKS, and why the third one is the one that matters:
#   A bot client can be running, with a live websocket that is happily ponging,
#   while the server's in-memory registry has no record of it - a "zombie
#   attach". Local process checks and heartbeat files both look perfectly
#   healthy in that state. Asking the PUBLIC bot listing the same question a
#   player's browser asks is the only check that sees it.
#
# Install as a systemd user timer: see scripts/wallgame-bot-monitor.{service,timer}
set -uo pipefail

# --- Config ------------------------------------------------------------------
# Sourced first so it can override any default below.
CONFIG_FILE="${WALLGAME_MONITOR_CONFIG:-$HOME/.wallgame-monitor.env}"
# shellcheck disable=SC1090
[ -f "$CONFIG_FILE" ] && source "$CONFIG_FILE"

# Discord webhook. Without it, alerts go to stdout (and the systemd journal).
WEBHOOK="${DISCORD_WEBHOOK_URL:-}"

# Public site to poll.
API_BASE="${WALLGAME_API_BASE:-https://wallgame.io}"

# ssh target hosting the bot client, and the command that restarts it. Leave
# BOT_HOST empty to disable auto-restart and alert only. The default command
# assumes a systemd USER unit, which is deliberate: `--user` needs no sudo, so
# the monitor can restart the bot over ssh without a sudoers rule.
BOT_HOST="${WALLGAME_BOT_HOST:-}"
BOT_RESTART_CMD="${WALLGAME_BOT_RESTART_CMD:-systemctl --user restart wallgame-bot}"

STATE_FILE="${WALLGAME_MONITOR_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/wallgame-bot-monitor.state}"

FAIL_THRESHOLD="${WALLGAME_MONITOR_FAIL_THRESHOLD:-2}" # consecutive misses before declaring DOWN
RESTART_COOLDOWN="${WALLGAME_MONITOR_RESTART_COOLDOWN:-1800}" # seconds between restart attempts

# bot id | variant | placement | display name. A bot only appears under the
# variants and placement it declares, so PuzzleBot must be queried through the
# puzzle-only listing rather than the ordinary opponent listing.
BOTS=(
  "dw-beginner|standard|opponent|Easy Bot"
  "dw-easy|standard|opponent|Normal Bot"
  "dw-transformer|standard|opponent|Superhuman Bot"
  "dw-puzzle|standard|puzzle|PuzzleBot"
  "experimental-animal-115|animal-cycle|opponent|Ruthless Bot"
)

# --- Helpers -----------------------------------------------------------------

send_discord() {
  local msg="$1"
  if [ -z "$WEBHOOK" ]; then echo "[warn] no webhook; would send: $msg"; return; fi
  curl -s -m 15 -H "Content-Type: application/json" \
    -d "{\"content\":\"$msg\"}" "$WEBHOOK" >/dev/null
}

mkdir -p "$(dirname "$STATE_FILE")"

# Prior state: line 1 = up|down, line 2 = consecutive fails, line 3 = last restart epoch
prev="up"; fails=0; last_restart=0
if [ -f "$STATE_FILE" ]; then
  prev="$(sed -n 1p "$STATE_FILE")"
  fails="$(sed -n 2p "$STATE_FILE")"
  last_restart="$(sed -n 3p "$STATE_FILE")"
fi
[ -z "$prev" ] && prev="up"
[[ "$fails" =~ ^[0-9]+$ ]] || fails=0
[[ "$last_restart" =~ ^[0-9]+$ ]] || last_restart=0

now="$(date -Is)"
now_epoch="$(date +%s)"

# --- Health check ------------------------------------------------------------
# One request per distinct variant/placement pair, not per bot. `reachable`
# tracks whether the site answered at all: without it, a site outage is
# indistinguishable from every bot being dead, and we would restart a perfectly
# healthy client.

declare -A listings=()
reachable=1
for entry in "${BOTS[@]}"; do
  variant="$(cut -d'|' -f2 <<< "$entry")"
  placement="$(cut -d'|' -f3 <<< "$entry")"
  listing_key="$variant|$placement"
  if [ -z "${listings[$listing_key]+set}" ]; then
    resp="$(curl -s -m 20 "$API_BASE/api/bots?variant=$variant&randomStart=false&placement=$placement")"
    [ -z "$resp" ] && reachable=0
    listings[$listing_key]="$resp"
  fi
done

missing=""
if [ "$reachable" = "1" ]; then
  for entry in "${BOTS[@]}"; do
    bot_id="$(cut -d'|' -f1 <<< "$entry")"
    variant="$(cut -d'|' -f2 <<< "$entry")"
    placement="$(cut -d'|' -f3 <<< "$entry")"
    label="$(cut -d'|' -f4 <<< "$entry")"
    listing_key="$variant|$placement"
    if ! printf '%s' "${listings[$listing_key]}" | grep -q "\"botId\":\"$bot_id\""; then
      missing="$missing $label"
    fi
  done
fi

state="$prev"

if [ "$reachable" = "0" ]; then
  # The site itself did not answer. Not the bot's fault, and a restart would not
  # help - so alert once and deliberately do NOT touch the bot client.
  fails=$((fails + 1))
  if [ "$prev" = "up" ] && [ "$fails" -ge "$FAIL_THRESHOLD" ]; then
    send_discord "🟠 **$API_BASE is not answering** (${now}). Cannot tell whether the bots are up. Not restarting anything - this is a site problem, not a bot problem."
    state="down"
  fi

elif [ -z "$missing" ]; then
  if [ "$prev" = "down" ]; then
    send_discord "🟢 **All wallgame bots are back online** (${now})"
  fi
  state="up"; fails=0

else
  fails=$((fails + 1))
  if [ "$fails" -ge "$FAIL_THRESHOLD" ]; then
    if [ "$prev" = "up" ]; then
      send_discord "🔴 **Wallgame bots missing from the site**:${missing} (${now})."
      state="down"
    fi

    # Recovery, cooldown-gated so a bot that cannot come back is not restarted
    # every few minutes indefinitely.
    since_restart=$(( now_epoch - last_restart ))
    if [ -n "$BOT_HOST" ] && [ "$since_restart" -ge "$RESTART_COOLDOWN" ]; then
      if ssh -o BatchMode=yes -o ConnectTimeout=10 \
             "$BOT_HOST" "$BOT_RESTART_CMD" >/dev/null 2>&1; then
        send_discord "🔧 Restarted the bot client. The next check will confirm whether it worked."
      else
        # ssh failing usually means the bot host itself is down, which is a
        # different and worse problem than a dead bot process.
        send_discord "⚠️ **Could not reach the bot host to restart it** (${now}). The host may be down entirely. If this repeats, it needs a look."
      fi
      last_restart="$now_epoch"
    fi
  fi
fi

printf '%s\n%s\n%s\n' "$state" "$fails" "$last_restart" > "$STATE_FILE"
echo "${now} reachable=${reachable} missing=[${missing# }] prev=${prev} -> state=${state} fails=${fails}"
