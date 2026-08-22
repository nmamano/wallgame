#!/usr/bin/env bash
set -euo pipefail
ROOT=/home/nilo/nil/wallgame/deep-wallwars
EXP=tf_policy_elo_random_start_continuation_g117_g126_2026-08-22
TRAIN=$ROOT/training-runs/phase7-feasibility-34e5f567-random-start-g117-g126
RR=$TRAIN/policy-elo/$EXP
PLAN=$RR/plan.json
RUN_ROOT=$RR/run
ARCHIVE_ROOT=$ROOT/elo_db/policy_archive
ENGINE=$ROOT/build-tests/deep_ww_bgs_engine
FINAL=$RR/runner.final
EXPECTED_ENGINE=f80b9ed1ac90d2a1a38cac2406939bfe840c8ddffe6035e75cca59f6a7664d2b
finish() {
  original=$?
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  engine_after=$(sha256sum "$ENGINE" 2>/dev/null | awk '{print $1}' || true)
  status=$original
  if [[ "$engine_after" != "$EXPECTED_ENGINE" ]]; then status=97; fi
  printf 'status=%s\noriginalStatus=%s\nmeasuredAtUtc=%s\nengineAfter=%s\n' "$status" "$original" "$now" "$engine_after" > "$FINAL"
  exit "$status"
}
trap finish EXIT
test ! -e "$FINAL"
test "$(sha256sum "$ENGINE" | awk '{print $1}')" = "$EXPECTED_ENGINE"
python3 - "$ROOT/elo_db/experiments.json" "$EXP" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); assert sys.argv[2] in d
assert d[sys.argv[2]]["plan"]["pairings"] == 300
assert d[sys.argv[2]]["plan"]["requestedAcceptedGames"] == 2100
PY
python3 "$ROOT/scripts/policy_elo_batch.py" \
  --plan "$PLAN" \
  --run-root "$RUN_ROOT" \
  --archive-root "$ARCHIVE_ROOT" \
  --bun /home/nilo/.bun/bin/bun \
  --concurrency 8
