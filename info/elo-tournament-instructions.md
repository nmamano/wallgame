# Running ELO Tournaments for Deep Wallwars Models

This guide explains how to run ELO tournaments to compare model strength across training generations.

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
