#!/usr/bin/env bash
# Slice-1a always-run gate for the vendored classic minimax engine.
#
# Builds the engine and runs its complete self-test suite. The removed-draw
# correction also fixed the old NegamaxOrderedMovesTest expectation, so every
# one of the 14 tests must now pass.
set -uo pipefail
cd "$(dirname "$0")/.."   # -> minimax-engine/

EXPECTED_SUMMARY="PASSED TESTS: 14/14"

echo "== configure (cmake --preset release) =="
cmake --preset release            || { echo "GATE FAIL: cmake configure failed"; exit 1; }

echo "== build =="
( cd build_release && make )      || { echo "GATE FAIL: build failed"; exit 1; }

echo "== interactive draw wording =="
if grep -qF "Players drew by the one-move rule." include/interactive_game.h; then
  echo "GATE FAIL: obsolete one-move draw wording remains"
  exit 1
fi
if ! grep -qF 'std::cout << "Players drew."' include/interactive_game.h; then
  echo "GATE FAIL: generic draw wording is missing"
  exit 1
fi

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

if [ "${#FAILED[@]}" -eq 0 ]; then
  echo "GATE OK: build and all 14 self-tests are green."
  exit 0
fi

echo "GATE FAIL: expected no failing tests, got {${FAILED[*]}}."
echo "Investigate before proceeding - do not update EXPECTED_SUMMARY to silence a regression."
exit 1
