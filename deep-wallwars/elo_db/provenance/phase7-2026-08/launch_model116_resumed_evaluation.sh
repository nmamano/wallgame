#!/usr/bin/env bash
set -euo pipefail

cd /home/nilo/nil/wallgame-phase7-feasibility/deep-wallwars

run_root=build-tests/phase7-feasibility-34e5f567
eval_dir="$run_root/evaluation-model116-resumed-2026-08-20"
engine=build-phase7/deep_ww_bgs_engine
model116="$run_root/models/model_116.trt"
model115="$run_root/models/model_115.trt"
model93="$run_root/models/model_93.trt"
seed=820116
animal_exp=tf_model116_vs115_animal_1000_2026-08-20
standard_exp=tf_model116_vs93_standard_1000_2026-08-20c

mkdir -p "$eval_dir"/{games,logs,results,time,metrics}
mkdir -p "elo_db/sources/$animal_exp" "elo_db/sources/$standard_exp"
test -x "$engine"
test -f "$model116"
test -f "$model115"
test -f "$model93"
sha256sum "$engine" "$model116" "$model115" "$model93" \
  > "$eval_dir/metrics/inputs.sha256"
git rev-parse HEAD > "$eval_dir/metrics/source-head.txt"
git status --short > "$eval_dir/metrics/source-status.txt"
date -u +%Y-%m-%dT%H:%M:%SZ > "$eval_dir/metrics/start-utc.txt"
/usr/lib/wsl/lib/nvidia-smi \
  --query-gpu=timestamp,temperature.gpu,power.draw,power.limit,memory.used,memory.total,utilization.gpu \
  --format=csv > "$eval_dir/metrics/gpu-before.csv"

/usr/lib/wsl/lib/nvidia-smi dmon -s pucvmet -d 5 -o DT \
  > "$eval_dir/metrics/gpu-dmon.log" &
gpu_pid=$!
vmstat -t 5 > "$eval_dir/metrics/vmstat.log" &
vmstat_pid=$!
cleanup() {
  kill "$gpu_pid" "$vmstat_pid" 2>/dev/null || true
}
trap cleanup EXIT

run_condition() {
  local experiment=$1
  local baseline=$2
  local variant=$3
  local size=$4
  local games=$5
  local key=$6
  local width=${size%x*}
  local height=${size#*x}
  local archive_file="elo_db/sources/$experiment/${key}.jsonl"
  test ! -e "$archive_file"
  : > "$archive_file"

  /usr/bin/time -v -o "$eval_dir/time/${key}.txt" \
    "$HOME/.bun/bin/bun" scripts/benchmark_head_to_head.ts \
      --engine "$engine" \
      --ours "$model116" --our-samples 1000 \
      --opp "$baseline" --opp-samples 1000 \
      --our-noise 0.25 --opp-noise 0.25 \
      --variant "$variant" --setup random-start \
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

# First answer the immediate serving decision: model 116 versus Ruthless model 115.
run_condition "$animal_exp" "$model115" animal-cycle 7x7 100 animal-cycle_random-start_7x7

# Add 260 distinct Standard games. Combined with the prior 40, this gives 300.
run_condition "$standard_exp" "$model93" standard 8x8 130 standard_random-start_8x8
run_condition "$standard_exp" "$model93" standard 12x10 130 standard_random-start_12x10

date -u +%Y-%m-%dT%H:%M:%SZ > "$eval_dir/metrics/stop-utc.txt"
/usr/lib/wsl/lib/nvidia-smi \
  --query-gpu=timestamp,temperature.gpu,power.draw,power.limit,memory.used,memory.total,utilization.gpu \
  --format=csv > "$eval_dir/metrics/gpu-after.csv"
sha256sum "$eval_dir"/results/*.json "$eval_dir"/games/*.json \
  "elo_db/sources/$animal_exp"/*.jsonl \
  "elo_db/sources/$standard_exp"/*.jsonl \
  > "$eval_dir/metrics/artifacts.sha256"
