# Running ELO Tournaments for Deep Wallwars Models

This guide explains how to run ELO tournaments to compare model strength across training generations.

## READ THIS FIRST: `deep-wallwars/elo_db/`

**Before designing any new tournament, open `deep-wallwars/elo_db/experiments.json`.**

It is the registry of every ELO experiment run so far: exact `engine_flags`, `samples`,
`noise_factor`, `games_per_pairing`, and a `notes` field recording what each run learned -
including the traps below. `games.jsonl` holds every individual game keyed by experiment.

This is not optional background reading. On 2026-08-06 a policy-only ladder was run that
duplicated `rr72_policy_2026-08-01` exactly, wasting GPU time to rediscover a fact that
entry already stated in its notes. These experiments have been running for months; the
registry is how that accumulates instead of being relearned.

**When you finish a run, add an entry and append its games.** An unregistered experiment is
one somebody will repeat.

## Traps that have already cost real time

Each of these was hit for real. They are cheap to avoid and expensive to rediscover.

### `-samples 1 -root_noise_factor 0` is deterministic - a pairing yields 2 games, not 40

That is the Easy Bot configuration (no search, raw policy head). With no search and no root
noise, two engines replay the same game every time; the only variation is which side has
which colour. Asking for 40 games returns 20 copies each.

*Detection:* every result count in every pairing lands on an exact multiple of games-per-colour.
In the 2026-08-06 policy run that was 21/21 pairings on multiples of 20, versus 0/21 for the
400-sample ladders. If you see that pattern, your effective sample size is 2 and any Elo
computed from it is meaningless.

*If you need policy strength with variety*, head-to-head cannot give it. Measure policy
accuracy instead: `--analyze` records every root action's prior alongside deep-search visits,
so you can score how often a model's policy argmax matches a deep reference.

### Never infer a gap between two clusters through a distant anchor

If generations A and B only ever meet a much weaker common opponent, the fit will invent a
gap between them from how each scores against that opponent - and that score measures
*drawishness* as much as strength. In 2026-08-05 this produced a phantom ~400 Elo collapse
that vanished to ~0 once the clusters played each other directly.

**Prefer a full round robin.** A complete graph cannot make this mistake. If a round robin is
too expensive, add explicit cross-cluster pairings; do not rely on the anchor.

### Score per MODEL, never per colour

Colours alternate within a pairing, so a raw `[Result]` tally reads about 50/50 no matter who
won. Attribute each result to the model named in `[White]`/`[Black]`.

### The PGNs store only the opening move

Each game is one line: the two model tags, the result, and the first move. You cannot measure
game length or count distinct games from them. Use the multiple-of-N signal above instead.

### Noise in evaluation is intentional

`root_noise_factor` defaults to 0.25 and the ranking scripts do not override it. That is
correct: it supplies the game diversity the measurement depends on, and at 400+ samples it is
overshadowed by search. `-root_noise_factor 0` exists for Easy Bot's inference-time design,
not as a cleaner way to evaluate.

### Know the noise floor before reading a result

40 games per pairing is roughly +/-80 Elo on a single pairing. Pooling 9 pairings (360 games)
gets to about +/-18. Anything inside the floor is "no change", not a finding.

## Prerequisites

- Built `deep_ww` executable in `deep-wallwars/build/`
- BayesianElo tool (located at `../bayeselo/` relative to wallgame repo)
- Model `.trt` files to compare

## Step 1: Prepare Models for Tournament

Create a directory with only the models you want to compare:

```bash
mkdir -p deep-wallwars/models_test
cp deep-wallwars/models_12x10_universal/model_10.trt deep-wallwars/models_test/
cp deep-wallwars/models_12x10_universal/model_20.trt deep-wallwars/models_test/
cp deep-wallwars/models_12x10_universal/model_30.trt deep-wallwars/models_test/
```

## Step 2: Run Tournament

The `--ranking` flag runs a round-robin tournament. Since "universal" is a model property (not a game variant), run separate tournaments for each variant:

**For standard variant:**
```bash
cd deep-wallwars/build
./deep_ww --ranking ../models_test --tournaments 10 --columns 12 --rows 10 --variant standard -j 28
```

**For classic variant:**
```bash
./deep_ww --ranking ../models_test --tournaments 10 --columns 12 --rows 10 --variant classic -j 28
```

### Parameters

| Parameter | Description |
|-----------|-------------|
| `--ranking <path>` | Directory containing .trt models to rank |
| `--tournaments N` | Number of tournament rounds (more = better accuracy, slower) |
| `--columns N` | Board width |
| `--rows N` | Board height |
| `--variant` | `standard` or `classic` (not `universal`) |
| `-j N` | Number of threads |

### Time Estimates

- 10 tournaments with 4 models: ~20-25 minutes
- 50 tournaments with all models: several hours

## Step 3: Calculate ELO Ratings

The tournament outputs `games.pgn` in the models directory. Use BayesianElo to calculate ratings:

```bash
cd ../bayeselo/src
./bayeselo
```

In the interactive prompt:
```
readpgn ../../wallgame/deep-wallwars/models_test/games.pgn
elo
mm
exactdist
ratings
x
```

### Example Output

```
Rank Name           Elo    +    - games score oppo. draws
   1 model_34.trt   188   12   12  2000   76%   -24   16%
   2 model_30.trt    15   12   12  1600   44%    72   19%
   3 model_20.trt   -39   13   13  1400   38%    63   18%
   4 model_10.trt  -165   15   16  1000   24%    28   28%
```

## Step 4: Plot ELO Progression (Optional)

Save ratings to CSV and plot:

```
offset 1500
ratings >../../wallgame/deep-wallwars/models_test/elo.csv
x
```

Then use the plotting script:
```bash
cd deep-wallwars/scripts
python plot_elo.py ../models_test/elo.csv --output elo_progression.png --games 4000
```

## Interpreting Results

- **+100 Elo difference**: Stronger model wins ~64% of games
- **+200 Elo difference**: Stronger model wins ~76% of games
- **+300 Elo difference**: Stronger model wins ~85% of games

If recent models show minimal Elo gain over earlier ones, training may have plateaued. Consider:
- Increasing `--epochs` (more learning per generation)
- Increasing `--samples` (stronger MCTS teacher signal)
- Increasing `--max-training-window` (retain older diverse data)

## What has been measured (2026-08-06)

Full detail and caveats in `deep-wallwars/elo_db/experiments.json`.

| Board / rules | p7 (gens 84-93) vs pre-onset (66-73) |
| --- | --- |
| 12x10 standard | **+114 Elo for p7** (360 games, +/-18) - the hardest board, and the size p7 was weighted toward |
| 8x8 standard | flat (+9 Elo, inside noise) |
| 8x8 classic | flat (+9 Elo, inside noise) |

Draw rates differ sharply by board: at 8x8 the newer generations draw 44-65% where the older
ones drew 20-31%, while at 12x10 every generation sits at 22.9-37.5%. Engine-vs-engine draw
rates are not a guide to production - real human-vs-bot games draw 0-3%.
