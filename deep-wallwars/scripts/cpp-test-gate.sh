#!/usr/bin/env bash
# C++ unit-test gate. Runs the WHOLE Catch2 suite from build-tests/.
#
# It did not always run the whole suite. From 2026-07-11 until 2026-07-30 this
# script excluded six cases that were failing at baseline commit 4c94103 and
# were parked rather than diagnosed:
#
#   "~parse_move_notation*"                          (5 cases, bgs_session.cpp)
#   "~validate_request - rejects freestyle variant"  (engine_adapter.cpp)
#
# Task e5fec60c closed all six, so the exclusions are gone. Five were stale
# tests: the fixture's cat sits at a1, not the a8 their comments claimed, so
# they were feeding the parser a cell six rows away. One was stale in the other
# direction - it asserted freestyle is rejected, which stopped being true when
# freestyle support shipped. The last was a real parser defect: std::stoi stops
# at the first non-digit without reporting it, so "Ca2Mh1" parsed as "Ca2" and
# silently dropped an action. Fixed in src/engine_adapter.cpp.
#
# Note what the wildcard was costing. "~parse_move_notation*" hid the entire
# parser group, so a NEW break in move parsing would also have gone unreported
# and this gate would still have said green. An exclusion list is a claim about
# coverage that nothing else checks.
#
# ("TensorRT 5x5 model" is tagged [!shouldfail] upstream and handles itself; it
# is the "1 failed as expected" in the summary, not a defect.)
#
# Expected: 103 cases, 102 passed, 0 failed, 1 failed as expected.
# Compare failures BY NAME, never by count - "still N failing" is also true when
# a stale test gets fixed and a real regression takes its slot.
#
# Do NOT add exclusions to make a slice pass. That is gate-weakening and is
# prohibited; fix the test or fix the code.
set -euo pipefail
cd "$(dirname "$0")/../build-tests"
exec ./unit_tests "$@"
