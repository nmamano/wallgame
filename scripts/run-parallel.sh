#!/bin/sh
# Runs named commands at the same time, each with its own log. Prints one
# line per command when it ends, the whole log of each command that failed,
# and exits 1 when any failed. It waits for all of them, so one run shows
# every failure. POSIX sh: the pre-push hook and `bun run typecheck` use it.
#
#   sh scripts/run-parallel.sh <name> <command> [<name> <command> ...]
set -u

# Check the pairs before anything starts, so a misuse leaves nothing running.
if [ $# -eq 0 ] || [ $(($# % 2)) -ne 0 ]; then
  echo "usage: sh scripts/run-parallel.sh <name> <command> [<name> <command> ...]" >&2
  exit 2
fi

logs=$(mktemp -d "${TMPDIR:-/tmp}/run-parallel.XXXXXX")
trap 'rm -rf "$logs"' EXIT

pids=""
n=0
while [ $# -ge 2 ]; do
  n=$((n + 1))
  printf '%s\n' "$1" > "$logs/$n.name"
  (
    start=$(date +%s)
    if sh -c "$2" > "$logs/$n.log" 2>&1; then code=0; else code=$?; fi
    echo $(($(date +%s) - start)) > "$logs/$n.seconds"
    exit "$code"
  ) &
  pids="$pids $!"
  shift 2
done

failed=""
i=0
for pid in $pids; do
  i=$((i + 1))
  name=$(cat "$logs/$i.name")
  if wait "$pid"; then
    echo "✅ $name ($(cat "$logs/$i.seconds") s)"
  else
    code=$?
    echo "❌ $name failed with exit $code ($(cat "$logs/$i.seconds" 2>/dev/null || echo "?") s). Its log:"
    sed 's/^/    /' "$logs/$i.log"
    failed="$failed, $name"
  fi
done

if [ -n "$failed" ]; then
  echo "❌ Failed: ${failed#, }"
  exit 1
fi
