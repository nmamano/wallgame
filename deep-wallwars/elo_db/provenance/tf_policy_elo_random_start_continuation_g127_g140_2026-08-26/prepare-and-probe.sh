#!/usr/bin/env bash
set -euo pipefail
ROOT=/home/nilo/nil/wallgame/deep-wallwars
EXP=tf_policy_elo_random_start_continuation_g127_g140_2026-08-26
TRAIN=$ROOT/training-runs/phase7-feasibility-34e5f567-random-start-g117-g126
RR=$TRAIN/policy-elo/$EXP
BASE=$ROOT/models_12x10_tf_curriculum
EXT=$TRAIN/models
ENGINE=$ROOT/build-tests/deep_ww_bgs_engine
FIXTURE=$TRAIN/diagnosis-classic-no-legal-2026-08-20/repro.jsonl
OUT=$RR/loadability.jsonl
FINAL=$RR/loadability.final
EXPECTED_ENGINE=f80b9ed1ac90d2a1a38cac2406939bfe840c8ddffe6035e75cca59f6a7664d2b
finish() {
  status=$?
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  engine_after=$(sha256sum "$ENGINE" 2>/dev/null | awk '{print $1}' || true)
  printf 'status=%s\nmeasuredAtUtc=%s\nengineAfter=%s\n' "$status" "$now" "$engine_after" > "$FINAL"
  exit "$status"
}
trap finish EXIT
engine_sha=$(sha256sum "$ENGINE" | awk '{print $1}')
test "$engine_sha" = "$EXPECTED_ENGINE"
test -s "$FIXTURE"
test -s "$OUT"
for generation in $(seq 126 140); do
  if (( generation <= 92 )); then
    model=$BASE/model_${generation}.trt
    selected=base
  else
    model=$EXT/model_${generation}.trt
    selected=extension
  fi
  test -s "$model"
  model_sha=$(sha256sum "$model" | awk '{print $1}')
  set +e
  response=$(timeout 30 bash -o pipefail -c "python3 -c 'import json; r=json.loads(open(\"$FIXTURE\").read().splitlines()[11]); print(json.dumps({\"type\":\"start_game_session\",\"bgsId\":\"load-probe\",\"botId\":\"load-probe\",\"config\":{\"variant\":\"classic\",\"boardWidth\":12,\"boardHeight\":10,\"initialState\":r[\"initialState\"]}}))' | '$ENGINE' --model '$model' --samples 1 --seed 616 --root_noise_factor 0 2>/dev/null" 2>&1)
  code=$?
  set -e
  if [[ "$response" == *'"success":true'* ]]; then
    loadability=supported
    contract=16-plane-universal
  elif [[ "$response" == *'Model input must use the 8-plane legacy or 16-plane universal contract'* ]]; then
    loadability=neither-supported-contract
    contract=neither-supported-contract
  else
    loadability=probe-error
    contract=probe-error
  fi
  python3 -c 'import json,sys; print(json.dumps({"generation":int(sys.argv[1]),"artifactSet":sys.argv[2],"modelSha256":sys.argv[3],"engineSha256":sys.argv[4],"probeExit":int(sys.argv[5]),"loadability":sys.argv[6],"inputContract":sys.argv[7],"response":sys.argv[8][-500:],"measuredAtUtc":sys.argv[9]},separators=(",",":")))' "$generation" "$selected" "$model_sha" "$engine_sha" "$code" "$loadability" "$contract" "$response" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT"
done
python3 - "$OUT" <<'PY'
import json,sys
rows=[json.loads(x) for x in open(sys.argv[1])]
assert [r['generation'] for r in rows] == list(range(1,141))
assert all(r['loadability'] != 'probe-error' for r in rows)
assert [r['generation'] for r in rows if r['loadability']=='supported'] == list(range(93,141))
assert all(r['inputContract']=='16-plane-universal' for r in rows[92:])
print('rows=140 supported=48 generations=93..140')
PY
