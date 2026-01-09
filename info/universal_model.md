# Universal Model Training Strategy

This document describes the strategy for training a 12x10 universal model (plays both Standard and Classic variants) using warm-start from an 8x8 Standard model.

## Goal

Train a single neural network that can play both:
- **Standard variant**: Cats chase moving mice (8 move channels)
- **Classic variant**: Cats race to fixed goal corners (4 move channels, but model uses 8)

## Model Architecture

The model is a ResNet with 9 input planes:

| Plane | Description |
|-------|-------------|
| 0 | Player's pawn (cat) relative distance |
| 1 | Player's goal relative distance |
| 2 | Opponent's pawn (cat) relative distance |
| 3 | Opponent's goal relative distance |
| 4 | Right walls (blocked) |
| 5 | Down walls (blocked) |
| 6 | Second action in turn (1.0 if true) |
| 7 | Current player is Red (1.0 if true) |
| 8 | **Variant indicator**: 1.0 for Standard, 0.0 for Classic |

Output: `2 * cols * rows` wall priors + 8 move priors (4 cat + 4 mouse directions)

## Warm-Start Strategy

### Why Warm-Start?

Training from scratch on a 12x10 board would take significantly longer. An 8x8 model has already learned:
- Wall placement patterns
- Blocking strategies
- Spatial reasoning via convolutional features

### What Transfers Directly

| Layer Type | Transfer Method |
|------------|-----------------|
| All Conv2d layers | Direct copy (translation-invariant) |
| All BatchNorm2d layers | Direct copy |
| ResNet blocks | Direct copy |

### What Needs Spatial Remapping

The Linear layers in the priors and value heads are tied to board dimensions:

```
priors.4: Linear(32 * cols * rows, 2 * cols * rows + 8)
value.4:  Linear(32 * cols * rows, 1)
```

**Spatial embedding**: The 8x8 board is centered within the 12x10 board:

```
12 columns x 10 rows:

     col: 0   1   2   3   4   5   6   7   8   9  10  11
row 0:   [.] [.] [.] [.] [.] [.] [.] [.] [.] [.] [.] [.]  <- new
row 1:   [.] [.] [X] [X] [X] [X] [X] [X] [X] [X] [.] [.]  \
row 2:   [.] [.] [X] [X] [X] [X] [X] [X] [X] [X] [.] [.]  |
row 3:   [.] [.] [X] [X] [X] [X] [X] [X] [X] [X] [.] [.]  |
row 4:   [.] [.] [X] [X] [X] [X] [X] [X] [X] [X] [.] [.]  | 8x8 embedded
row 5:   [.] [.] [X] [X] [X] [X] [X] [X] [X] [X] [.] [.]  |
row 6:   [.] [.] [X] [X] [X] [X] [X] [X] [X] [X] [.] [.]  |
row 7:   [.] [.] [X] [X] [X] [X] [X] [X] [X] [X] [.] [.]  |
row 8:   [.] [.] [X] [X] [X] [X] [X] [X] [X] [X] [.] [.]  /
row 9:   [.] [.] [.] [.] [.] [.] [.] [.] [.] [.] [.] [.]  <- new

col_offset = (12 - 8) // 2 = 2
row_offset = (10 - 8) // 2 = 1
```

### Input Channel Expansion (8 -> 9)

The source model has 8 input channels (no variant indicator). The universal model needs 9.

**Solution**: Zero-initialize the 9th channel's conv weights. The model will learn to use the variant indicator during training.

### Random Initialization for New Positions

New boundary positions (the `[.]` cells above) have no corresponding weights in the source model.

**Critical for priors head**: These outputs go through softmax. If initialized too small relative to transferred weights, they'll never be selected.

**Solution**: Initialize new positions with `std = old_weights.std()` - matching the scale of existing weights.

## Training Loop Changes for Universal

### Half-and-Half Each Generation

Every generation runs self-play for **both variants** with half the games each:

```python
if args.variant == "universal":
    half_games = args.games // 2
    run_self_play(model, generation, "standard", games=half_games)
    run_self_play(model, generation, "classic", games=half_games)
```

**Why not alternate generations?**
- Early generations would only see one variant
- Model needs to learn the variant indicator (plane 8) from the start
- Training window accumulates data, but first few gens would be unbalanced

### Bootstrap with Simple Policy

Generation 0 uses the simple policy (walks toward goal) instead of the warm-started model for self-play:

**Why?**
- Warm-started model's pawn move weights are partially random (new boundary inputs)
- Random pawn moves on 12x10 board = games never end
- Simple policy ensures games complete and provides clear "move toward goal" signal

## Parameter Scaling for 12x10

The board grows from 64 cells (8x8) to 120 cells (12x10), roughly 1.9x larger.

| Parameter | 8x8 Value | 12x10 Recommendation | Rationale |
|-----------|-----------|---------------------|-----------|
| `--games` | 5000 | 7500-10000 | Larger state space needs more coverage |
| `--samples` | (default) | (default) | Games are longer, more samples per game naturally |
| `--hidden_channels` | 128 | 128 | Conv layers are size-independent |
| `--layers` | 10 | 10 | Model capacity should be sufficient |
| MCTS iterations | (in deep-ww) | Consider 1.5x | More moves to evaluate per position |

**What to monitor:**
- Game length: If games aren't finishing, something is wrong
- Move accuracy: If much lower than 8x8 was initially, increase games or MCTS iterations

## Command to Run Training

```bash
cd deep-wallwars/scripts
source ../.venv/bin/activate

python3 training.py \
  --columns 12 --rows 10 \
  --variant universal \
  --warm-start ../models_8x8_standard/model_49.pt \
  --warm-start-cols 8 --warm-start-rows 8 \
  --models ../models_12x10_universal \
  --data ../data_12x10_universal \
  --log ../logs/universal_12x10.log \
  --generations 40 \
  --games 8000
```

## Expected Output During Warm-Start

```
Warm-starting from ../models_8x8_standard/model_40.pt with board resize (8x8 -> 12x10)...
  Old model: 8x8, 8 move channels
  New model: 12x10, 8 move channels
  Spatial offset: col=2, row=1
  Copied start.0.weight (shape torch.Size([128, 9, 3, 3]))
  ... (all conv/bn layers)
  Skipped priors.4.weight: shape mismatch ...
  Skipped priors.4.bias: shape mismatch ...
  Skipped value.4.weight: shape mismatch ...
  Expanding start.0.weight input channels: 8 -> 9
  Transferring priors.4: (2048, 136) -> (3840, 248)
  Using weight std=0.0823 for new positions
  Transferring 8 move channel outputs (spatially remapped inputs)
  Transferring value.4: (2048, 1) -> (3840, 1)
  Using weight std=0.0156 for new positions
```

## Monitoring Training

Key metrics to watch:
- **valuation_accuracy**: Should start reasonable (~70%+) due to transferred conv layers
- **move_accuracy**: May start lower, will improve as model learns new board geometry
- **Game completion**: Ensure games are finishing (check log for average game length)

## Potential Issues

1. **Games not ending**: If pawn moves are too random, increase bootstrap generations or games
2. **Variant confusion**: If model plays wrong variant, check plane 8 is being set correctly
3. **Boundary walls never selected**: Check weight_std calibration is working
