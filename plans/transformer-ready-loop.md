# Transformer-ready loop — standing orders + slice handoffs

> **Re-read this file at the start of every iteration.** [why: conversations compact, this file doesn't.]
> Owner/manager: **Nil**. Reviewer (pairing): **Game Reviewer** (`agent-1780864878869-eq7t`, room "Nil's Projects").
> Loop agent: **WallGamer** (`agent-1775539876882-3lpg`).

---

## North star

The repo can **define, train, export (ONNX → TensorRT fp16), benchmark, and self-play a transformer model end-to-end at 12x10 universal**, with the existing C++ tensor contract untouched, proven by a tiny smoke generation — so that starting a real training run is a one-command human decision.

What must not be diluted: the C++ engine consumes the transformer through the **exact same `.trt` interface** as the ResNet (`States (B,9,C,R)` in; `Priors (B, 2·C·R + 8)`, `Values (B,1)` out, same index order). No C++ contract changes in v1.

Out of scope: the real multi-day training run; variable-board-size (P6); anything outside `deep-wallwars/`, `info/`, `plans/`.

## Process per slice

```
plan → [Game Reviewer plan-gate] → implement → run gates → self-review
     → [Game Reviewer diff-gate] → sign-off → ONE focused commit (ticks the slice's box)
```

- Reviewer endpoint: `POST localhost:4000/api/agents/agent-1780864878869-eq7t/messages` (bearer `$ISOMUX_AGENT_TOKEN`).
- Reviewer protocol (agreed 2026-07-11, iteration 1):
  - Every diff-gate includes: exact cwd, branch + base commit, and whether unrelated local changes exist.
  - Tensor work: state expected shapes at each boundary (NCHW/NHWC, row/col indexing, flatten order, policy head ordering) in the plan/diff note.
  - Parity/export slices: state tolerances and deterministic seeds; call out explicitly if TensorRT can't run locally and gate on what can.
  - Reviewer reviews and signs off only; never implements. Blockers come back specific.
- While waiting on the reviewer: end turn with a long fallback wakeup (~20 min); the reply is the real wake signal.
- Never start slice N+1 with slice N uncommitted. Author SLICE-N+1 PICKUP only after slice N commits, folding in what N taught.

## Gates per slice

**Always-run (cheap, deterministic, no GPU, no network):**

```bash
cd /home/nil/nil/wallgame/deep-wallwars
.venv/bin/python -m pytest scripts/tests/ -q          # CPU-only unit tests (S2+)
git -C /home/nil/nil/wallgame status --porcelain       # only intended files
```

**When C++ is touched (S6 only):**

```bash
cmake --build build-tests --target unit_tests -j8 && deep-wallwars/scripts/cpp-test-gate.sh
```

(The gate script quarantines 6 pre-existing baseline failures — see its header. Never extend the quarantine list mid-loop.)

**GPU-gated (each ≤ ~30 min; check `nvidia-smi` utilization is ~0% first):**

```bash
# S3: trtexec fp16 compile + parity + throughput (scripts authored in-slice)
# S4: smoke generation (tiny model, ~20 games)
```

GPU etiquette: production bot processes `deep_ww_bgs_engine` (PIDs 559736/559737/559738) live on this GPU. If the 5090 is busy with something else, fall back to Nil's 4090 desktop (tailnet) — requires Nil coordination → queue it instead.

## Standing rails (verbatim, prohibitions)

1. NEVER modify or overwrite anything in `models_*/`, `assets/models/`, or any existing `.trt`/`.pt`/`.onnx` artifact.
2. NEVER change the C++ tensor contract (`States`/`Priors`/`Values` names, shapes, index order).
3. NEVER start a run projected over ~30 min without queueing it for Nil.
4. NEVER touch files outside `deep-wallwars/`, `info/`, `plans/`; never files other agents have dirty.
5. NEVER push. Commits local to `main`, one per slice, no branches.
6. NEVER kill, restart, or rebuild over the live `deep_ww_bgs_engine` processes; never write into `build/` (its CMakeCache is pinned to the old `/home/yu` path — all new C++ builds go to `build-tests/`).
7. Gates are never weakened to pass; a failing gate is fixed in-slice or queued.

## Slice plan

- [x] **S1** — Bench baseline: script measuring positions/sec of existing `.trt` engines (weak `model_48` 12x10 + strong `model_27` 8x8) + committed numbers report. Sets the throughput bar S3 must meet. → `scripts/bench_baseline.sh` + `plans/transformer-baseline-numbers.md`; both engines are batch-1 serving exports (~3700 pos/sec, launch-bound); serving bar for S3 = 1850 pos/sec, batch-256 bar measured in S3 from regenerated artifacts.
- [x] **S2** — `WallgameTransformer` in `scripts/model.py` (per-token heads; pointwise-embed and conv-stem variants behind a flag) + CPU pytest suite: output shapes, policy index-order parity vs ResNet, ONNX-exportability. → 14 CPU tests green; 7.98M/10.3M params (pointwise/conv); cell order locked to `gamestate.cpp:781` (col*rows+row) after reviewer's formula correction; note for S4: training.py exports without `eval()`.
- [ ] **S3** — Export path proven: ONNX → `trtexec --fp16` → parity script (TRT vs PyTorch outputs within tolerance) + throughput vs S1 baseline.
- [ ] **S4** — `--arch transformer` in `training.py` (AdamW + warmup for this arch; fastai `lr_find` stays for ResNet) + end-to-end smoke generation: tiny model, ~20 self-play games → CSV → train → export → reload.
- [ ] **S5 (optional)** — Control experiment: ResNet body + size-free conv heads (isolates "per-token heads" from "attention").
- [ ] **S6 (optional)** — Study-material generator: `deep_ww` flag for self-play at game size < model frame (C++), so strong 8x8 models can generate frame-embedded distillation data.

## Deferred / parked-for-Nil (HUMAN-ONLY — never decided in the loop)

- Real-run architecture config (d_model, layers, stem choice) — S2 ships sane defaults clearly marked as smoke-only.
- Any C++ tensor-contract change.
- New **runtime** dependencies (dev tooling like pytest is fine).
- Kicking off real training or the full distillation dataset generation.
- Anything touching the live bot service or `build/`.
- Fixing the 6 drifted C++ tests (5x `parse_move_notation`, 1x `validate_request` freestyle) — pre-existing at baseline, out of loop scope.

## Resources

**Environment (probed 2026-07-11, this box = auntie, RTX 5090 32GB):**
- Python venv: `deep-wallwars/.venv` — python 3.12.3, torch 2.10.0+cu128 (CUDA OK on 5090), onnx 1.20.1, numpy 2.4.2. ⚠ venv shebangs are broken (created under `/home/yu`): ALWAYS `.venv/bin/python -m pip`, never `.venv/bin/pip`.
- fastai 2.8.7 + pytest 9.1.1: installed into the venv during Phase 2 (verified).
- C++ suite baseline: 80 cases, 6 pre-existing failures quarantined via `scripts/cpp-test-gate.sh` (exit 0 at baseline). Fixing the drifted tests is parked for Nil.
- TensorRT: `trtexec` v10.15.01 at `/usr/bin/trtexec`.
- Catch2 v3.5.4 at `~/nil/tools/catch2` (pass `-DCatch2_DIR=~/nil/tools/catch2/lib/cmake/Catch2`).
- C++ builds: `build-tests/` (fresh, correct paths). `build/` is legacy — read-only.

**Key files / contract truth:**
- Model defs: `deep-wallwars/scripts/model.py` (ResNet, `input_channels = 9`).
- Training: `scripts/training.py` (loss = KLDiv(priors) + MSE(values); ONNX export ~lines 194–229, tensor names `States`/`Priors`/`Values`).
- Data: `scripts/data.py` (CSV: 4 lines per position — state, priors, value, blank).
- Input encoding (C++ oracle): `src/state_conversions.cpp:48-92` — 9 planes: 4 BFS-distance maps (me/my-goal/opp/opp-goal), right-walls, down-walls, second-action flag, red-to-move flag, variant flag.
- **Policy index order (the #1 trap):** `priors[wall_type * C·R + cell_index]` for walls (type 0 = right, 1 = down), then 8 move logits at offset `2·C·R`: cat R/D/L/U then mouse R/D/L/U. `cell_index = column * rows + row` per `Board::index_from_cell` (`src/gamestate.cpp:781`, verified 2026-07-11; token t maps to col = t // rows, row = t % rows). An earlier version of this file said `col + row*columns` - that was WRONG; Game Reviewer caught it at the S2 plan-gate.
- Contract validation: `src/tensorrt_model.cpp` (expects the exact tensor names and shapes).
- Elo tooling: `info/elo-tournament-instructions.md`; `deep_ww --ranking`.
- Baselines: `models_12x10_universal/model_48.trt` (WEAK, undertrained), `models_8x8_standard/model_27.trt` + `build/8x8_750000.trt` (STRONG).
- House pattern: `plans/minimax-ai-loop.md` (previous successful loop with the same reviewer).

**Evidence surfaces (judge by these, not by impressions):**
- pytest exit codes; `trtexec` reported qps; parity script printed max-abs-diff; CSV files on disk with correct line counts; `git log`/`git status`.

---

## SLICE-2 PICKUP

- **Baseline commit:** `9baaa61` (S1 done).
- **What S1 taught:**
  - Deployed engines are batch-1 serving exports (~3700 pos/sec, launch-bound); batch-256 self-play exports are separate artifacts. S3 has two bars (serving 1850 pos/sec; batch-256 measured vs regenerated ResNet).
  - `model_27.trt` is legacy 8-channel input; keep channel count a parameter, default 9.
  - Log-parsing traps: trtexec prints "Optimization Profile Index: 0" for static engines; log timestamps contain '-1'-like text. Parse extracted tokens, never whole lines.
  - No em dashes in prose (Nil's preference; reviewer checks).
- **Goal:** `WallgameTransformer` in `scripts/model.py` + CPU pytest suite in `scripts/tests/`. No `training.py` changes (S4), no GPU needed.
- **Load-bearing mechanics:**
  - Interface mirrors ResNet exactly: `__init__(columns, rows, d_model, layers, move_channels=8, heads=8, stem="pointwise"|"conv", stem_blocks=2)`; `forward(x: (B,9,cols,rows)) -> (priors (B, 2*cols*rows + move_channels), value (B,1))`; same `log_output` flag semantics (log_softmax train / softmax export); value tanh'd in-model.
  - **Flat-order contract (the trap):** the ResNet head's `Flatten` consumes spatial dims in torch row-major order; the transformer must flatten cells to tokens the SAME way and un-flatten wall logits the same way. Wall head: per-cell `Linear(d,2)` -> (B,N,2) -> permute(0,2,1) -> flatten -> (B,2N) for type-major order (all type-0 wall logits over cells, then all type-1). Move head: global token `Linear(d, move_channels)` appended after walls. Factor the arrangement into a pure function so it is unit-testable on synthetic tensors.
  - Tokens: N = cols*rows cell tokens (embedded from the 9 per-cell channel values) + 1 learned global token. Position: learned col-table (columns entries) + row-table (rows entries), added. Pre-norm `TransformerEncoderLayer`, batch_first, GELU, dropout 0.
  - Stems: "pointwise" = per-cell linear embed of the 9 channels; "conv" = reuse `ResLayer` blocks (stem_blocks of them) then per-cell embed. Both size-agnostic.
  - ONNX-exportability is a TEST (CPU `torch.onnx.export` smoke), not an assumption.
- **Acceptance:** pytest green CPU-only (shapes across (12,10)/(8,8)/(5,5) x both stems; arrangement-function order test on synthetic values; log_output softmax sums to 1; ONNX export smoke; param-count sanity). Gates: pytest + git-status.
- **Locked:** contract order; ResNet class untouched; no training.py changes.
- **Decide-with-reviewer:** default smoke config (d_model/layers); anything about the global-token design that looks risky.

## SLICE-1 PICKUP

- **Baseline commit:** `4c94103` (main).
- **Goal:** committed benchmark script + numbers report establishing inference-throughput baselines for the existing engines on the 5090.
- **Mechanics:**
  - `trtexec --loadEngine=<path> --iterations=200 --warmUp=500` reports qps; positions/sec = qps × engine batch size (read batch from the engine's reported input shape).
  - Bench `models_12x10_universal/model_48.trt` and `models_8x8_standard/model_27.trt`. Read-only on the engine files (rail 1).
  - Check `nvidia-smi` is idle first (GPU-gated gate).
  - Script: `deep-wallwars/scripts/bench_baseline.sh`. Report: `plans/transformer-baseline-numbers.md` (numbers + the derived S3 pass bar: transformer TRT throughput ≥ 0.5× model_48 positions/sec).
- **Acceptance:** script re-runnable; report has pos/sec for both engines; both committed in one commit that ticks S1.
- **Locked (don't relitigate):** no C++ changes; no model-file writes.
- **Decide-with-reviewer:** none expected; flag surprises.
