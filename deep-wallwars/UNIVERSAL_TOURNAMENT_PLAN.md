# Universal Model ELO Tournament Plan

**Tournament Date:** 2026-01-18
**Models Tested:** 59 models (model_0.trt through model_58.trt)
**Board Size:** 12x10 (first tournament at this size)
**Model Type:** Universal (first tournament for universal models - plays both Standard and Classic)

## Tournament Configuration

### Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| **Models** | 59 (all generations) | Complete picture of training evolution |
| **Tournaments** | 18 | 10,440 games per variant (close to 10k budget) |
| **Games/Matchup** | 10 | Standard for single-elimination |
| **Board Size** | 12×10 | Production board size |
| **Variants** | Standard + Classic | Both variants universal model was trained on |
| **MCTS Samples** | 1200 | Match training configuration |
| **Threads** | 28 | Maximum parallelism |

### Game Count Breakdown

**Per tournament (59 models, single-elimination):**
- 58 matchups × 10 games = 580 games

**Total per variant:**
- 18 tournaments × 580 games = **10,440 games**

**Grand total (both variants):**
- 10,440 × 2 = **20,880 games**

### Estimated Runtime

Based on typical 12×10 game performance:
- **Per variant:** 8-12 hours (depends on game length and GPU)
- **Both variants sequentially:** 16-24 hours
- **Both variants parallel (2 GPUs):** 8-12 hours

## Tournament Structure

`★ Insight ─────────────────────────────────────`
**Single-elimination bracket:**
Each tournament randomly shuffles all 59 models into a bracket.
Models face off head-to-head; winners advance to next round.
Running 18 separate tournaments ensures all models get exposure
to diverse opponents despite early eliminations.
`─────────────────────────────────────────────────`

### Round Structure (per tournament)

```
Round 1: 29 matchups (58 models play, 1 gets bye)
   └─> 30 models advance

Round 2: 15 matchups
   └─> 15 models advance

Round 3: 7 matchups (1 bye)
   └─> 8 models advance

Round 4: 4 matchups
   └─> 4 models advance

Round 5: 2 matchups
   └─> 2 models advance

Round 6: 1 matchup (finals)
   └─> 1 winner
```

## Execution Instructions

### Quick Start (Recommended)

**Single unified script does everything:**

```bash
cd deep-wallwars/scripts

# Run complete tournament: games + ELO calculation + plots
./run_full_tournament.sh
```

This script will:
1. Run tournaments for your chosen variant(s)
2. Calculate ELO ratings with BayesElo (automatically located)
3. Generate ELO progression plots
4. Display top 10 models for each variant

**First time setup:** If you don't have BayesElo installed, the script will provide instructions.

### Manual Execution

If you prefer to run manually or customize:

**Standard Variant:**
```bash
cd deep-wallwars/build

./deep_ww --ranking ../models_12x10_universal \
  --tournaments 18 \
  --games 10 \
  --columns 12 \
  --rows 10 \
  --variant standard \
  --samples 1200 \
  -j 28
```

**Classic Variant:**
```bash
./deep_ww --ranking ../models_12x10_universal \
  --tournaments 18 \
  --games 10 \
  --columns 12 \
  --rows 10 \
  --variant classic \
  --samples 1200 \
  -j 28
```

Results are written to `models_12x10_universal/games.pgn` (move to preserve between runs).

### Alternative Configurations

If you want to adjust the parameters:

**More games (closer to 10k exactly):**
```bash
# 17 tournaments = 9,860 games per variant
--tournaments 17 --games 10
```

**Fewer tournaments, more decisive matchups:**
```bash
# 12 tournaments × 15 games = 10,440 games per variant
--tournaments 12 --games 15
```

**Skip weak generation 0:**
```bash
# Start from model_1 (58 models total)
--initial_model 1
# This gives 57 matchups per tournament
# 18 tournaments × 57 × 10 = 10,260 games
```

## BayesElo Analysis

**Note:** If you used `run_full_tournament.sh`, ELO calculation is already done automatically!

The script uses the existing BayesElo methodology (same as previous tournaments for comparability):
1. Reads PGN files from tournament results
2. Runs BayesElo with standard commands: `readpgn → elo → mm → exactdist → ratings`
3. Saves results to `tournament_results_universal/{standard,classic}/elo_ratings.csv`
4. Displays top 10 models for each variant

### Manual BayesElo Commands

If you need to run BayesElo manually:

```bash
cd ../../bayeselo/src  # Adjust path as needed
./bayeselo

# In BayesElo interactive prompt:
readpgn ../../wallgame/deep-wallwars/tournament_results_universal/standard/games.pgn
elo
mm
exactdist
ratings
x
```

Save to CSV for plotting:
```
offset 1500
ratings >../../wallgame/deep-wallwars/tournament_results_universal/standard/elo_ratings.csv
x
```

## Analysis Questions to Answer

### Primary Questions

1. **Did training improve the model?**
   - Is there a monotonic ELO increase from model_0 to model_58?
   - What is the total ELO gain over all generations?

2. **Where did improvement happen?**
   - Which generation ranges show the most gain?
   - Are there plateaus or regressions?

3. **How consistent is improvement across variants?**
   - Do Standard and Classic ELO curves track each other?
   - Does the model favor one variant over the other?

4. **Was the warm-start + freeze strategy effective?**
   - Do early models (0-3) show the expected pattern?
   - Model 0: Simple policy bootstrap (expected to be weak)
   - Models 1-3: Frozen body, only heads trained
   - Model 4+: Full fine-tuning

### Secondary Questions

5. **What is the ELO difference between best and worst?**
   - Needed to understand training impact magnitude

6. **Did specific training changes create jumps?**
   - Check if known training adjustments correlate with ELO changes

7. **Is there evidence of overfitting or catastrophic forgetting?**
   - Do later models ever regress significantly?

### Interpreting ELO Differences

From the tournament instructions (info/elo-tournament-instructions.md):

| ELO Difference | Win Rate | Interpretation |
|----------------|----------|----------------|
| +100 | ~64% | Moderate advantage |
| +200 | ~76% | Strong advantage |
| +300 | ~85% | Dominant |
| +400+ | ~90%+ | Overwhelming |

## Expected Output Files

**Note:** If you used `run_full_tournament.sh`, all these files are automatically generated!

```
deep-wallwars/tournament_results_universal/
├── standard/
│   ├── games.pgn              # BayesElo input (PGN format)
│   ├── games.json             # Detailed game records
│   ├── elo_ratings.txt        # Human-readable rankings
│   ├── elo_ratings.csv        # CSV for plotting
│   └── elo_progression.png    # ELO progression plot (auto-generated)
└── classic/
    ├── games.pgn
    ├── games.json
    ├── elo_ratings.txt
    ├── elo_ratings.csv
    └── elo_progression.png    # ELO progression plot (auto-generated)
```

## Plotting ELO Progression

**Note:** If you used `run_full_tournament.sh`, plots are already generated!

To regenerate plots manually:

```bash
cd deep-wallwars/scripts

python3 plot_elo.py ../tournament_results_universal/standard/elo_ratings.csv \
  --output ../tournament_results_universal/standard/elo_progression.png \
  --games 4000

python3 plot_elo.py ../tournament_results_universal/classic/elo_ratings.csv \
  --output ../tournament_results_universal/classic/elo_progression.png \
  --games 4000
```

## Troubleshooting

### Tournament Taking Too Long

**Symptom:** Games not finishing or extremely slow progress

**Solutions:**
1. Check if games are completing: `watch -n 5 'tail -5 deep-wallwars/build/logs/latest.log'`
2. Reduce `--samples` if games are too long (try 800 instead of 1200)
3. Add `--move_limit` if not set (default 100 should be fine for 12×10)

### BayesElo Not Found

**Symptom:** `calculate_elo.sh` fails to find BayesElo

**Solutions:**
1. Download BayesElo from: https://www.remi-coulom.fr/Bayesian-Elo/
2. Extract to `../bayeselo/` (relative to wallgame repo)
3. Build: `cd ../bayeselo/src && make`
4. Or update `BAYESELO_PATH` in `calculate_elo.sh`

### Out of Memory

**Symptom:** Tournament crashes with CUDA out of memory

**Solutions:**
1. Reduce parallelism: lower `-j` flag (try `-j 14`)
2. Reduce batch size in MCTS (may require code change)
3. Run variants sequentially instead of parallel

### Inconsistent Rankings

**Symptom:** ELO ratings seem noisy or counterintuitive

**Solutions:**
1. Increase tournament count (try 25-30 for more data)
2. Increase games per matchup (try 15 or 20)
3. Check for model loading issues in logs
4. Verify all `.trt` files are valid (not corrupted)

## Notes

- **First 12×10 tournament:** No baseline for comparison; performance characteristics may differ from 8×8
- **First universal tournament:** Multi-variant training adds complexity; results inform if universal approach is viable
- **Single-elimination structure:** Early eliminated models contribute less data; ELO confidence intervals will be wider for weak models
- **Variant independence:** Standard and Classic tournaments are completely separate; same model may rank differently

## Next Steps After Tournament

1. **Analyze results:** Compare ELO progressions, identify best model
2. **Select production model:** Choose based on:
   - Highest ELO (if consistent across variants)
   - Balance between variants (if one model excels at both)
   - Latest model with good performance (most representative of current training)

3. **Deploy to server:** Update bot client configuration to use selected model

4. **Document findings:** Create summary of:
   - Total ELO improvement
   - Best performing generation
   - Variant-specific insights
   - Recommendations for future training

5. **Plan next training iteration:**
   - If improvement plateaued: consider architecture changes
   - If improvement continued: extend training
   - If variant imbalance: adjust variant mix in training data
