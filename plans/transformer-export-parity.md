# S3 - Transformer export path: parity + throughput

Slice S3 of `plans/transformer-ready-loop.md`. Re-runnable via
`deep-wallwars/scripts/s3_run.sh` (export -> TRT build -> parity -> bench).
All artifacts under `build-tests/s3/` only.

- **Date:** 2026-07-11 (~14:20-14:30 PT)
- **GPU:** NVIDIA GeForce RTX 5090 (32 GB), idle except live bot processes
- **TensorRT:** v101501; **torch:** 2.10.0+cu128 (dynamo ONNX exporter)
- **Transformer config (fresh seeded random weights, seed 1234):** 12x10,
  d_model 256, layers 10, heads 8, pointwise stem, move_channels 8
  (7,975,179 params). Weights + config pinned by
  `build-tests/s3/manifest.json` + checkpoint; parity provably compares the
  exported weights. Trained-weight parity re-runs in S4 smoke.
- **ResNet reference:** regenerated read-only from
  `assets/models/12x10_universal_model_48.pt` at batch 256.
- **Commands:** `trtexec --onnx=<m>.onnx --saveEngine=<m>.trt --fp16`
  (plus `--noTF32` / `--builderOptimizationLevel=5` variants below);
  parity via `trtexec --loadEngine --loadInputs=States:<bin> --exportOutput=<json>`.

## Parity (TRT vs PyTorch fp32 eval(), log_output=False)

Gates: priors max-abs-diff <= 1e-2 post-softmax; values <= 1e-2; priors sums
~1 both sides; top-1 equality gated on PyTorch top1-top2 margin >= 5e-3
(near-ties reported, not gated). 64 seeded batch-1 samples; one full batch
for batch-256 engines.

| engine | precision | worst priors diff | worst values diff | margin-gated flips | verdict |
|---|---|---|---|---|---|
| transformer_b1 | fp16 | 1.3e-5 | 5.6e-4 | 0 | **PASS** |
| transformer_b256 | fp16 | 1.8e-5 | 8.9e-4 | 0 (1 near-tie at margin 0.00000, top5 5/5) | **PASS** |
| resnet48_b256 | fp16 | large | - | **11 flips (margins to 0.56) on first build; a REBUILD of the same ONNX flipped different positions with margins to 0.995** - TRT kernel selection is nondeterministic across builds | FAIL (informational, see finding 1) |
| resnet48_b256 | fp32 (TF32 default) | 1.9e-2 | 0.000000 | 1 flip at margin 0.018 | FAIL (diagnostic) |
| resnet48_b256 | fp32 `--noTF32` | 1.6e-4 | 0.000000 | 0 | **PASS** (validates harness + export) |

### Finding 1: the trained ResNet has always had fp16 drift in production

The noTF32 pass proves the ONNX export is faithful; the fp16/TF32 failures are
therefore precision effects on the TRAINED ResNet (20 blocks of large
confident logits amplified by softmax). Production engines have always been
built `--fp16` (CMakeLists, deployed `.trt`), so this drift has existed in
production unmeasured; MCTS renormalizes priors and absorbed it. Notable:
values are bit-exact even under TF32; the drift is policy-side.
**Queued for Nil:** whether to quantify the Elo cost of fp16 for the ResNet
(cheap tournament: fp16 vs noTF32 engines) or ignore.

Caveat recorded: the transformer's pristine parity is partly because random
weights produce small logits. Trained-transformer parity must be re-checked
in S4 (the harness takes `--pt`).

## Throughput (qps x batch, `scripts/bench_baseline.sh`)

| engine | batch | pos/sec | bar | verdict |
|---|---|---|---|---|
| transformer_b1 | 1 | **4135** | >= 1850 (0.5x deployed model_48) | **PASS** - also beats the deployed ResNet serving engine outright (3699) |
| transformer_b256 | 256 | 84,638 | >= 97,030 (0.5x regenerated ResNet) | **MISS at 0.436x** |
| transformer_b256 (builderOptimizationLevel=5) | 256 | 83,713 | same | no change - kernels already optimal |
| transformer_b1024 | 1024 | 64,217 | informational: batches past 256 amortize WORSE; 256 is already past the sweet spot | - |
| resnet48_b256 | 256 | 194,060 | reference | - |

### Finding 2: batch-256 bar missed at 0.436x (bar 0.5x) - queued, not weakened

The transformer has ~7x fewer FLOPs per position than the ResNet but attention
at sequence length 121 does not saturate the GPU the way dense 3x3 convs do.
Context for the decision (not excuses): self-play wall-clock includes MCTS CPU
work, so NN pos/sec does not translate 1:1 into games/sec; and the batch-1
serving path is FASTER than the deployed ResNet.
**Queued for Nil:** accept 0.436x for S4+ (my recommendation: yes, proceed;
self-play generation time will tell the truth), or require optimization work
(e.g. fused attention plugins, wider-shallower config) before S4.

## Process notes

- Piping script output through `tail`/`grep` masked nonzero exit codes twice
  this slice; `s3_run.sh` runs gates unpiped under `set -euo pipefail`.
- torch 2.10 uses the dynamo ONNX exporter by default; names/shapes survive
  (asserted in S2 tests) and TRT v101501 consumes the graphs cleanly.
