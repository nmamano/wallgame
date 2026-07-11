#!/usr/bin/env bash
# S1 baseline benchmark (transformer-ready loop, plans/transformer-ready-loop.md).
#
# Measures inference throughput of existing STATIC-shape TensorRT engines via
# trtexec and prints a markdown table. Read-only on engine files.
#
# Usage: bench_baseline.sh [engine.trt ...]
#   (default: models_12x10_universal/model_48.trt models_8x8_standard/model_27.trt)
#
# Oracle (agreed at S1 plan-gate): trtexec-reported qps x engine batch dim.
# Fails nonzero on: missing nvidia-smi/trtexec, missing engine file, dynamic
# shapes, or unparseable shape/throughput. GPU-idle check is ADVISORY only:
# the nvidia-smi snapshot is printed, nothing is killed or restarted.
set -euo pipefail

cd "$(dirname "$0")/.." # deep-wallwars root

ENGINES=("$@")
if [ ${#ENGINES[@]} -eq 0 ]; then
    ENGINES=(models_12x10_universal/model_48.trt models_8x8_standard/model_27.trt)
fi

command -v nvidia-smi >/dev/null || { echo "FATAL: nvidia-smi not found" >&2; exit 1; }
command -v trtexec >/dev/null || { echo "FATAL: trtexec not found" >&2; exit 1; }

WARMUP=500
ITERS=200

echo "## GPU snapshot (advisory idle check - informational, never fatal)"
echo '```'
nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv
echo '```'
GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
GPU_UTIL=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits | head -1 | tr -d ' ')
if [ "${GPU_UTIL}" -gt 20 ]; then
    echo "WARNING: GPU utilization is ${GPU_UTIL}% - results may be contended." >&2
fi

echo
echo "| engine | batch | States shape (TRT) | qps | positions/sec | mean latency (ms) | mean GPU compute (ms) |"
echo "|---|---|---|---|---|---|---|"

TRT_VERSION="unknown"
for eng in "${ENGINES[@]}"; do
    [ -f "$eng" ] || { echo "FATAL: engine not found: $eng" >&2; exit 1; }
    out=$(mktemp)
    if ! trtexec --loadEngine="$eng" --warmUp=$WARMUP --iterations=$ITERS >"$out" 2>&1; then
        echo "FATAL: trtexec failed for $eng - last lines:" >&2
        tail -5 "$out" >&2
        rm -f "$out"
        exit 1
    fi

    v=$(grep -oEm1 'TensorRT v[0-9]+' "$out" || true)
    [ -n "$v" ] && TRT_VERSION="$v"

    # Static-shape guard: a dynamic-shape engine reports -1 in its binding dims
    # (note: trtexec prints "Optimization Profile Index: 0" even for static
    # engines, so that text is NOT a dynamic-shape signal).
    binding_line=$(grep -m1 'Input binding for States with dimensions' "$out" || true)
    if [ -z "$binding_line" ]; then
        echo "FATAL: no States input binding reported for $eng" >&2
        rm -f "$out"
        exit 1
    fi
    # Extract exactly the dims token (the log-line prefix contains dates with
    # '-', so never scan the whole line for '-1').
    shape=$(echo "$binding_line" | sed -nE 's/.*dimensions ([-0-9x]+) is created.*/\1/p')
    if [ -z "$shape" ]; then
        echo "FATAL: could not parse States input shape for $eng (line: $binding_line)" >&2
        rm -f "$out"
        exit 1
    fi
    case "$shape" in
    *-*)
        echo "FATAL: $eng has dynamic dimensions ($shape); this script only supports static engines." >&2
        rm -f "$out"
        exit 1
        ;;
    esac
    batch=${shape%%x*}

    qps=$(grep -oEm1 'Throughput: [0-9.]+ qps' "$out" | grep -oE '[0-9.]+' | head -1 || true)
    if [ -z "$qps" ]; then
        echo "FATAL: could not parse throughput for $eng" >&2
        rm -f "$out"
        exit 1
    fi

    # Optional metrics - reported when present, never fatal.
    lat=$(grep -E '\] Latency: min' "$out" | sed -nE 's/.*mean = ([0-9.]+) ms.*/\1/p' | head -1 || true)
    gpu_ms=$(grep -E 'GPU Compute Time: min' "$out" | sed -nE 's/.*mean = ([0-9.]+) ms.*/\1/p' | head -1 || true)

    possec=$(awk -v q="$qps" -v b="$batch" 'BEGIN { printf "%.0f", q * b }')
    echo "| $eng | $batch | $shape | $qps | $possec | ${lat:-n/a} | ${gpu_ms:-n/a} |"
    rm -f "$out"
done

echo
echo "- trtexec: ${TRT_VERSION} | GPU: ${GPU_NAME} | date: $(date -Iseconds)"
echo "- command per engine: \`trtexec --loadEngine=<engine> --warmUp=${WARMUP} --iterations=${ITERS}\`"
echo "- positions/sec = qps x batch (S1 pass-bar metric; see plans/transformer-baseline-numbers.md)"
