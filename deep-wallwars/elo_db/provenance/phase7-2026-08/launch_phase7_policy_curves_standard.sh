#!/usr/bin/env bash
set -euo pipefail

cd /home/nilo/nil/wallgame-phase7-feasibility/deep-wallwars

run_root=build-tests/phase7-feasibility-34e5f567
eval_dir="$run_root/policy-elo-curves-2026-08-20"
experiment=tf_phase7_policy_standard_2026-08-20
archive_root="elo_db/sources/$experiment"
engine=build-phase7/deep_ww_bgs_engine
games=40

mkdir -p "$eval_dir"/{games,logs,results,time,metrics} "$archive_root"
test -x "$engine"
for generation in $(seq 93 116); do
  test -f "$run_root/models/model_${generation}.trt"
done

sha256sum "$engine" "$run_root"/models/model_{93..116}.trt \
  > "$eval_dir/metrics/inputs.sha256"
git rev-parse HEAD > "$eval_dir/metrics/source-head.txt"
git status --short > "$eval_dir/metrics/source-status.txt"
date -u +%Y-%m-%dT%H:%M:%SZ > "$eval_dir/metrics/start-utc.txt"

/usr/lib/wsl/lib/nvidia-smi dmon -s pucvmet -d 5 -o DT \
  > "$eval_dir/metrics/gpu-dmon.log" &
gpu_pid=$!
vmstat -t 5 > "$eval_dir/metrics/vmstat.log" &
vmstat_pid=$!
cleanup() {
  kill "$gpu_pid" "$vmstat_pid" 2>/dev/null || true
}
trap cleanup EXIT

run_pair() {
  local generation=$1
  local opponent=$2
  local size=$3
  local width=${size%x*}
  local height=${size#*x}
  local seed=$((820000 + generation * 100 + opponent))
  local key="standard_${size}_g${generation}_vs_g${opponent}"
  local archive_file="$archive_root/${key}.jsonl"
  test ! -e "$archive_file"
  : > "$archive_file"

  /usr/bin/time -v -o "$eval_dir/time/${key}.txt" \
    "$HOME/.bun/bin/bun" scripts/benchmark_head_to_head.ts \
      --engine "$engine" \
      --ours "$run_root/models/model_${generation}.trt" --our-samples 1 \
      --opp "$run_root/models/model_${opponent}.trt" --opp-samples 1 \
      --our-noise 0 --opp-noise 0 \
      --variant standard --setup random-start \
      --width "$width" --height "$height" \
      --games "$games" --seed "$seed" \
      --archive "$archive_file" --experiment "$experiment" \
      --dump "$eval_dir/games/${key}.json" \
      > "$eval_dir/logs/${key}.stdout.log" \
      2> "$eval_dir/logs/${key}.log"

  tail -n 1 "$eval_dir/logs/${key}.stdout.log" | \
    python3 -c 'import json,sys; json.dump(json.load(sys.stdin),sys.stdout,separators=(",",":")); print()' \
    > "$eval_dir/results/${key}.json"
}

for generation in $(seq 94 116); do
  opponents=()
  for delta in 1 3 6; do
    opponent=$((generation - delta))
    if (( opponent < 93 )); then opponent=93; fi
    seen=false
    for existing in "${opponents[@]:-}"; do
      if [[ "$existing" == "$opponent" ]]; then seen=true; fi
    done
    if [[ "$seen" == false ]]; then opponents+=("$opponent"); fi
  done
  for opponent in "${opponents[@]}"; do
    run_pair "$generation" "$opponent" 8x8
    run_pair "$generation" "$opponent" 12x10
  done
done

date -u +%Y-%m-%dT%H:%M:%SZ > "$eval_dir/metrics/stop-utc.txt"
sha256sum "$eval_dir"/results/*.json "$archive_root"/*.jsonl \
  > "$eval_dir/metrics/artifacts.sha256"
