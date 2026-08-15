#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
run_dir=${1:?usage: launch_phase7_evaluation.sh RUN_DIR}
eval_dir="$run_dir/evaluation"
manifest=scripts/phase7-evaluation-manifest.json
mkdir -p "$eval_dir"/{games,logs,results,time,metrics}

test "$(sha256sum scripts/phase7-corrected-manifest.json | cut -d' ' -f1)" = \
  0675d45282e2bcb8bc573d749619cffbfe3e32888b56e77daf27e4ea220542a6
test "$(sha256sum "$manifest" | cut -d' ' -f1)" = \
  f582073542036ca90a5dcf301fc45c1e9344936d18dab9ce9cd20a43fc1ad695
for generation in 93 94 95 96; do
  test -f "$run_dir/models/model_${generation}.trt"
done

cp "$manifest" "$eval_dir/phase7-evaluation-manifest.json"
sha256sum "$manifest" "$eval_dir/phase7-evaluation-manifest.json" \
  > "$eval_dir/metrics/evaluation-manifest-sha256.txt"
git rev-parse HEAD > "$eval_dir/metrics/evaluation-source-head.txt"
date -u +%Y-%m-%dT%H:%M:%SZ > "$eval_dir/metrics/evaluation-start-utc.txt"
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

engine=build-phase7/deep_ww_bgs_engine
run_bun="$HOME/.bun/bin/bun"
baseline="$run_dir/models/model_93.trt"
seed=730171
games=20

run_condition() {
  local generation=$1
  local probe=$2
  local samples=$3
  local noise=$4
  local variant=$5
  local setup=$6
  local size=$7
  local width=${size%x*}
  local height=${size#*x}
  local key="g${generation}_${probe}_${variant}_${setup}_${size}"

  /usr/bin/time -v -o "$eval_dir/time/${key}.txt" \
    "$run_bun" scripts/benchmark_head_to_head.ts \
      --engine "$engine" \
      --ours "$run_dir/models/model_${generation}.trt" --our-samples "$samples" \
      --opp "$baseline" --opp-samples "$samples" \
      --our-noise "$noise" --opp-noise "$noise" \
      --variant "$variant" --setup "$setup" \
      --width "$width" --height "$height" \
      --games "$games" --seed "$seed" \
      --dump "$eval_dir/games/${key}.json" \
      > "$eval_dir/logs/${key}.stdout.log" \
      2> "$eval_dir/logs/${key}.log"
  tail -n 1 "$eval_dir/logs/${key}.stdout.log" | jq -e . \
    > "$eval_dir/results/${key}.json"
}

conditions=(
  "standard fixed 8x8"
  "standard random-start 8x8"
  "standard fixed 12x10"
  "standard random-start 12x10"
  "classic fixed 8x8"
  "classic random-start 8x8"
  "classic fixed 12x10"
  "classic random-start 12x10"
  "animal-cycle fixed 7x7"
  "animal-cycle random-start 7x7"
)

for generation in 94 95 96; do
  for condition in "${conditions[@]}"; do
    read -r variant setup size <<< "$condition"
    run_condition "$generation" strength 250 0.25 "$variant" "$setup" "$size"
    run_condition "$generation" policy-value 1 0 "$variant" "$setup" "$size"
  done
done

df -h /mnt/c > "$eval_dir/metrics/disk-after.txt"
/usr/lib/wsl/lib/nvidia-smi \
  --query-gpu=timestamp,temperature.gpu,power.draw,power.limit,memory.used,memory.total,utilization.gpu \
  --format=csv > "$eval_dir/metrics/gpu-after.csv"
date -u +%Y-%m-%dT%H:%M:%SZ > "$eval_dir/metrics/evaluation-stop-utc.txt"
sha256sum "$eval_dir"/results/*.json "$eval_dir"/games/*.json \
  > "$eval_dir/metrics/evaluation-artifacts-sha256.txt"
