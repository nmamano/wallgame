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
# It also times that check. A slow site makes the bot client's 30s ping go
# unanswered, so the client drops its socket and a game in flight can be
# forfeited (2026-10-25 and 2026-10-30: 40 drops while these checks took ~10s
# instead of ~2.6s). It alerts on the change only: slow (2 checks in a row),
# still slow after SLOW_REMIND_RUNS checks, normal again (only after a "slow").
#
# It also alarms when a bot engine process crashes, so that an agent
# investigates it (task 8a81a189). Each crash is alerted once: a state file
# beside STATE_FILE remembers the log position already read.
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

# Isomux webhook that wakes an agent on each alert (URL and the file that holds
# its secret). Leave either empty to send no Isomux message.
ISOMUX_HOOK_URL="${WALLGAME_MONITOR_ISOMUX_HOOK_URL:-}"
ISOMUX_HOOK_SECRET_FILE="${WALLGAME_MONITOR_ISOMUX_HOOK_SECRET_FILE:-}"

# Public site to poll.
API_BASE="${WALLGAME_API_BASE:-https://wallgame.io}"

# ssh target hosting the bot client, and the command that restarts it. Leave
# BOT_HOST empty to disable auto-restart and alert only. The default command
# assumes a systemd USER unit, which is deliberate: `--user` needs no sudo, so
# the monitor can restart the bot over ssh without a sudoers rule.
BOT_HOST="${WALLGAME_BOT_HOST:-}"
BOT_RESTART_CMD="${WALLGAME_BOT_RESTART_CMD:-systemctl --user restart wallgame-bot}"
# The bot client's log on BOT_HOST, relative to the login directory.
BOT_LOG="${WALLGAME_BOT_LOG:-logs/bot-client-transformer.log}"
# The ssh command (without the host). Tests replace it with a local stand-in.
read -r -a BOT_SSH <<< "${WALLGAME_MONITOR_SSH:-ssh -o BatchMode=yes -o ConnectTimeout=10}"

STATE_FILE="${WALLGAME_MONITOR_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/wallgame-bot-monitor.state}"

FAIL_THRESHOLD="${WALLGAME_MONITOR_FAIL_THRESHOLD:-2}" # consecutive misses before declaring DOWN
RESTART_COOLDOWN="${WALLGAME_MONITOR_RESTART_COOLDOWN:-1800}" # seconds between restart attempts
SLOW_MS="${WALLGAME_MONITOR_SLOW_MS:-10000}" # a check slower than this is "slow"
SLOW_REMIND_RUNS="${WALLGAME_MONITOR_SLOW_REMIND_RUNS:-6}" # slow checks in a row before "still slow"

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
  # Discord refuses a message longer than 2000 characters.
  local msg="${1:0:1900}"
  send_isomux "$msg"
  if [ -z "$WEBHOOK" ]; then echo "[warn] no webhook; would send: $msg"; return; fi
  # jq builds the body: an alert can now quote engine output, and a quote or a
  # backslash in it must not break the JSON.
  jq -cn --arg content "$msg" '{content: $content}' |
    curl -s -m 15 -H "Content-Type: application/json" -d @- "$WEBHOOK" >/dev/null
}

# Every alert also wakes an agent through an Isomux webhook (HMAC-SHA256 over
# the body, secret in its own 0600 file), so an outage does not wait for a
# human to read Discord. Off when either value is unset.
send_isomux() {
  local msg="$1" body sig
  if [ -z "$ISOMUX_HOOK_URL" ] || [ ! -r "$ISOMUX_HOOK_SECRET_FILE" ]; then return; fi
  body="$(jq -cn --arg text "$msg" '{kind: "bot-monitor", text: $text}')"
  sig="$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$(cat "$ISOMUX_HOOK_SECRET_FILE")" -r | cut -d' ' -f1)"
  curl -s -m 15 -o /dev/null -w "[isomux hook] HTTP %{http_code}\n" \
    -H "Content-Type: application/json" -H "x-bot-monitor-event: bot-monitor" \
    -H "x-bot-monitor-signature: sha256=$sig" -d "$body" "$ISOMUX_HOOK_URL"
}

mkdir -p "$(dirname "$STATE_FILE")"

# Prior state: line 1 = up|down, line 2 = consecutive fails, line 3 = last restart
# epoch, line 4 = consecutive slow checks
prev="up"; fails=0; last_restart=0; slow_runs=0
if [ -f "$STATE_FILE" ]; then
  prev="$(sed -n 1p "$STATE_FILE")"
  fails="$(sed -n 2p "$STATE_FILE")"
  last_restart="$(sed -n 3p "$STATE_FILE")"
  slow_runs="$(sed -n 4p "$STATE_FILE")"
fi
[ -z "$prev" ] && prev="up"
[[ "$fails" =~ ^[0-9]+$ ]] || fails=0
[[ "$last_restart" =~ ^[0-9]+$ ]] || last_restart=0
[[ "$slow_runs" =~ ^[0-9]+$ ]] || slow_runs=0

now="$(date -Is)"
now_epoch="$(date +%s)"

# --- Health check ------------------------------------------------------------
# One request per distinct variant/placement pair, not per bot. `reachable`
# tracks whether the site answered at all: without it, a site outage is
# indistinguishable from every bot being dead, and we would restart a perfectly
# healthy client.

declare -A listings=()
reachable=1
check_start_ms="$(date +%s%3N)"
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
check_ms=$(( $(date +%s%3N) - check_start_ms ))
check_s="$(awk -v ms="$check_ms" 'BEGIN { printf "%.1f", ms / 1000 }')"
slow_s="$(awk -v ms="$SLOW_MS" 'BEGIN { printf "%.0f", ms / 1000 }')"

# Speed alerts. A check where the site did not answer at all leaves the slow
# count as it is: the outage alert below covers that case, and one dead check
# inside a slow spell must not read as "normal again".
#
# "Slow" needs SLOW_CONFIRM_RUNS slow checks in a row, and "fast again" goes
# out only after a "slow" did. The 2026-10-25/30 averages (8.7s, 11.8s) sit
# on both sides of the 10s limit, so alerting on single checks would flap
# slow/fast every 5 minutes and wake an agent each time.
SLOW_CONFIRM_RUNS=2
if [ "$reachable" = "1" ]; then
  if [ "$check_ms" -gt "$SLOW_MS" ]; then
    slow_runs=$((slow_runs + 1))
    if [ "$slow_runs" -eq "$SLOW_CONFIRM_RUNS" ]; then
      send_discord "🐢 **$API_BASE is slow**: ${slow_runs} bot checks in a row took more than ${slow_s}s, the last one ${check_s}s (${now}). Bot games can lose their connection while this lasts."
    elif [ "$slow_runs" -eq "$SLOW_REMIND_RUNS" ]; then
      send_discord "🐢 **$API_BASE is still slow** after ${slow_runs} checks in a row: this check took ${check_s}s (${now})."
    fi
  else
    if [ "$slow_runs" -ge "$SLOW_CONFIRM_RUNS" ]; then
      send_discord "✅ **$API_BASE is fast again** after ${slow_runs} slow checks: this check took ${check_s}s (${now})."
    fi
    slow_runs=0
  fi
fi

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
      if "${BOT_SSH[@]}" "$BOT_HOST" "$BOT_RESTART_CMD" >/dev/null 2>&1; then
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

# --- Engine crashes ---------------------------------------------------------------
# The bot client logs "Bot <id> will NOT be advertised: <reason>" when it
# withdraws a bot - an engine that exited, at startup or in a game - followed by
# the engine's last stderr lines ("<id> said: ..."). Read only what the log
# gained since the last run, so each crash is alerted once.
CRASH_OFFSET_FILE="$STATE_FILE.crash-offset"

# Runs on BOT_HOST with the offset and log path as arguments. Prints the log
# size on line 1, then the last withdrawal of each of up to 5 bots and the last
# 3 engine lines. The output stays under 1 KB:
# larger ssh output from the 4090 desktop can stall. The client's startup line
# carries --official-token in the clear; nothing selected here should, but it
# is redacted anyway.
# shellcheck disable=SC2016
CRASH_SCAN='off="$1"; log="$2"
size="$(stat -c %s "$log")" || exit 1
[ "$off" -le "$size" ] 2>/dev/null || off=0
echo "$size"
found="$(tail -c +"$((off + 1))" "$log" |
  grep -aE "will NOT be advertised: | said: " |
  sed -E "s/(--official-token[= ])[^ ]+/\1<redacted>/g; s/^\[[^]]*\] \[[A-Z]+\] *//" |
  cut -c1-110)"
grep "will NOT be advertised: " <<< "$found" | tail -n 5
grep " said: " <<< "$found" | tail -n 3'

check_crashes() {
  [ -n "$BOT_HOST" ] || return
  local off out size lines
  off="$(cat "$CRASH_OFFSET_FILE" 2>/dev/null)"
  out="$("${BOT_SSH[@]}" "$BOT_HOST" "bash -s -- ${off:-0} $BOT_LOG" <<< "$CRASH_SCAN" 2>/dev/null)" || return
  size="$(head -n 1 <<< "$out")"
  [[ "$size" =~ ^[0-9]+$ ]] || return
  echo "$size" > "$CRASH_OFFSET_FILE"
  # No offset yet: start from the end of the log; history is not news.
  [ -n "$off" ] || return
  lines="$(tail -n +2 <<< "$out")"
  grep -q "will NOT be advertised: " <<< "$lines" || return
  send_discord "💥 **A bot engine crashed** (seen ${now}). The bot client withdrew it:
\`\`\`
${lines:0:900}
\`\`\`
Any game it was playing was forfeited. Investigate the crash."
}

check_crashes

printf '%s\n%s\n%s\n%s\n' "$state" "$fails" "$last_restart" "$slow_runs" > "$STATE_FILE"
echo "${now} reachable=${reachable} missing=[${missing# }] prev=${prev} -> state=${state} fails=${fails} check=${check_s}s slow_runs=${slow_runs}"
