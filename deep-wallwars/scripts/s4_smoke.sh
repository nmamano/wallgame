#!/usr/bin/env bash
# S4 smoke (transformer-ready loop): full training loop with --arch transformer.
#
# Proves end-to-end: gen-0 simple-policy self-play -> CSV -> bootstrap train ->
# export (.pt/.onnx/.trt) -> gen-1 self-play where the C++ deep_ww engine LOADS
# AND RUNS THE TRANSFORMER .trt -> train -> model_2 -> trained-weight parity.
#
# Everything under build-tests/s4/ (wiped first so stale artifacts can never
# satisfy the evidence checks). Writes build-tests/s4/SMOKE_SUMMARY.md.
# Tiny smoke config; proves the pipeline, not playing strength.
set -euo pipefail

cd "$(dirname "$0")/.."
PY=.venv/bin/python

# Optional positional arch arg. Default (transformer) keeps the original S4
# behavior and evidence path; other arches get their own output dir so S4
# transformer evidence is never overwritten.
ARCH="${1:-transformer}"
case "$ARCH" in
transformer)
    S4="build-tests/s4"
    ARCH_ARGS=(--arch transformer --d-model 32 --layers 2 --heads 4)
    ;;
convhead)
    S4="build-tests/s5-convhead"
    ARCH_ARGS=(--arch convhead --hidden_channels 32 --layers 2)
    ;;
*)
    echo "FATAL: unsupported smoke arch '$ARCH' (transformer|convhead)" >&2
    exit 1
    ;;
esac

# Fresh, isolated output dir (S4 outputs only; never touches s3/ or models_*).
rm -rf "${S4:?}"
mkdir -p "$S4"

echo "=== 1/4 fresh deep_ww build ==="
cmake --build build-tests --target deep_ww -j8 >/dev/null

echo "=== 2/4 training loop (--arch $ARCH, tiny config) ==="
TRAIN_CMD=(../.venv/bin/python training.py
    "${ARCH_ARGS[@]}"
    --columns 12 --rows 10 --variant universal
    --games 20 --samples 32 --epochs 1 --generations 2
    --training-batch-size 64 --inference-batch-size 64
    --threads 8
    --deep_ww ../build-tests/deep_ww
    --models "../$S4/models" --data "../$S4/data"
    --log "../$S4/deep_ww_log.txt")
(cd scripts && "${TRAIN_CMD[@]}" 2>&1) | tee "$S4/training_stdout.txt"
[ "${PIPESTATUS[0]}" -eq 0 ] || { echo "FATAL: training.py failed" >&2; exit 1; }

echo "=== 3/4 evidence checks ==="
fail=0
for d in "$S4"/data/generation_*; do
    n=$(ls "$d"/*.csv 2>/dev/null | wc -l)
    echo "  $d: $n csv files"
    [ "$n" -gt 0 ] || fail=1
done
for m in model_1 model_2; do
    for ext in pt onnx trt; do
        f="$S4/models/$m.$ext"
        [ -f "$f" ] && echo "  $f: $(stat -c%s "$f") bytes" || { echo "  MISSING: $f"; fail=1; }
    done
done
# Generation-1 self-play must have used the transformer engine, not 'simple'.
if grep -q -- "-model1 ../$S4/models/model_1.trt" "$S4/training_stdout.txt"; then
    echo "  gen-1 self-play used model_1.trt: CONFIRMED (self-play cmd in stdout)"
else
    echo "  MISSING evidence that gen-1 used model_1.trt"; fail=1
fi
grep -m2 "Loaded engine size" "$S4/deep_ww_log.txt" | sed 's/^/  engine load: /' || { echo "  no engine-load lines in deep_ww log"; fail=1; }
[ "$fail" -eq 0 ] || { echo "FATAL: evidence checks failed" >&2; exit 1; }

if [ "$ARCH" = "transformer" ]; then
    echo "=== 4/4 trained-weight parity (model_2.pt through the S3 harness) ==="
    $PY scripts/export_transformer.py --outdir "$S4/parity" --seed 999 \
        --d-model 32 --layers 2 --heads 4 --pt "$S4/models/model_2.pt"
    trtexec --onnx="$S4/parity/transformer_b1.onnx" \
        --saveEngine="$S4/parity/transformer_b1.trt" --fp16 >/dev/null 2>&1
    $PY scripts/parity_check.py --manifest "$S4/parity/manifest.json" \
        --engine "$S4/parity/transformer_b1.trt" --kind transformer --batch 1 --samples 16 \
        | tee "$S4/parity_result.txt"
    [ "${PIPESTATUS[0]}" -eq 0 ] || { echo "FATAL: trained-weight parity failed" >&2; exit 1; }
else
    echo "=== 4/4 parity SKIPPED for arch $ARCH ==="
    # The S3 parity harness (export_transformer.py/parity_check.py) supports
    # transformer/resnet kinds only; extending it to convhead is future work.
    echo "parity: SKIPPED (harness supports transformer/resnet kinds only)" > "$S4/parity_result.txt"
fi

{
    echo "# Smoke summary - arch: $ARCH ($(date -Iseconds))"
    echo
    echo "- GPU: $(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
    echo "- torch: $($PY -c 'import torch; print(torch.__version__)') | trtexec: $(trtexec --version 2>&1 | grep -oEm1 'TensorRT v[0-9]+' || echo n/a)"
    echo "- training command: ${TRAIN_CMD[*]}"
    echo "- deep_ww binary: build-tests/deep_ww (fresh build)"
    echo
    echo "## Evidence"
    for d in "$S4"/data/generation_*; do
        echo "- $d: $(ls "$d"/*.csv 2>/dev/null | wc -l) csv files"
    done
    for f in "$S4"/models/model_*.trt; do echo "- $f ($(stat -c%s "$f") bytes)"; done
    echo "- gen-1 self-play cmd: $(grep -m1 -- "-model1 ../$S4/models/model_1.trt" "$S4/training_stdout.txt" | sed 's/^ *//')"
    echo "- parity: $(tail -1 "$S4/parity_result.txt")"
    echo
    echo "Limitation: a 2-layer tiny model trained on 40 games does not prove"
    echo "real-run logit magnitudes; trained parity must re-run on real checkpoints."
} > "$S4/SMOKE_SUMMARY.md"

echo
echo "SMOKE PASSED (arch $ARCH) - summary at $S4/SMOKE_SUMMARY.md"
