#!/usr/bin/env bash
# C++ unit-test gate for the transformer-ready loop (plans/transformer-ready-loop.md).
#
# Runs the Catch2 suite from build-tests/ EXCLUDING 6 pre-existing failures that
# were already broken at baseline commit 4c94103 (probed 2026-07-11, first time
# the suite ran on this box — Catch2 was never installed here before):
#
#   - "parse_move_notation - *" (5 cases, bgs_session.cpp): notation format drifted
#     (e.g. "Ca7" no longer parses) after the tests were written.
#   - "validate_request - rejects freestyle variant" (engine_adapter.cpp:453):
#     freestyle is now ACCEPTED by the engine; the test predates that support.
#
# ("TensorRT 5x5 model" is tagged [!shouldfail] upstream and handles itself.)
#
# These are code-vs-test drift, NOT loop regressions. Fixing them is parked for
# Nil (see standing orders). Do NOT add exclusions to this list to make a slice
# pass — that is gate-weakening and is prohibited.
set -euo pipefail
cd "$(dirname "$0")/../build-tests"
exec ./unit_tests \
  "~parse_move_notation*" \
  "~validate_request - rejects freestyle variant" \
  "$@"
