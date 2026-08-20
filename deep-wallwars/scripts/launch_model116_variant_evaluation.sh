#!/usr/bin/env bash
set -euo pipefail

cd /home/nilo/nil/wallgame-phase7-feasibility/deep-wallwars

run_root=build-tests/phase7-feasibility-34e5f567
eval_dir="$run_root/evaluation-model116-vs93-1000"
experiment=tf_model116_vs93_1000_2026-08-19b
archive_root="elo_db/sources/$experiment"
engine=build-phase7/deep_ww_bgs_engine
candidate="$run_root/models/model_116.trt"
baseline="$run_root/models/model_93.trt"
seed=116093

mkdir -p "$eval_dir"/{games,logs,results,time,metrics} "$archive_root"
test -x "$engine"
test -f "$candidate"
test -f "$baseline"

sha256sum "$engine" "$candidate" "$baseline" \
  > "$eval_dir/metrics/inputs.sha256"
git rev-parse HEAD > "$eval_dir/metrics/source-head.txt"
git status --short > "$eval_dir/metrics/source-status.txt"
date -u +%Y-%m-%dT%H:%M:%SZ > "$eval_dir/metrics/start-utc.txt"
df -h /mnt/c > "$eval_dir/metrics/disk-before.txt"
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
  local variant=$1
  local setup=$2
  local size=$3
  local games=$4
  local width=${size%x*}
  local height=${size#*x}
  local key="${variant}_${setup}_${size}"
  local archive_file="$archive_root/${key}.jsonl"
  test ! -e "$archive_file"
  : > "$archive_file"

  /usr/bin/time -v -o "$eval_dir/time/${key}.txt" \
    "$HOME/.bun/bin/bun" scripts/benchmark_head_to_head.ts \
      --engine "$engine" \
      --ours "$candidate" --our-samples 1000 \
      --opp "$baseline" --opp-samples 1000 \
      --our-noise 0.25 --opp-noise 0.25 \
      --variant "$variant" --setup "$setup" \
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

# Fixed starts are deterministic regression checks. One seat pair is enough.
# Random Start conditions carry the strength evidence.
run_condition standard fixed 8x8 2
run_condition standard random-start 8x8 20
run_condition standard fixed 12x10 2
run_condition standard random-start 12x10 20
run_condition classic fixed 8x8 2
run_condition classic random-start 8x8 20
run_condition classic fixed 12x10 2
run_condition classic random-start 12x10 20
run_condition animal-cycle fixed 7x7 2
run_condition animal-cycle random-start 7x7 20

df -h /mnt/c > "$eval_dir/metrics/disk-after.txt"
/usr/lib/wsl/lib/nvidia-smi \
  --query-gpu=timestamp,temperature.gpu,power.draw,power.limit,memory.used,memory.total,utilization.gpu \
  --format=csv > "$eval_dir/metrics/gpu-after.csv"
date -u +%Y-%m-%dT%H:%M:%SZ > "$eval_dir/metrics/stop-utc.txt"
sha256sum "$eval_dir"/results/*.json "$eval_dir"/games/*.json \
  > "$eval_dir/metrics/artifacts.sha256"
sha256sum "$archive_root"/*.jsonl > "$eval_dir/metrics/archive-sources.sha256"
