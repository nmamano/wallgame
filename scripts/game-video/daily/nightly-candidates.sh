#!/bin/bash
# The daily video's data step: restore the newest nightly Wall Game backup into
# a throwaway database, pick the day's candidates from it, and remove the
# database again. Board task e8d26610, step 3.
#
#   scripts/game-video/daily/nightly-candidates.sh OUT_DIR [--manual-stamp STAMP]
#
# --manual-stamp is for a person testing by hand, never for the timer: it lets
# a stamp that is not today's through the day check below, and only when it is
# exactly the stamp that `fresh` verified. Every other term still applies.
#
# Writes OUT_DIR/<UTC day>.json (the candidate report) or OUT_DIR/<UTC day>.skip
# (one line: why there is no report today). The crew lead reads one of the two.
#
# Run by the user timer wallgame-daily-candidates.timer at 11:30 UTC, after
# the 10:20 UTC backup. THE BACKUP OWNER'S TERMS (Lead SRE, standing OK of
# 2026-10-26, through Wall Game PM), which this script keeps:
#   1. Read only the newest wallgame stamp, the one `vpsbackup.py fresh`
#      verified; write, move or lock nothing in store/ or keys/. If `fresh`
#      exits non-zero, skip the day. The backup alert is not ours.
#   2. Use the identity only as `age -d -i <identity>` streamed into
#      pg_restore. No plaintext dump on disk.
#   3. A container with --network none, no published port and no bind mount,
#      on a named volume, both with a unique name per run, both removed by an
#      exit trap, after a failure too.
#   4. Output only game fields (games, moves, display names). pg_restore's own
#      errors can quote a row, so only their first line, with quoted text cut,
#      reaches the log.
#
# ONE FUNCTION IS THE SOURCE. restore_source() leaves a database named
# wallgame in container $SOURCE; pick() reads it. A read-only production query
# can replace restore_source() and the trap without touching the rest.
set -euo pipefail

OUT_DIR=${1:?usage: nightly-candidates.sh OUT_DIR [--manual-stamp STAMP]}
MANUAL_STAMP=""
if [ $# -gt 1 ]; then
  [ "$2" = --manual-stamp ] && [[ "${3:-}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] ||
    { echo "usage: nightly-candidates.sh OUT_DIR [--manual-stamp STAMP]" >&2; exit 64; }
  MANUAL_STAMP=$3
fi
BACKUP=$HOME/nil/vps-ops/vps-backup
IDENTITY=$BACKUP/keys/wallgame/age-identity.txt
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
DAY=$(date -u +%F)
# A by-hand run never writes the name the timer's run looks for, so it can
# never make that run stop with "a report exists".
REPORT=$OUT_DIR/$DAY.json
[ -z "$MANUAL_STAMP" ] || REPORT=$OUT_DIR/$DAY.manual-$MANUAL_STAMP.json
RUN=$(date -u +%Y%m%dT%H%M%SZ)-$$
SOURCE=wgvideo-daily-$RUN
VOLUME=$SOURCE-pgdata
SCRATCH=""
ERRORS=""

say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
skip() {
  say "SKIP $*"
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >"$OUT_DIR/$DAY.skip.part"
  mv "$OUT_DIR/$DAY.skip.part" "$OUT_DIR/$DAY.skip"
  exit 0
}

mkdir -p "$OUT_DIR"
# One run at a time: the leftover sweep below would remove the database of a
# run that is still restoring. The lock is in OUT_DIR, never in the backup store.
exec 9>"$OUT_DIR/.lock"
flock -n 9 || { say "another run is going; this one stops"; exit 0; }
[ ! -e "$REPORT" ] || { say "$REPORT exists; nothing to do"; exit 0; }

# COMMITTED CODE ONLY (Wall Game PM, 2026-10-26). This runs from the shared
# checkout, which other workers edit. Every file the pick runs must equal HEAD,
# or the day is skipped: a missed day is better than a pick by half-made code.
PICK_PATH=(scripts/game-video/pick-daily-candidates.ts scripts/game-video/daily-candidates.ts
  scripts/game-video/race-replay.ts
  scripts/game-video/daily shared server/db/past-game-player-kind.ts
  official-custom-bot-client/src official-custom-bot-client/transformer.prod.config.json
  package.json bun.lock)
# --no-optional-locks: never rewrite the shared checkout's index. The reader
# below drains its input, so a long list cannot end the script by SIGPIPE.
status=$(git --no-optional-locks -C "$REPO" status --porcelain --untracked-files=all -- "${PICK_PATH[@]}") ||
  status="?? (git status failed)"
dirty=$(printf '%s\n' "$status" | cut -c4- | sed -n 1,5p | tr '\n' ' ' | sed 's/ *$//')
if [ -n "$dirty" ]; then
  printf '%s the pick code has uncommitted changes: %s\n' "$(date -u +%FT%TZ)" "$dirty" >"$OUT_DIR/$DAY.skip"
  say "SKIP the pick code has uncommitted changes: $dirty"
  exit 0
fi
say "code: HEAD $(git -C "$REPO" rev-parse --short=12 HEAD), pick path clean"
rm -f "$OUT_DIR/$DAY.skip"

cleanup() {
  local code=$?
  # A run that stopped early still leaves the crew lead a reason.
  if [ ! -e "$REPORT" ] && [ ! -e "$OUT_DIR/$DAY.skip" ]; then
    printf '%s the run failed (exit %s); see journalctl --user -u wallgame-daily-candidates\n' \
      "$(date -u +%FT%TZ)" "$code" >"$OUT_DIR/$DAY.skip"
  fi
  rm -f "$REPORT.part"
  if [ -n "$SCRATCH" ]; then
    rm -f "$ERRORS"
    rmdir "$SCRATCH" 2>/dev/null || true
  fi
  docker rm -f "$SOURCE" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  if docker ps -aq --filter "name=^/$SOURCE$" | grep -q . ||
    docker volume inspect "$VOLUME" >/dev/null 2>&1; then
    say "FAIL cleanup: $SOURCE or $VOLUME is still there"
  else
    say "no $SOURCE or $VOLUME is left"
  fi
}

# --- the source ----------------------------------------------------------

# A run killed by SIGKILL or a crash skips its trap and leaves a container and a
# volume that hold a restored database. These names belong to this script only,
# and the lock above means no other run is live, so remove any that are left.
# This runs first, so a leftover does not wait through days that skip.
sweep_leftovers() {
  local left
  for left in $(docker ps -aq --filter 'name=^/wgvideo-daily-'); do
    docker rm -f "$left" >/dev/null && say "removed a container an earlier run left: $left"
  done
  for left in $(docker volume ls -q --filter 'name=^wgvideo-daily-.*-pgdata$'); do
    docker volume rm "$left" >/dev/null && say "removed a volume an earlier run left: $left"
  done
}

restore_source() {
  local fresh stamp dir image owners first o
  if ! fresh=$(python3 -I "$BACKUP/vpsbackup.py" fresh wallgame 2>&1); then
    skip "the backup is not fresh: $(printf '%s' "$fresh" | head -n 2 | tr '\n' ' ' | cut -c1-200)"
  fi
  stamp=$(printf '%s\n' "$fresh" | sed -n 's/^FRESH OK product=wallgame newest=\([0-9]\{8\}T[0-9]\{6\}Z\) .*/\1/p')
  [ -n "$stamp" ] || skip "fresh passed but named no stamp"
  # fresh allows a copy up to 26 h old, so at 11:30 UTC yesterday's still
  # passes when today's backup is late or failed. A report from it would offer
  # yesterday's games again.
  if [ -n "$MANUAL_STAMP" ]; then
    [ "$MANUAL_STAMP" = "$stamp" ] || skip "--manual-stamp $MANUAL_STAMP is not the newest verified stamp ($stamp)"
    say "MANUAL OVERRIDE: day check skipped for stamp $stamp"
  else
    [ "${stamp:0:8}" = "$(date -u +%Y%m%d)" ] || skip "today's backup is not in yet (newest is $stamp)"
  fi
  STAMP=$stamp
  dir=$BACKUP/store/wallgame/$stamp
  UNTIL=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["created_utc"])' "$dir/manifest.json")
  image=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["pg_image"])' "$BACKUP/conf/wallgame.json")
  say "source: stamp $stamp, snapshot $UNTIL"


  # pg_restore's stderr can quote one row value. It lives in this folder,
  # which the trap empties and removes.
  SCRATCH=$(mktemp -d)
  ERRORS=$SCRATCH/pg_restore.err
  docker run -d --name "$SOURCE" --network none --memory 1g --cpus 1 --pids-limit 256 \
    -e POSTGRES_HOST_AUTH_METHOD=trust -v "$VOLUME:/var/lib/postgresql/data" "$image" >/dev/null
  say "$(docker inspect -f 'container {{.Name}} network={{.HostConfig.NetworkMode}} ports={{json .HostConfig.PortBindings}} mounts={{len .Mounts}}' "$SOURCE")"
  for _ in $(seq 1 60); do
    docker exec "$SOURCE" pg_isready -h 127.0.0.1 -U postgres -q 2>/dev/null && break
    sleep 1
  done

  # The owner roles come from the archive's table of contents (pg_restore -l
  # reads only that; cat drains the rest so age does not die of SIGPIPE).
  owners=$(age -d -i "$IDENTITY" "$dir/dump.age" | { docker exec -i "$SOURCE" pg_restore -l; cat >/dev/null; } |
    awk '$1 !~ /^;/ && NF >= 6 && $NF !~ /^pg_/ {print $NF}' | sort -u)
  first=""
  for o in $owners; do
    [[ "$o" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { say "FAIL an owner name in the archive is not a role name"; exit 1; }
    [ "$o" = postgres ] || docker exec "$SOURCE" psql -X -U postgres -v ON_ERROR_STOP=1 -q -c "CREATE ROLE $o NOLOGIN"
    [ -n "$first" ] || first=$o
  done
  docker exec "$SOURCE" psql -X -U postgres -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE wallgame OWNER ${first:-postgres}"

  local status
  set +e
  age -d -i "$IDENTITY" "$dir/dump.age" |
    docker exec -i "$SOURCE" pg_restore -U postgres -d wallgame --single-transaction --exit-on-error --no-password 2>"$ERRORS"
  status=("${PIPESTATUS[@]}")
  set -e
  if [ "${status[0]}" != 0 ] || [ "${status[1]}" != 0 ]; then
    say "FAIL restore (age ${status[0]}, pg_restore ${status[1]}): $(head -n 1 "$ERRORS" | sed 's/"[^"]*"/"..."/g' | cut -c1-160)"
    exit 1
  fi
  say "restored"
}

# --- the pick --------------------------------------------------------------

pick() {
  local out=$REPORT.part
  (cd "$REPO" && "$HOME/.bun/bin/bun" scripts/game-video/pick-daily-candidates.ts \
    --container "$SOURCE" --until "$UNTIL" --days 1 --top 5 --out "$out")
  # Name the snapshot in the report, so the crew lead can see which day's
  # backup the games came from.
  python3 -I -c 'import json,sys
r = json.load(open(sys.argv[1]))
r["backup"] = {"stamp": sys.argv[2], "snapshotUtc": sys.argv[3]}
json.dump(r, open(sys.argv[1], "w"), indent=1)' "$out" "$STAMP" "$UNTIL"
  mv "$out" "$REPORT"
  say "report: $REPORT"
}

trap cleanup EXIT
sweep_leftovers
restore_source
pick
