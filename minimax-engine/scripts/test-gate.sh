#!/usr/bin/env bash
# Slice-1a always-run gate for the vendored classic minimax engine.
#
# Builds the engine and runs its self-test suite, then asserts that the ONLY
# failing test is the documented baseline failure (NegamaxOrderedMovesTest, 11/12).
# Exits non-zero if the build breaks OR if the set/count of failing tests changes
# — so a NEW regression cannot hide behind the known-failing move-ordering test.
#
# See BUILD.md for the rationale on the quarantined test.
set -uo pipefail
cd "$(dirname "$0")/.."   # -> minimax-engine/

EXPECTED_FAIL="NegamaxOrderedMovesTest"
EXPECTED_SUMMARY="PASSED TESTS: 11/12"

echo "== configure (cmake --preset release) =="
cmake --preset release            || { echo "GATE FAIL: cmake configure failed"; exit 1; }

echo "== build =="
( cd build_release && make )      || { echo "GATE FAIL: build failed"; exit 1; }

echo "== self-tests (full suite, shown verbatim) =="
TEST_OUT="$(./build_release/wallwars_ai test </dev/null 2>&1)"
echo "$TEST_OUT"

# Failing test names: lines like "SomeTest FAILED"
mapfile -t FAILED < <(printf '%s\n' "$TEST_OUT" | grep -oE '[A-Za-z0-9_]+ FAILED' | sed 's/ FAILED//' | sort -u)

echo "== gate check =="
echo "failing tests: ${FAILED[*]:-<none>}"

if ! printf '%s\n' "$TEST_OUT" | grep -qF "$EXPECTED_SUMMARY"; then
  echo "GATE FAIL: expected summary '$EXPECTED_SUMMARY' not found (test count changed?)"
  exit 1
fi

if [ "${#FAILED[@]}" -eq 1 ] && [ "${FAILED[0]}" = "$EXPECTED_FAIL" ]; then
  echo "GATE OK: build green; only the known baseline failure ($EXPECTED_FAIL) present."
  exit 0
fi

echo "GATE FAIL: failing-test set changed. Expected exactly {$EXPECTED_FAIL}, got {${FAILED[*]:-<none>}}."
echo "Investigate before proceeding — do NOT update EXPECTED_* to silence a new regression."
exit 1
