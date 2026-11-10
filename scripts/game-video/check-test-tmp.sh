#!/usr/bin/env bash
# Runs the game-video tests with TMPDIR set to a new empty dir, then lists
# what they left there (task cb84d862: the tests had left 189,061 entries
# in /tmp on auntie-2). Exit 0 when nothing is left and the tests pass;
# exit 1 with the list otherwise.
#
# A test makes its temp dirs with test-tmp.ts (one root per file, removed in
# afterAll), and gives TMPDIR to a child process it starts with its own env.
# A child that inherits the env writes to this run's TMPDIR, so a leak there
# shows here too.
#
#   bash scripts/game-video/check-test-tmp.sh [bun test args, default: scripts/game-video]
set -uo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
run_tmp=$(mktemp -d "${TMPDIR:-/tmp}/game-video-tmp-check-XXXXXX")
trap 'rm -rf "$run_tmp"' EXIT
[ $# -eq 0 ] && set -- scripts/game-video
TMPDIR="$run_tmp" bun test "$@"
tests=$?
# Fixed names that the tools reuse, one entry each that never grows: the
# crew tools' folder (daily/tools.mjs), ship's kit log (daily/ship.mjs) and
# the 4090 ssh socket folder (daily/render-4090.mjs).
fixed='^(daily-tools|wallgame-kitsync\.log|wg-video-ssh-[0-9a-z]+)$'
left=$(find "$run_tmp" -mindepth 1 -maxdepth 1 -printf '%f\n' | grep -Ev "$fixed" | sort)
if [ -n "$left" ]; then
  echo "check-test-tmp: the tests left $(printf '%s\n' "$left" | wc -l) entries in TMPDIR:"
  printf '  %s\n' $left | head -50
  exit 1
fi
if [ "$tests" -ne 0 ]; then
  echo "check-test-tmp: TMPDIR is clean, but the tests failed (exit $tests)"
  exit 1
fi
echo "check-test-tmp: the tests passed and left nothing in TMPDIR"
