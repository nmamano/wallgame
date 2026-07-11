#!/usr/bin/env bash
# S3 orchestrator (transformer-ready loop): export -> TRT build -> parity -> bench.
# Re-runnable; writes ONLY under build-tests/s3/. Takes ~10 min on an idle GPU.
#
# Parity gates (exit nonzero on failure):
#   - transformer fp16 @ batch 1 (64 seeded samples) and @ batch 256 (full batch)
#   - resnet noTF32 @ batch 256 (validates the parity harness on trained weights)
# Informational (non-gating, expected to FAIL parity):
#   - resnet fp16 @ batch 256: trained-ResNet logits amplify fp16/TF32 error;
#     production has always run fp16, so this drift has always existed there.
#     See plans/transformer-export-parity.md.
set -euo pipefail

cd "$(dirname "$0")/.."
PY=.venv/bin/python
S3=build-tests/s3
M=$S3/manifest.json

echo "=== 1/4 export (CPU) ==="
$PY scripts/export_transformer.py

echo "=== 2/4 TRT builds (GPU) ==="
for spec in "transformer_b1 --fp16" "transformer_b256 --fp16" "resnet48_b256 --fp16" "resnet48_b256_notf32 --noTF32"; do
    name=${spec%% *}
    flag=${spec##* }
    onnx=$S3/${name%_notf32}.onnx
    trtexec --onnx="$onnx" --saveEngine="$S3/$name.trt" "$flag" >/dev/null 2>&1 \
        || { echo "FATAL: trtexec build failed for $name" >&2; exit 1; }
    echo "built $S3/$name.trt ($flag)"
done

echo "=== 3/4 parity (GPU) ==="
$PY scripts/parity_check.py --manifest $M --engine $S3/transformer_b1.trt --kind transformer --batch 1 --samples 64
$PY scripts/parity_check.py --manifest $M --engine $S3/transformer_b256.trt --kind transformer --batch 256
$PY scripts/parity_check.py --manifest $M --engine $S3/resnet48_b256_notf32.trt --kind resnet --batch 256
echo "--- informational (non-gating): resnet fp16, expected to fail parity ---"
$PY scripts/parity_check.py --manifest $M --engine $S3/resnet48_b256.trt --kind resnet --batch 256 || true

echo "=== 4/4 bench (GPU) ==="
scripts/bench_baseline.sh $S3/transformer_b1.trt $S3/transformer_b256.trt $S3/resnet48_b256.trt
