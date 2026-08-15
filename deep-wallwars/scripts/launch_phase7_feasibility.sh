#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
run_dir=${1:?usage: launch_phase7_feasibility.sh RUN_DIR}
mkdir -p "$run_dir"/{data,models,metrics}

test -f "$run_dir/models/model_93.pt"
test ! -e "$run_dir/models/model_94.pt"

export PATH=/usr/src/tensorrt/bin:/usr/lib/wsl/lib:$HOME/.local/bin:$PATH
start_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s\n' "$start_utc" > "$run_dir/metrics/start-utc.txt"
df -h /mnt/c > "$run_dir/metrics/disk-before.txt"
/usr/lib/wsl/lib/nvidia-smi --query-gpu=timestamp,temperature.gpu,power.draw,power.limit,memory.used,memory.total,utilization.gpu --format=csv > "$run_dir/metrics/gpu-before.csv"

/usr/lib/wsl/lib/nvidia-smi dmon -s pucvmet -d 5 -o DT > "$run_dir/metrics/gpu-dmon.log" &
gpu_pid=$!
vmstat -t 5 > "$run_dir/metrics/vmstat.log" &
vmstat_pid=$!
cleanup() {
  kill "$gpu_pid" "$vmstat_pid" 2>/dev/null || true
}
trap cleanup EXIT

/usr/bin/time -v .venv/bin/python scripts/training.py \
  --arch transformer --d-model 256 --layers 10 --heads 8 --stem pointwise \
  --columns 12 --rows 10 --variant universal \
  --size-mix 8x8=20,9x9=10,8x9=5,9x8=5,9x10=5,10x9=5,10x10=20,11x10=5,12x10=25 \
  --initial_generation 93 --generations 4 --max-training-window 12 \
  --games 5000 --animal-cycle-games 1000 --animal-cycle-size 7x7 \
  --samples 1000 --training-batch-size 512 --inference-batch-size 256 \
  --threads 16 --seed 730071 \
  --deep_ww build-phase7/deep_ww --models "$run_dir/models" \
  --data "$run_dir/data" --log "$run_dir/metrics/training.log" \
  2>&1 | tee "$run_dir/metrics/training-stdout.log"

for generation in 93 94 95; do
  for variant in standard classic; do
    for size_count in 8x8:400 9x9:200 8x9:100 9x8:100 9x10:100 10x9:100 10x10:400 11x10:100 12x10:500; do
      size=${size_count%:*}
      expected=${size_count#*:}
      dir="$run_dir/data/generation_${generation}_${variant}_${size}"
      test "$(find "$dir" -maxdepth 1 -name 'game_*.csv' | wc -l)" -eq "$expected"
      test "$(find "$dir" -maxdepth 1 -name 'game_*.audit.json' | wc -l)" -eq "$expected"
    done
  done
  dir="$run_dir/data/generation_${generation}_animal-cycle_7x7"
  test "$(find "$dir" -maxdepth 1 -name 'game_*.csv' | wc -l)" -eq 1000
  test "$(find "$dir" -maxdepth 1 -name 'game_*.audit.json' | wc -l)" -eq 1000
done

df -h /mnt/c > "$run_dir/metrics/disk-after.txt"
/usr/lib/wsl/lib/nvidia-smi --query-gpu=timestamp,temperature.gpu,power.draw,power.limit,memory.used,memory.total,utilization.gpu --format=csv > "$run_dir/metrics/gpu-after.csv"
date -u +%Y-%m-%dT%H:%M:%SZ > "$run_dir/metrics/stop-utc.txt"
sha256sum "$run_dir"/models/model_{94,95,96}.pt > "$run_dir/metrics/model-sha256.txt"
