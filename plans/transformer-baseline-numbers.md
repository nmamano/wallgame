# S1 - Baseline inference throughput (existing TRT engines)

Slice S1 of `plans/transformer-ready-loop.md`. Produced by
`deep-wallwars/scripts/bench_baseline.sh` (re-runnable; read-only on engines).

- **Date:** 2026-07-11T14:04:57-07:00
- **GPU:** NVIDIA GeForce RTX 5090 (32 GB), utilization 0% at measurement
- **TensorRT:** v101501 (`/usr/bin/trtexec`)
- **Command per engine:** `trtexec --loadEngine=<engine> --warmUp=500 --iterations=200`
- **Baseline repo commit:** `7f9ba02`

## Results

| engine | batch | States shape (TRT) | qps | positions/sec | mean latency (ms) | mean GPU compute (ms) |
|---|---|---|---|---|---|---|
| `models_12x10_universal/model_48.trt` | 1 | 1x9x12x10 | 3699.22 | **3699** | 0.272897 | 0.269271 |
| `models_8x8_standard/model_27.trt` | 1 | 1x8x8x8 | 3785.37 | **3785** | 0.266675 | 0.263157 |

## Findings

1. **Both deployed engines are batch-1 serving exports** (not the batch-256
   self-play exports produced by `training.py`, default `--inference-batch-size 256`).
   Any batch-256 comparison in S3 MUST use artifacts regenerated into
   `build-tests/` from the `.pt` checkpoints - never the existing model files
   (standing rail 1).
2. `model_27.trt` is a **legacy 8-channel** input (1x8x8x8, no variant plane);
   `model_48.trt` is the 9-channel universal layout (1x9x12x10).
3. The two engines differ 2.25x in cell count yet differ only ~2% in qps:
   **batch-1 throughput is kernel-launch-bound, not compute-bound.** A batch-1
   comparison therefore measures per-inference overhead, not model FLOPs. This
   is still the right bar for the serving path (the deployed bot runs batch 1),
   but S3 must ALSO report a batch-256 like-for-like comparison for the
   self-play (compute-bound) picture.

## S3 pass bar (agreed metric: qps x batch)

- **Serving bar:** transformer 12x10 batch-1 fp16 TRT export must reach
  `>= 0.5 x 3699 = 1850 positions/sec` on this GPU.
- **Self-play bar (measured in S3):** transformer batch-256 export vs a
  batch-256 ResNet export regenerated from
  `assets/models/12x10_universal_model_48.pt` into `build-tests/`; same 0.5x
  factor applies to the ResNet's measured batch-256 positions/sec.
