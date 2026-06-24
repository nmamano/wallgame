#!/usr/bin/env bash
# Slice-1b protocol smoke gate for minimax_bgs_engine.
#
# Builds the wrapper + translation test, runs the translation round-trips, then
# drives the engine with a canned V3 message stream and asserts, against the
# WIRE (stdout JSON, not any UI):
#   - stdout is pure JSON-lines (search logs must be on stderr)
#   - happy path: start/evaluate/apply succeed; bestMove set; eval finite in [-1,1]
#   - error paths: duplicate bgsId, unknown bgsId, malformed move -> success:false
#   - session isolation: applying to one bgsId does not advance another
#
# No server, no DB, no network. Exits non-zero on any failed assertion.
set -uo pipefail
cd "$(dirname "$0")/.."  # -> minimax-engine/

THINK="${MINIMAX_THINK_MILLIS:-50}"
ENGINE="build_release/minimax_bgs_engine"
TT="build_release/minimax_translation_test"

echo "== build wrapper + translation test =="
cmake --preset release >/dev/null 2>&1 || { echo "GATE FAIL: cmake configure"; exit 1; }
( cd build_release && make minimax_bgs_engine minimax_translation_test ) >/tmp/mm-smoke-build.log 2>&1 \
  || { echo "GATE FAIL: build"; tail -20 /tmp/mm-smoke-build.log; exit 1; }

echo "== translation round-trip test =="
"./$TT" || { echo "GATE FAIL: translation_test"; exit 1; }
echo "  translation_test OK"

START1='{"type":"start_game_session","bgsId":"s1","botId":"mm","config":{"variant":"classic","boardWidth":8,"boardHeight":8,"initialState":{"pawns":{"p1":{"cat":[0,0],"home":[7,7]},"p2":{"cat":[0,7],"home":[7,0]}},"walls":[]}}}'
START2=${START1/\"s1\"/\"s2\"}

echo "== drive engine with canned stream =="
OUT=$(printf '%s\n' \
  "$START1" \
  "$START2" \
  "$START1" \
  '{"type":"evaluate_position","bgsId":"s1","expectedPly":0}' \
  '{"type":"apply_move","bgsId":"s1","expectedPly":0,"move":"Cc8"}' \
  '{"type":"evaluate_position","bgsId":"s2","expectedPly":0}' \
  '{"type":"evaluate_position","bgsId":"s1","expectedPly":0}' \
  '{"type":"apply_move","bgsId":"s1","expectedPly":1,"move":"ZZbad"}' \
  '{"type":"evaluate_position","bgsId":"ghost","expectedPly":0}' \
  '{"type":"end_game_session","bgsId":"s1"}' \
  '{"type":"end_game_session","bgsId":"s2"}' \
  | "./$ENGINE" --think-millis "$THINK" 2>/tmp/mm-smoke-err.txt)

mapfile -t L <<<"$OUT"

fail=0
assert() {  # assert <line-index-1based> <jq-filter> <description>
  local idx="$1" filt="$2" desc="$3" line="${L[$1-1]:-}"
  if ! echo "$line" | jq -e . >/dev/null 2>&1; then
    echo "FAIL [$desc]: line $idx is not valid JSON: '$line'"; fail=1; return
  fi
  if ! echo "$line" | jq -e "$filt" >/dev/null 2>&1; then
    echo "FAIL [$desc]: line $idx did not satisfy $filt -> $line"; fail=1
  fi
}

# Purity: every emitted line must be valid JSON.
n=0
while IFS= read -r l; do
  n=$((n+1))
  echo "$l" | jq -e . >/dev/null 2>&1 || { echo "FAIL: non-JSON stdout line $n: '$l'"; fail=1; }
done <<<"$OUT"
[ "$n" -eq 11 ] || { echo "FAIL: expected 11 response lines, got $n"; fail=1; }

assert 1  '.type=="game_session_started" and .success==true'  "start s1"
assert 2  '.type=="game_session_started" and .success==true'  "start s2"
assert 3  '.success==false'                                    "duplicate bgsId rejected"
assert 4  '.type=="evaluate_response" and .success==true and (.bestMove|length>0) and (.evaluation|type=="number") and .evaluation>=-1 and .evaluation<=1' "evaluate s1 ply0"
assert 5  '.type=="move_applied" and .success==true and .ply==1' "apply legal move on s1"
assert 6  '.type=="evaluate_response" and .success==true and .ply==0' "evaluate s2 still ply0 (no bleed)"
assert 7  '.success==false'                                    "evaluate s1 at stale ply0 rejected (s1 advanced independently)"
assert 8  '.success==false'                                    "malformed move rejected"
assert 9  '.success==false'                                    "unknown bgsId rejected"
assert 10 '.type=="game_session_ended" and .success==true'     "end s1"
assert 11 '.type=="game_session_ended" and .success==true'     "end s2"

# search logs must NOT be on stdout (they belong on stderr)
if grep -qiE 'Search depth|Best move' <<<"$OUT"; then
  echo "FAIL: search-progress text leaked to stdout"; fail=1
fi
grep -qiE 'Search depth|Best move' /tmp/mm-smoke-err.txt || echo "note: no search logs seen on stderr (think time may be tiny)"

if [ "$fail" -eq 0 ]; then
  echo "PROTOCOL-SMOKE OK"
  exit 0
fi
echo "PROTOCOL-SMOKE FAILED"
exit 1
