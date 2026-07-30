# ResNet control run - the apples-to-apples arm of the CNN vs transformer comparison

Launched 2026-07-29 23:44 PDT by WallGamer, at Nil's request. Runs on the 4090
desktop (`nilo@desktop-053vvpl-1`, WSL). Now driven by `~/supervise_resnet_run.sh`
in tmux session `rn-run`, targeting generation 36.

## The question

The transformer arm (`models_12x10_tf_curriculum`, generations 0-83) improved
faster and further than every ResNet lineage we have. But **every ResNet ever
trained here learned from corrupted labels**: for half of each game's decisions
the label was a one-hot "the move that was played" instead of the MCTS visit
distribution (`plans/data-pipeline-incident.md`, fixed in `07a9e3c`). The size of
that handicap cannot be quantified after the fact, so "the transformer is better"
is not a claim the existing plot can support.

This run removes the confound: a ResNet trained from scratch on **clean data**,
under the transformer's own phase-1 protocol, with architecture as the only
deliberate difference.

## Both arms are provably post-fix

- `07a9e3c` (the fix) committed **2026-07-12 08:14:15 -0700**; the transformer
  curriculum's first self-play started **08:16 PDT the same morning**, two
  minutes later. The whole `tf_curriculum` lineage is post-fix.
- Verified on the data itself, not on that timestamp
  (`scripts/audit_labels.py` on the transformer's early generations):

  | dir                                              | red one-hot | blue one-hot | seat gap |
  | ------------------------------------------------ | ----------- | ------------ | -------- |
  | `data_12x10_tf_curriculum/generation_1_standard` | 0.3%        | 0.1%         | 0.2%     |
  | `data_12x10_tf_curriculum/generation_3_classic`  | 0.8%        | 1.0%         | 0.1%     |
  | (corrupted lineage, for contrast)                | 21-70%      | 0%           | 21-70%   |

  `generation_0_*` is 100% one-hot in BOTH seats in both arms - that is the
  simple-policy bootstrap at `-samples 1`, seat-symmetric by construction, and
  identical between the two arms.

- The ResNet run's own audit gate runs per generation and printed
  `AUDIT OK` (red 0.2% / blue 0.2%, gap 0.0%) in the pre-flight smoke.

## The run

```bash
# ~/launch_resnet_p1.sh on the desktop; args: [initial_generation] [threads] [generations]
nice -n 10 ../.venv/bin/python training.py --arch resnet \
  --hidden_channels 128 --layers 20 \
  --columns 12 --rows 10 --game-columns 8 --game-rows 8 --variant universal \
  --generations <N> --initial_generation 0 --games 5000 --samples 1000 \
  --training-batch-size 512 --inference-batch-size 256 --threads 16 \
  --deep_ww ../build-tests/deep_ww \
  --models ../models_12x10_rn_curriculum \
  --data ../data_12x10_rn_curriculum \
  --log ../logs_curriculum_deepww_rn_p1.txt
```

Parity with the transformer's phase 1 (`~/launch_curriculum_p2.sh` is that
phase's continuation script, same flags):

| knob                       | transformer phase 1                  | this run                                                    | same?                        |
| -------------------------- | ------------------------------------ | ----------------------------------------------------------- | ---------------------------- |
| model frame                | 12x10                                | 12x10                                                       | yes                          |
| self-play game size        | 8x8 (padded in frame)                | 8x8 (padded)                                                | yes                          |
| variant                    | universal = 50/50 standard/classic   | same                                                        | yes                          |
| games per generation       | 5000                                 | 5000                                                        | yes                          |
| samples per move           | 1000                                 | 1000                                                        | yes                          |
| training window / games    | 20 gens / 20000                      | 20 / 20000                                                  | yes                          |
| training / inference batch | 512 / 256                            | 512 / 256                                                   | yes                          |
| architecture               | transformer d256 L10 h8, 8.0M params | ResNet 128ch x 20 ResLayers, 6.96M params                   | **the variable**             |
| LR policy                  | one-cycle 3e-4 (transformer branch)  | `lr_find` + `fit` (the historical ResNet branch, untouched) | no - each arch keeps its own |
| self-play threads          | 22                                   | 16                                                          | no - see below               |
| process priority           | normal                               | `nice -n 10`                                                | no - see below               |

The ResNet config is not tuned for this experiment: 128 channels x 20 layers
(6.96M params) is exactly what the historical 12x10 universal `model_48`
checkpoint contains, i.e. "the ResNet as it was", per Nil.

**Why the 12x10 frame and not native 8x8.** The comparison yardstick
(`~/elo_tournament/per_gen_update.sh`) plays every match with
`-columns 12 -rows 10 -game_columns 8 -game_rows 8`, so a 12x10-frame ResNet
drops into the existing measurement unchanged, and cross-architecture matches
(ResNet gen N vs transformer gen N) are directly playable - both models satisfy
the same C++ tensor contract. A native-8x8 ResNet would have been a different
input frame from the transformer's and would have needed its own yardstick.

**Why 16 threads and `nice`, and why that is scientifically neutral.**
`--threads` sets the self-play thread pool; games per generation and samples per
move are what determine the data, so thread count changes only how fast a
generation is produced, not what is in it. The 4090 is shared with three serving
`deep_ww_bgs_engine` processes, and 16 leaves ~12 of 28 cores for their thread
pools. `nice -n 10` makes the kernel prefer the bots whenever both want CPU.

## Pre-flight evidence

The ResNet arm of `training.py` had not run since the environment moved to torch
2.13 / fastai 2.8.7, so it was smoked first (`~/rn_smoke.sh`, 100 games,
20 samples, everything under `build-tests/rn_smoke`, no `models_*` dir touched):
gen-0 simple self-play both variants -> fresh ResNet -> `lr_find` + `fit` ->
ONNX -> `trtexec --fp16` -> **gen-1 self-play driven by the ResNet `.trt`** ->
label audit -> second training. `SMOKE_EXIT=0`.

## Bot etiquette: what was measured

The hard constraint is that the serving bots must not degrade. Measured with
`scripts/bgs-engine-probe.ts --scenario corpus --sessions 1 --samples 1000
--parallel 32 --threads 4`, which spawns its own throwaway engine on the
production binary and production model and times one evaluate at PuzzleBot's
exact settings:

| GPU state                           | evaluate latency         | GPU util |
| ----------------------------------- | ------------------------ | -------- |
| idle (before launch)                | 446 / 454 / 475 ms       | 0%       |
| ResNet gradient step (batch 512)    | 448 / 485 / 867 ms       | ~84%     |
| ResNet self-play (batch 256, -j 16) | 909 / 889 / 899 / 918 ms | ~95%     |

So sustained self-play roughly **doubles** the GPU-bound part of a bot's think
time (+0.45s on a 1000-sample move). Two things make that number pessimistic
rather than optimistic: the probe's throwaway engine runs at `nice -n15` while
the serving engines run at `nice 0` and the run at `nice 10`, and the probe adds
its own GPU load on top of the run's.

**The real-path check, which is the one that counts.** Live traffic happened
during the launch window (a player on PuzzleBot, 06:44-06:52Z), so production
think times can be compared directly against the same bot's own history
(`Evaluating` -> `Applying` deltas, grouped by the bot id the session was opened
for):

| bot         | before the run                         | during the run                        |
| ----------- | -------------------------------------- | ------------------------------------- |
| `dw-puzzle` | n=634, p50 0.58s, p90 9.77s, max 75.4s | n=19, p50 0.59s, p90 8.16s, max 9.19s |

No degradation visible in real play, and every probe returned a legal move with
`VERDICT: PASS` - no failed evaluations, no engine exits. Caveat, stated plainly:
those 19 moves land mostly in the gradient-step phase, so the sustained-self-play
number above is the conservative bound to plan around.

**If it needs to be quieter:** stop and relaunch with fewer self-play threads
(`bash ~/launch_resnet_p1.sh latest 8 <generations>`, or restart the supervisor
as `~/supervise_resnet_run.sh 36 8`). A mid-self-play kill can leave one
truncated `game_*.csv`, which the supervisor's sweep removes on the next start.
Thread count does not change what the data contains, only how fast it arrives.

Production baseline for context, from 12416 real bot moves in
`~/logs/bot-client-transformer.log` (Evaluating -> Applying deltas, classified by
each session's median):

| bot class       | p50   | p90   | p99    |
| --------------- | ----- | ----- | ------ |
| Easy (1 sample) | 0.12s | 3.58s | 11.13s |
| ~1000 samples   | 0.95s | 6.66s | 18.67s |
| ~5000 samples   | 3.42s | 9.68s | 24.08s |

VRAM: bots hold ~1.9 GB of 24.5 GB; the run adds ~3.5 GB (5.4 GB total during
the gradient step). Disk: ~2.7 GB per generation, 557 GB free.

## Overnight result (through 07:00 PT, 2026-07-30)

**Ten generations, `model_1` through `model_10`, zero errors, 20 x `AUDIT OK`**
(one-hot 0.1-0.9% per seat, gap ~0). Generation 11 was loading training data at
07:00. Data on disk 28 GB, free 529 GB. Python RSS peaked at 14.8 GB of the
25 GB WSL cap - bounded, because `--training-games 20000` now binds (gens 1-10
already hold ~25000 games), so the window stops growing from here.

Pace, against the transformer arm at the SAME generations:

| gen               | 2   | 3   | 4   | 5   | 6   | 7   | 8   | 9   | 10  |
| ----------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ResNet (min)      | 13  | 28  | 39  | 44  | 50  | 47  | 55  | 50  | 52  |
| transformer (min) | 42  | 111 | 101 | 94  | 129 | 149 | -   | -   | -   |

**The ResNet arm produces generations about 3x faster in wall clock**, while
handicapped (16 threads not 22, `nice 10`, sharing the GPU with the serving
bots; the transformer arm had the box to itself). This matches the S3 finding
that transformer batch-256 inference ran at 0.436x the ResNet's throughput. It
gives the comparison a second axis: both arms spend 5000 self-play games per
generation, so a per-generation plot is fair on the DATA budget, but per GPU
hour the ResNet gets roughly three generations per transformer generation.

Bot impact over the night, same config on both sides of the comparison (the
idle window is post-22:28-restart only, since S-SAMPLES changed `dw-easy` from
128 to 1 sample at that restart):

| bot              | idle                                   | under load                              |
| ---------------- | -------------------------------------- | --------------------------------------- |
| `dw-easy`        | n=264, p50 0.16s, p90 6.38s, max 19.9s | n=2549, p50 0.05s, p90 4.08s, max 33.4s |
| `dw-transformer` | n=87, p50 0.34s, p90 1.49s, max 14.4s  | n=232, p50 0.32s, p90 3.08s, max 32.4s  |
| `dw-puzzle`      | n=142, p50 0.59s, p90 9.32s, max 18.2s | n=2 (no traffic)                        |

Zero client errors, all three engines alive the whole night. The signature is
the one contention produces: **medians unmoved, tails stretched** - the heavy
bot's p90 went 1.49s -> 3.08s and both bots' worst move roughly doubled. Most
requests slip between self-play batches; some queue behind one.

## The CUDA fault, and why there is a supervisor now

At 08:56 PT on 2026-07-30, after `model_12`, generation 13's training died with
`torch.AcceleratorError: CUDA error: unknown error` raised inside fastai's
`Recorder.after_batch` metric accumulation. **The fault was confined to the
training process:** all three serving engines stayed up (11h17m uptime across
it), the bot client logged zero errors, and 25 real moves were served in the
window after it. But with no supervisor the GPU then sat idle for 50 minutes.

Nil's decision that morning was to run on to **generation 36** - where the
transformer stopped training 8x8-only - so unattended recovery became worth
having. `~/supervise_resnet_run.sh TARGET THREADS` (running as `36 16` in tmux
session `rn-run`) loops: read the newest `model_N.pt`, stop at the target,
otherwise sweep the in-flight generation's data and relaunch with
`--generations TARGET-N+1`, which lands exactly on the target. Three failures
inside 5 minutes of each other and it gives up rather than hammering the GPU.

The transformer run deliberately had no auto-restart, and that reasoning still
holds where it applied: blindly re-running a self-play generation risks the data.
Two things make a restart safe here instead of merely convenient:

1. `training.py` resumes by **skipping games that already exist** and starting
   after the highest-numbered file, so nothing completed is re-played or
   overwritten. Confirmed on the real restart: generation 12's data was skipped,
   re-audited `AUDIT OK`, and training resumed at generation 13.
2. The only integrity risk a kill introduces is a **truncated game CSV**, and the
   sweep removes exactly those before each relaunch, using the format invariant
   of 4 lines per position. The check was validated both ways before being
   trusted: 200/200 known-good files give `NR % 4 == 0`, and a deliberately
   truncated copy gives 3. (The 08:56 crash happened during training, not
   self-play, so the first sweep found nothing to remove - as expected.)

## Ops

```bash
ssh nilo@desktop-053vvpl-1
tmux attach -t rn-run                      # the supervisor; the run itself is its child
cat ~/resnet_supervisor.log                # one line per launch, exit, and swept file
tail -f ~/nil/wallgame/deep-wallwars/training_curriculum_rn_p1.log
ls ~/nil/wallgame/deep-wallwars/models_12x10_rn_curriculum/model_*.pt | sed 's/.*model_//;s/.pt//' | sort -n | tail -1
```

- **Stop it:** `tmux kill-session -t rn-run`. Safe for the box because
  `keepalive` and `bot-client` sessions exist (killing the LAST tmux session
  takes WSL down - see `info/puzzle-platform.md` section 2).
- **Resume:** `tmux new-session -d -s rn-run 'bash ~/supervise_resnet_run.sh 36 16'`.
  For a single run without the supervisor:
  `bash ~/launch_resnet_p1.sh latest 16 <generations>`.
- **Throttle further:** stop, relaunch with a lower thread count, e.g.
  `bash ~/launch_resnet_p1.sh latest 8`.
- The run stops when `model_36` exists (`TARGET REACHED` in the supervisor
  log), matching where the transformer stopped training 8x8-only. Nil's call,
  2026-07-30: run it through the day to reach that mark.

## Reading the result

Per-generation strength with the transformer arm's own yardstick: 40 games per
pairing, both variants, `deep_ww --ranking` at `-game_columns 8 -game_rows 8`,
`-samples 400` (`~/elo_tournament/per_gen_update.sh`, pointed at
`models_12x10_rn_curriculum`). Two readings are available and they answer
different questions:

1. **Within-arm curve** - ResNet gen N vs its own earlier generations, plotted
   against the transformer's curve at matched generation counts. Same axis as
   the plot Nil already made.
2. **Cross-arm head-to-head** - ResNet gen N vs transformer gen N directly.
   Both are 12x10-frame models on the same tensor contract, so this needs no new
   tooling and is the sharper measurement.

Caveat to carry into any conclusion: this run covers one night of generations,
so it can only speak to the EARLY curve. The transformer's "kept improving even
when 8x8 dropped below 10% of self-play" claim lives at generations 40-83 and is
out of reach here.
