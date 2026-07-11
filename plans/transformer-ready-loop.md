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
- [x] **S3** — Export path proven: ONNX → `trtexec --fp16` → parity script (TRT vs PyTorch outputs within tolerance) + throughput vs S1 baseline. → Transformer parity PASS at b1 and b256 (worst diff 1.8e-5); batch-1 serving bar PASS at 4135 pos/sec (beats deployed ResNet); **batch-256 bar MISSED at 0.436x - queued for Nil, not weakened**; bonus finding: production ResNet fp16 drift (queued). Report: `plans/transformer-export-parity.md`.
- [x] **S4** — `--arch transformer` in `training.py` (one-cycle warmup for this arch; fastai `lr_find` stays for ResNet) + end-to-end smoke generation: tiny model, ~20 self-play games → CSV → train → export → reload. → SMOKE PASSED: C++ deep_ww loaded and ran the transformer engine in gen-1 self-play (evidence in `build-tests/s4/SMOKE_SUMMARY.md`); trained-weight parity 1.1e-4. Environment fix baked into standing orders: fastcore<2 + fastprogress<1.1 pins.
- [x] **S5 (optional)** — Control experiment: ResNet body + size-free conv heads (isolates "per-token heads" from "attention"). → `ConvHeadResNet` + `--arch convhead`; 22/22 tests; convhead smoke PASSED end-to-end (evidence: `build-tests/s5-convhead/SMOKE_SUMMARY.md`); parity harness extension to convhead noted as future work.
- [x] **S6 (optional)** — Study-material generator: `deep_ww` flag for self-play at game size < model frame (C++), so strong 8x8 models can generate frame-embedded distillation data. → `-game_columns/-game_rows` (default off, byte-identical); `make_padded_training_board` in engine_adapter reusing the serving padding machinery; classic goals at MODEL corners per serving semantics (reviewer correction); 3 new Catch2 tests; smoke: both variants at 8x8-in-12x10, padding walls verified in CSV planes, bad dims rejected. Evidence: `scripts/s6_smoke.sh`.

## Deferred / parked-for-Nil (HUMAN-ONLY — never decided in the loop)

- Real-run architecture config (d_model, layers, stem choice) — S2 ships sane defaults clearly marked as smoke-only.
- Any C++ tensor-contract change.
- New **runtime** dependencies (dev tooling like pytest is fine).
- Kicking off real training or the full distillation dataset generation.
- Anything touching the live bot service or `build/`.
- Fixing the 6 drifted C++ tests (5x `parse_move_notation`, 1x `validate_request` freestyle) — pre-existing at baseline, out of loop scope.
- **S3 finding 1:** trained ResNet has always played with fp16 policy drift in production (margin-gated top-1 flips at batch 256; drift VARIES PER ENGINE BUILD - first build margins to 0.56, a rebuild to 0.995; values bit-exact; noTF32 build is clean at 1.6e-4). Quantify Elo cost (fp16 vs noTF32 tournament) or ignore - Nil's call. See `plans/transformer-export-parity.md`.
- **S3 finding 2:** transformer batch-256 throughput = 84.6k pos/sec = 0.436x the regenerated ResNet (bar was 0.5x); opt-level 5 and batch 1024 do not help. Accept and proceed to S4 (WallGamer's recommendation), or require kernel/config optimization first - Nil's call. Batch-1 serving PASSES and beats the deployed ResNet (4135 vs 3699 pos/sec).

## Resources

**Environment (probed 2026-07-11, this box = auntie, RTX 5090 32GB):**
- Python venv: `deep-wallwars/.venv` — python 3.12.3, torch 2.13.0+cu130 (CUDA OK on 5090; NOTE: the Phase-2 fastai install silently UPGRADED torch from 2.10.0+cu128 — S2 onward all validated under 2.13), onnx 1.20.1, numpy 2.4.2. ⚠ venv shebangs are broken (created under `/home/yu`): ALWAYS `.venv/bin/python -m pip`, never `.venv/bin/pip`.
- fastai 2.8.7 + pytest 9.1.1: installed into the venv during Phase 2 (verified). ⚠ PIN fastcore<2 and fastprogress<1.1 (verified working: fastcore 1.14.5, fastprogress 1.0.5): unpinned pip pulls fastcore 2.x / fastprogress 1.1+ (which imports fasthtml), and fastai 2.8.7's Optimizer breaks with "'list' object has no attribute 'starmap'". python-fasthtml uninstalled from the venv.
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

## SLICE-6 PICKUP

- **Baseline commit:** `2c25e4a` (S5 done).
- **What S5 taught:**
  - `(B,2,C,R).flatten(1)` natively produces the contract layout; the conv-head control needed no permute.
  - Exact-type resume checks (`type is`, via ARCH_CLASSES) are stricter than isinstance and cheap.
  - Smoke parameterization by arch works; each arch gets its own evidence dir.
- **Goal:** `deep_ww` TRAINING mode can self-play games on a smaller effective board embedded in the model frame (the door to distilling from the strong 8x8 models into the 12x10 frame).
- **Feasibility facts (Explore recon, verified against source):**
  - Self-play board created at `main.cpp:157` (`Board board{FLAGS_columns, FLAGS_rows, variant}`), flags at :34-35.
  - `place_padding_walls(Board&, PaddingConfig const&)` (engine_adapter.cpp:130-255) mutates a Board directly - reusable as-is; `create_padding_config` handles per-variant embedding (standard: top-left; classic: bottom-center).
  - Working template: `convert_bgs_config_to_board()` (engine_adapter.cpp:787-860) does the full embed for live games.
  - Board has a 6-arg constructor taking explicit pawn/goal cells (gamestate.hpp:151-155).
  - CSV output auto-scales to board dims (state_conversions reads board.columns()/rows()); NO changes needed there.
- **Design:** new flags `-game_columns`/`-game_rows` (default 0 = off, current behavior byte-identical). When set: validate 4 <= game <= model dims; build PaddingConfig; compute embedded start cells (game-space corners transformed via transform_to_model); construct Board with the 6-arg constructor at MODEL dims; place_padding_walls; hand to training_play unchanged.
- **Gates/evidence:** C++ build + cpp-test-gate.sh green + new Catch2 test (padded training board has expected walls/positions); live evidence: a few simple-policy games at 8x8-in-12x10, CSV state line length = 9*120, wall planes show the padding region blocked (python one-liner check).
- **Locked:** default behavior byte-identical; no contract changes; nothing written to build/.

## SLICE-5 PICKUP

- **Baseline commit:** `2def3a0` (S4 done; core loop complete).
- **What S4 taught:**
  - The C++ engine runs transformer engines with zero changes - the contract strategy worked.
  - Fresh pip installs are a hazard: fastcore 2.x breaks fastai 2.8.7; torch got silently upgraded to 2.13. Pins recorded in Resources.
  - The git safety guard also scans message TEXT for destructive-looking strings; phrase reviewer messages accordingly.
  - Always-print of self-play cmd is cheap and makes evidence collection trivial.
- **Goal (control experiment):** `ConvHeadResNet` in `scripts/model.py` - ResNet body + size-free heads (1x1 conv wall head, GAP move/value heads), pure CNN, no attention. Isolates "size-free per-cell heads" from "attention" for the future ablation. Wire as `--arch convhead` in training.py and prove with the parameterized smoke.
- **Load-bearing mechanics:**
  - Wall head: `Conv2d(hidden, 2, 1)` -> (B,2,C,R) -> `flatten(1)` which IS type-major + row-major cell order = the contract layout, no permute needed (test asserts equivalence with `arrange_policy`).
  - Move head: global average pool over cells -> `Linear(hidden, move_channels)`. Value: GAP -> MLP -> tanh. Same `log_output` semantics.
  - No board-size-tied weights anywhere.
  - training.py: extend `build_fresh_model`/`expected_priors_of`/`check_loaded_model` for the new class; parameterize `s4_smoke.sh` with an optional arch arg (default transformer, unchanged behavior) and run it once with convhead.
- **Acceptance:** pytest green with new tests (shapes across sizes, order-equivalence vs arrange_policy, log_output, ONNX smoke, param sanity); convhead smoke passes end-to-end; ResNet + transformer paths untouched.
- **Locked:** contract; existing classes untouched.

## SLICE-4 PICKUP

- **Baseline commit:** `551eb51` (S3 done).
- **What S3 taught:**
  - Piping gate output through `tail`/`grep` masks nonzero exits (bit three times). Run gates unpiped or check `PIPESTATUS[0]`.
  - TRT kernel selection is nondeterministic per build; fp16 drift on trained ResNet varies per engine build (margins up to 0.995). Values stay bit-exact; drift is policy-side.
  - Containment guards must run BEFORE side effects (reviewer blocker).
  - `torch.onnx.export` defaults to `TrainingMode.EVAL` internally, so training.py's export without explicit `eval()` was never actually broken - the S2 note is downgraded.
  - Random weights flatter parity (small logits): trained-weight parity re-check is part of S4's acceptance.
- **Goal:** `--arch transformer` in `training.py` + end-to-end smoke generation proving the FULL loop with a transformer: self-play -> CSV -> train -> export -> **C++ deep_ww runs the transformer .trt engine** -> next generation.
- **Load-bearing mechanics (training.py touch points):**
  - Args: `--arch {resnet,transformer}` (default resnet = zero behavior change), `--d-model`, `--heads`, `--stem`; `--layers` shared between archs.
  - Fresh-model site (~line 758): branch on arch.
  - Resume check (~line 770) uses `model.priors[-1].out_features` (ResNet-only attr): replace with an arch-agnostic `expected_priors_of(model)` helper.
  - `--warm-start` + `--arch transformer`: hard error (v1; transformer bootstraps via distillation later, different mechanism entirely).
  - Optimizer: ResNet path UNTOUCHED (lr_find + fit). Transformer path: `fit_one_cycle` (built-in warmup) with fixed conservative lr (3e-4) + wd - marked smoke-defaults, real-run LR policy parked for Nil.
  - Smoke (scripts/s4_smoke.sh): everything under `build-tests/s4/{models,data}`; MUST pass explicit `--models/--data` (training.py defaults are `../models`, `../data`); deep_ww binary built fresh via `cmake --build build-tests --target deep_ww` (executing `build/` binaries is allowed, writing to `build/` is not - fresh build avoids staleness anyway); tiny config (d_model 32, layers 2, heads 4), ~20 games gen-0 simple policy, train, export, gen-1 self-play WITH the transformer engine (few games, low samples), train again. Evidence: CSV counts > 0 per generation dir, `model_*.trt` exist, deep_ww exit 0 while running the transformer engine, trained-weight parity via `export_transformer.py --pt <trained model_N.pt>` + `parity_check.py`.
- **Acceptance:** s4_smoke.sh exits 0 end-to-end on the 5090 in <= ~15 min; pytest still green; ResNet path provably untouched (default-arch diff inspection).
- **Locked:** contract; ResNet training behavior byte-identical when `--arch` omitted; no C++ changes.
- **Decide-with-reviewer:** the arch-agnostic priors-check helper shape; transformer smoke lr/wd defaults.

## SLICE-3 PICKUP

- **Baseline commit:** `441e07d` (S2 done; note: S2 was amended once pre-push-never-pushed to drop accidentally staged `__pycache__` .pyc files and generalize the `.gitignore` rule to `__pycache__/` - the old rule `/scripts/__pycache__` missed subdirectories).
- **What S2 taught:**
  - Cell order is `column * rows + row` (`gamestate.cpp:781`). The recon-derived formula was wrong; always verify contract lines against source.
  - `nn.TransformerEncoder` cannot run `num_layers=0`; `WallgameTransformer(layers=0)` is the supported mixing-free debug config.
  - `training.py` exports ONNX without `model.eval()` - matters for BatchNorm (conv stem, ResNet); handle/flag in S4.
  - `git add <dir>` sweeps generated files; add files explicitly.
- **Goal:** prove the export path on the GPU: transformer ONNX -> `trtexec --fp16` -> parity vs PyTorch within stated tolerances + throughput vs the S1 bars. All artifacts to `build-tests/` only.
- **Load-bearing mechanics:**
  - Export script (standalone, no training.py changes): fresh seeded model (and optional `--pt` checkpoint), `log_output=False`, `eval()`, export at batch 1 and batch 256, input `States`, outputs `Priors`/`Values`.
  - Parity WITHOUT a Python TensorRT dependency: `trtexec --loadEngine=<e> --loadInputs=States:<raw.bin> --exportOutput=<json>`; compare against PyTorch fp32 outputs on the same seeded inputs.
  - Proposed tolerances (fp16, post-softmax priors): max-abs-diff <= 1e-2, priors argmax equal per sample, value abs-diff <= 1e-2, over >= 64 seeded random inputs. If exceeded: report, do not weaken silently.
  - Batch-256 ResNet reference: regenerate from `assets/models/12x10_universal_model_48.pt` (torch.load needs `model.py` importable) into `build-tests/`, bench with `scripts/bench_baseline.sh` (takes engine paths as args).
  - Bars (from S1 report): transformer batch-1 >= 1850 pos/sec; batch-256 >= 0.5x the regenerated ResNet's measured pos/sec.
- **Acceptance:** parity report + throughput table committed (extend `plans/transformer-baseline-numbers.md` or a sibling report); scripts re-runnable; existing pytest suite still green.
- **Locked:** contract tensor names/shapes; no training.py changes; nothing written outside `build-tests/` + `scripts/` + `plans/`.
- **Decide-with-reviewer:** tolerance values; whether the fp16 parity gate should also check top-5 overlap instead of only argmax.

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
