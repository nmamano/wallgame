#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
run_dir=${1:?usage: launch_phase7_from_model94.sh RUN_DIR}
manifest=scripts/phase7-corrected-manifest.json
acceptance=scripts/phase7-classic-10x9-acceptance.json
metrics="$run_dir/metrics"

test -f "$run_dir/models/model_94.pt"
test -f "$run_dir/models/model_94.trt"
test ! -e "$run_dir/models/model_95.pt"
printf '%s  %s\n' \
  0675d45282e2bcb8bc573d749619cffbfe3e32888b56e77daf27e4ea220542a6 \
  "$manifest" | sha256sum -c -

standard_count=$(find "$run_dir/data" -mindepth 1 -maxdepth 1 \
  -type d -name 'generation_94_standard_*' \
  -exec find {} -maxdepth 1 -type f -name 'game_*.csv' \; | wc -l)
standard_audits=$(find "$run_dir/data" -mindepth 1 -maxdepth 1 \
  -type d -name 'generation_94_standard_*' \
  -exec find {} -maxdepth 1 -type f -name 'game_*.audit.json' \; | wc -l)
classic_dir="$run_dir/data/generation_94_classic_8x8"
test "$standard_count" -eq 2000
test "$standard_audits" -eq 2000
test "$(find "$classic_dir" -maxdepth 1 -type f -name 'game_*.csv' | wc -l)" -eq 400
test "$(find "$classic_dir" -maxdepth 1 -type f -name 'game_*.audit.json' | wc -l)" -eq 400
test "$(find "$run_dir/data" -mindepth 1 -maxdepth 1 -type d \
  -name 'generation_94_animal-cycle_*' -exec find {} -type f -name 'game_*.csv' \; | wc -l)" -eq 0

find "$classic_dir" -maxdepth 1 -type f \
  \( -name 'game_*.csv' -o -name 'game_*.audit.json' \) -print0 |
  sort -z | xargs -0 sha256sum > "$metrics/generation-94-classic-8x8-frozen.sha256"
sha256sum "$metrics/generation-94-classic-8x8-frozen.sha256" \
  > "$metrics/generation-94-classic-8x8-frozen-manifest.sha256"
sha256sum "$run_dir/models/model_94.pt" "$run_dir/models/model_94.trt" \
  > "$metrics/model-94-before-seat-warning-resume.sha256"

export PATH=/usr/src/tensorrt/bin:/usr/lib/wsl/lib:$HOME/.local/bin:$PATH
date -u +%Y-%m-%dT%H:%M:%SZ > "$metrics/seat-warning-resume-start-utc.txt"
git rev-parse HEAD > "$metrics/seat-warning-resume-source-head.txt"
df -h /mnt/c > "$metrics/disk-before-seat-warning-resume.txt"
/usr/lib/wsl/lib/nvidia-smi \
  --query-gpu=timestamp,temperature.gpu,power.draw,power.limit,memory.used,memory.total,utilization.gpu \
  --format=csv > "$metrics/gpu-before-seat-warning-resume.csv"

/usr/lib/wsl/lib/nvidia-smi dmon -s pucvmet -d 5 -o DT \
  > "$metrics/gpu-dmon-seat-warning-resume.log" &
gpu_pid=$!
vmstat -t 5 > "$metrics/vmstat-seat-warning-resume.log" &
vmstat_pid=$!
cleanup() {
  kill "$gpu_pid" "$vmstat_pid" 2>/dev/null || true
}
trap cleanup EXIT

/usr/bin/time -v .venv/bin/python scripts/training.py \
  --arch transformer --d-model 256 --layers 10 --heads 8 --stem pointwise \
  --columns 12 --rows 10 --variant universal \
  --size-mix 8x8=20,9x9=10,8x9=5,9x8=5,9x10=5,10x9=5,10x10=20,11x10=5,12x10=25 \
  --initial_generation 94 --generations 3 --max-training-window 12 \
  --games 5000 --animal-cycle-games 1000 --animal-cycle-size 7x7 \
  --label-audit-acceptance "$acceptance" \
  --samples 1000 --training-batch-size 512 --inference-batch-size 256 \
  --threads 16 --seed 730071 \
  --deep_ww build-phase7/deep_ww --models "$run_dir/models" \
  --data "$run_dir/data" --log "$metrics/training.log" \
  2>&1 | tee "$metrics/training-seat-warning-resume-stdout.log"

for generation in 94 95; do
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

df -h /mnt/c > "$metrics/disk-after-seat-warning-resume.txt"
/usr/lib/wsl/lib/nvidia-smi \
  --query-gpu=timestamp,temperature.gpu,power.draw,power.limit,memory.used,memory.total,utilization.gpu \
  --format=csv > "$metrics/gpu-after-seat-warning-resume.csv"
date -u +%Y-%m-%dT%H:%M:%SZ > "$metrics/seat-warning-resume-stop-utc.txt"
sha256sum "$run_dir"/models/model_{94,95,96}.{pt,onnx,trt} \
  > "$metrics/models-94-through-96.sha256"
