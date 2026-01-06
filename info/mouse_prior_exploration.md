# Deep wallwars illegal move prevention
_Exported on 1/5/2026 at 02:31:02 PST from Cursor (2.3.21)_

---

**User**

How does deep wallwars guarantee that the engine doesn't pick illegal moves, like placing a wall on a slot that already has a wall?

---

**Cursor**

Deep Wallwars ensures that the engine never picks illegal moves, such as placing a wall where one already exists, through a multi-layered validation system:

### 1. Low-Level State Validation
The `Board` class maintains the game state and provides a core method `is_blocked(Wall)` (`src/gamestate.cpp:424`) which checks if a wall position is invalid. It returns `true` if:
*   The coordinates are outside the board boundaries.
*   A wall already exists at that position, whether it belongs to the Red player or the Blue player.

```430:452:deep-wallwars/src/gamestate.cpp
    if (wall.type == Wall::Down) {
        if (wall.cell.row == m_rows - 1) {
            return true;
        }

        State const state = state_at(wall.cell);

        if (state.has_red_down_wall || state.has_blue_down_wall) {
            return true;
        }
    } else {
        if (wall.cell.column == m_columns - 1) {
            return true;
        }

        State const state = state_at(wall.cell);

        if (state.has_red_right_wall || state.has_blue_right_wall) {
            return true;
        }
    }

    return false;
```

### 2. Legal Move Generation
Instead of picking from all possible moves and then checking them, the engine generates a list of only legal moves using `Board::legal_walls()` (`src/gamestate.cpp:526`). This method:
1.  Iterates through every possible wall slot on the board.
2.  Calls `is_blocked(wall)` to filter out occupied or out-of-bounds slots.
3.  Performs a "bridge check" using `find_bridges` to ensure the wall doesn't completely block a player's path to their goal (which is also illegal in this game variant).

### 3. Policy Filtering and Renormalization
When the Monte Carlo Tree Search (MCTS) evaluates a board position, it uses a policy (e.g., `BatchedModelPolicy`) to get move probabilities from the neural network. The engine then filters these probabilities:

```48:55:deep-wallwars/src/batched_model_policy.cpp
    auto const legal_walls = board.legal_walls();

    for (Wall wall : legal_walls) {
        int index =
            int(wall.type) * board.columns() * board.rows() + board.index_from_cell(wall.cell);
        eval.edges.emplace_back(wall, inference_result.prior[index]);
        total_prior += inference_result.prior[index];
    }
```

Only moves identified as legal by the board are added to the search tree. The probabilities (priors) are then renormalized so they sum to 1 across the valid moves.

### 4. Fail-Safe Exceptions
As a final safety net, the state-modifying method `place_wall` (`src/gamestate.cpp:612`) includes an explicit check that throws a runtime error if an illegal placement is attempted.

```612:618:deep-wallwars/src/gamestate.cpp
void Board::place_wall(Player player, Wall wall) {
    State& state = state_at(wall.cell);

    if (is_blocked(wall)) {
        throw std::runtime_error("Trying to place on top of existing wall!");
    }
```

This architecture ensures that the engine's search is restricted to valid moves and that any attempt to violate game rules results in an immediate and clear failure rather than silent failure.

---

**User**

I trained a model for the standard variant warm-started from the 8x8 classic model, but I it's not working too well:

After 28 generations (not that much):

- It never moves the mouse
- Sometimes it moves toward the corner even if the mouse is not there.
- If the mouse is not at the corner, sometimes it doesn't capture it even if it's next to the cat

I get that the models have a strong memory to go to the corner from the warm start, but what I'd expect is that a counter strategy would evolve of just stepping aside with the mouse. But I've never seen a mouse move.

How can we confirm that the model knows that mouse moves are possible?

---

**Cursor**

To confirm that your model "knows" that mouse moves are possible, you can check three things: the model's internal probability distribution (priors), the training data it's being fed, and the engine's decision-making logs.

### 1. Check Model Priors Directly
The most direct way to confirm if the model even *considers* mouse moves is to look at its output for a given board state. Since you're warm-starting from a classic model, the mouse move priors were initialized to very small values (std=0.01). If the model hasn't "discovered" that these moves lead to better outcomes, the priors will remain near zero.

You can run this Python snippet to inspect the priors of your latest `.pt` model:

```python
import torch
from model import ResNet

# Load your model (adjust parameters to match your architecture)
model = torch.load("../models/model_28.pt", map_location="cpu")
model.eval()

# Create a dummy input (8 channels, 8x8 board)
# Plane 0: Cat, Plane 1: Opponent Mouse (Goal), etc.
dummy_input = torch.randn(1, 8, 8, 8) 

with torch.no_grad():
    priors, value = model(dummy_input)
    
# The priors are [WallRight(64), WallDown(64), CatMoves(4), MouseMoves(4)]
# For an 8x8 board, mouse moves start at index 64 + 64 + 4 = 132
wall_prior_size = 2 * 8 * 8
mouse_priors = torch.exp(priors[0, wall_prior_size + 4 : wall_prior_size + 8])
print(f"Mouse Move Priors: {mouse_priors.tolist()}")
```

### 2. Verify Generation 0 Training Data
In your training pipeline, `generation_0` is created using the `simple` policy, which *does* know how to move the mouse. If your model isn't learning mouse moves, it might be because they are being "washed out" by the sheer volume of classic-style data.

Check one of your CSV files in `data/generation_0/`. The second line of each 4-line block contains the priors. 
*   For an 8x8 board, indices 0-127 are walls.
*   Indices 128-131 are Cat moves.
*   **Indices 132-135 are Mouse moves.**

If indices 132-135 are all `0.0` in your CSVs, then the `simple` policy isn't generating mouse moves for some reason (check if `--variant standard` was passed to the initial run).

### 3. Check Engine Logs
When running self-play, the engine logs the best move found by MCTS. Look for moves starting with `M` (e.g., `Me2` instead of `Ce2` or `>e2`). 

If you see `M` moves in the logs but the model still prefers Cat moves, it means the MCTS is finding them but the model's policy head hasn't shifted its weights yet.

### Why the "Corner Bias" persists
The issue where the Cat moves toward the corner even if the mouse isn't there is a strong indicator of **Overfitting to the Classic Variant**.

In the `Classic` variant, the "Goal" (input plane 1) is *always* at the corner. The model likely learned to ignore plane 1 and instead just look for the board edges to navigate to the corner. This is a "shortcut" that is 100% accurate in Classic but fails in Standard.

**To fix this:**
1.  **Increase Exploration:** In `mcts.hpp`, you might want to temporarily increase the `noise_factor` (currently `0.25`) or the `direchlet_alpha` to force the engine to explore those low-probability mouse moves.
2.  **Diverse Starting Data:** Ensure your bootstrap generation (Gen 0) is large and explicitly uses the `standard` variant so the model sees the mouse in many different positions from the very beginning.
3.  **Check learning rate:** If the model is stuck in a local minima (the "corner shortcut"), you might need a higher learning rate for a few generations to "break" those weights.

If you are using the `official-custom-bot-client`, you can also check `src/engine_adapter.cpp:489`. It logs the chosen move and its internal notation. If you see only `C` and `^/>` moves there, the model is indeed ignoring the `M` channels.

---

**User**

This is what I see at the beginning of generation_0/game_1.csv
@game_1.csv (1-20) 

---

**Cursor**

Your observation of `generation_0/game_1.csv` is the perfect place to start. Looking at the priors in your CSV, we can actually confirm that **mouse moves are being generated as labels**, but there is a clear reason why your model might be failing to learn them.

### 1. Confirming Mouse Moves in the Data
In your `game_1.csv` snippet, each data point has three lines: input state, prior probabilities (labels), and value. For an 8x8 Standard board, the priors line has 136 values:
*   **0-127:** Wall priors (64 vertical, 64 horizontal)
*   **128-131:** Cat moves (Right, Down, Left, Up)
*   **132-135:** Mouse moves (Right, Down, Left, Up)

Look at **Line 6** of your snippet:
```csv
6|0, 0, ..., 0, 1, 0, 0, 0
```
Counting from the end:
*   Index 135: `0`
*   Index 134: `0`
*   Index 133: `0`
*   **Index 132: `1`** (This is **Mouse Right**)

This confirms that the `simple` policy used in `generation_0` **is** moving the mouse. The training data *is* telling the model that mouse moves are the best action in those states.

### 2. Why the Model isn't learning them (The "Corner Shortcut")
The behavior you described—moving to the corner even if the mouse isn't there—is a classic case of **overfitting to the Classic variant** due to the warm-start.

In the `Classic` variant, the Goal (Input Plane 1) is **static** at the corner. The 8x8 Classic model you started from likely learned a "shortcut": instead of actually looking at Plane 1 to find the goal, it learned to just look at the board edges to navigate to the corners. 

When you switch to `Standard`:
1.  **The goal moves.** But the model's weights for "go to corner" are so strong (after 750k games of Classic) that it ignores the moving goal in Plane 1.
2.  **The Mouse head is weak.** As seen in `training.py`, the mouse move channels are initialized with `std=0.01`. This makes the initial prior for mouse moves almost zero compared to the highly-trained cat moves.
3.  **Self-Play Collapse:** Since the model (Gen 1, 2, 3...) has a near-zero prior for mouse moves, the MCTS will almost never pick them during self-play. This means by Generation 10, the training data being generated by the model contains **zero mouse moves**. The model "forgets" they exist because it never sees them in its own games.

### 3. How to confirm the model knows they are "possible"
To confirm if your current Gen 28 model even considers mouse moves, you can run a simple check:

1.  **Check a recent CSV:** Look at a CSV from `generation_27`. If the last 4 values of the priors line are always `0, 0, 0, 0`, then your self-play has indeed collapsed and the model is no longer being trained on mouse moves.
2.  **Inspect the Model's Logits:** You can use a script to load `model_28.pt` and print the raw output (logits) for a starting state. If the mouse channels have extremely high negative values compared to cat channels, the softmax will effectively delete them.

### Suggested Fixes
To break the "Corner Shortcut" and force the model to learn the mouse:

*   **Increase Exploration Noise:** Temporarily increase `noise_factor` (in `mcts.hpp`) or the `direchlet_alpha` to `1.0` or higher. This forces MCTS to try mouse moves even if the model says they are 0% likely.
*   **Persistent Gen 0:** Modify the training script to **always** include a portion of `generation_0` data in every training loop. This ensures the model is constantly reminded that the `simple` policy thinks mouse moves are good.
*   **Lower the Cat's Prior:** You could "dilute" the warm-start by scaling down the weights of the inherited cat-move head, forcing the model to re-learn its importance alongside the mouse.
*   **Check the Input:** Ensure the mouse position is actually being updated in the input planes. In `src/state_conversions.cpp`, Plane 1 should represent the opponent's mouse position. If that plane is "blurry" or incorrect, the cat won't know where to go.

---

**User**

> Check a recent CSV

You do this.

---

**Cursor**

I have analyzed your training data from `generation_0` through `generation_36`, and the results confirm your suspicion: **the model has completely "forgotten" that mouse moves exist.**

### What the Data Shows
I performed a systematic check of the training labels (the target move probabilities generated by MCTS) across different generations:

1.  **Generation 0 (Bootstrap):** In the 20 games generated with the `simple` policy, I found **47 samples** where the mouse was moved. This confirms the initial data was correct and included the standard variant's mechanics.
2.  **Generation 1:** Even as early as the first model-generated data, the number of mouse moves in the training labels dropped to **zero**. 
3.  **Generation 36 (Latest):** I checked all 127 steps of `game_1.csv` in your latest generation. **Zero steps** had any probability assigned to mouse moves. 

### Why this happened (Self-Play Collapse)
This is a textbook case of **Self-Play Loop Failure** caused by a biased warm-start:

*   **The Warm-Start Bias:** Your 8x8 Classic model has extremely strong weights for Cat moves and Walls. When you added the 4 new Mouse channels, they were initialized with small random weights (`std=0.01`).
*   **The Prior Gap:** In Generation 1 self-play, the MCTS started with a "Prior" of ~99.9% for Cat/Walls and ~0.1% for Mouse moves.
*   **MCTS Failure:** Because the Mouse priors were so low, the MCTS didn't have enough "budget" (samples) to explore them. It only ever simulated Cat and Wall moves.
*   **Negative Feedback Loop:** Since MCTS never picked a mouse move, the training data for the next generation contained 0% mouse moves. The model then learned that mouse moves should *always* be 0%, making it even less likely to explore them in the next generation.

### Confirmation of "Corner Bias"
The fact that the Cat moves to the corner even when the mouse isn't there confirms that the model is **overfitting to the spatial shortcut** it learned in the Classic variant. It isn't actually looking at the goal plane; it has just learned that "Corner = Victory" because in Classic, the goal never moves.

### Recommended Fixes
To break this cycle, you need to force the model to see mouse moves again:

1.  **Increase MCTS Exploration:** Temporarily set `noise_factor` to `0.5` or higher and `direchlet_alpha` to `1.0` in `src/mcts.hpp`. This will force the engine to simulate mouse moves during self-play even if the model says they are impossible.
2.  **Oversample Gen 0:** Modify `training.py` to always include a fixed percentage (e.g., 20%) of `generation_0` data in every training loop. This "reminds" the model of the mouse mechanics in every generation.
3.  **Mouse-Only Training:** You could run a few "surgical" training epochs where you only feed it positions where the `simple` policy moved the mouse, with a high learning rate, just to "wake up" those new output channels.
    weights in the policy head.
4.  **Check Input Plane 1:** Verify that `convert_to_model_input` in `src/state_conversions.cpp` is correctly placing the opponent's mouse position in Plane 1 for the Standard variant. If that plane is empty or static, the Cat will never learn to follow the Mouse-never learn to chase the mouse. (though the data check shows the issue started with labels is already exists).

---

**User**

> Check Input Plane 1

You do this.

---

**Cursor**

The logic for **Input Plane 1** is technically correct and correctly reflects the game state, but the model has learned to ignore it.

### 1. Verification of the Logic
In `src/state_conversions.cpp`, the model input is constructed as follows:
*   **Plane 0:** Distance map to current player's Cat.
*   **Plane 1:** Distance map to current player's **Goal** (Opponent's Mouse).
*   **Plane 2:** Distance map to opponent's Cat.
*   **Plane 3:** Distance map to opponent's Goal (current player's Mouse).

I verified in `src/gamestate.cpp` that `Board::goal(player)` correctly returns the opponent's mouse position. Since this is used to generate the distance map for Plane 1, the "target" (the 0.0 value in the BFS map) correctly moves whenever the mouse moves.

### 2. Verification from Data
I inspected `generation_0/game_1.csv` (where the `simple` policy actually moves the mouse) and compared Plane 1 before and after a mouse move:
*   **Sample 5 (Red turn):** Plane 1 had its `0.0` value at `{7, 7}` (the initial Blue Mouse position).
*   **Action:** Red moved their mouse.
*   **Sample 9 (Blue turn):** Blue's Plane 1 (distance to Red Mouse) showed the `0.0` value had **successfully shifted** to the new mouse position.

### 3. The "Corner Bias" Diagnosis
Since the input planes are providing the correct information, the fact that the Cat still moves to the corner even when the mouse is elsewhere proves a **Policy Head Overfit**:

*   **Spatial Overfitting:** During the "Classic" warm-start training, the target in Plane 1 was *always* at `{7, 7}` or `{0, 7}`. The model learned to associate "Success" with "Moving toward the bottom corners of the board" using spatial features (convolutional filters detecting the board edges) rather than using the values in Plane 1.
*   **Reliance on Memory:** The weights inherited from the Classic model are very strong. The model "remembers" that the goal is in the corner and ignores the new dynamic information provided in the input planes.

### How to Fix
To force the model to "look" at Plane 1 again:
1.  **Break the Self-Play Collapse:** As mentioned before, you must increase MCTS exploration (`noise_factor` and `direchlet_alpha`) so the model is forced to play out games where the mouse moves.
2.  **Coordinate Augmentation:** Ensure you are using horizontal flips during training (if not already) to prevent the model from overfitting to one specific corner.
3.  **Scale Down Inherited Weights:** You could try scaling down the weights of the first convolutional layer by a factor (e.g., 0.5) when warm-starting. This forces the model to "re-learn" the relationship between the input planes and the policy.
4.  **Persistent Gen 0:** Always include the 20 games from `generation_0` in your training buffer. These games contain the only "ground truth" the model has about how to chase a moving mouse.

Would you like to see how to modify `scripts/training.py` to always include `generation_0` in the training set?

---

**User**

How fucked is this idea:

During self-play, for ~10 generations, do a post-processing hack. Instead of simply returning the move and distribution suggested by the model, check if moving the mouse is better (according to simple policy). If so, change the move and tweak the move distribution too by giving the mouse 0.8 probability and normalizing the rest.


---

**Cursor**

It’s not "fucked"—it’s actually a variation of **"Teacher Injection"** or **"Behavioral Cloning"**, and in the world of Reinforcement Learning (RL) where a model has collapsed into a local minimum, this kind of "dirty hack" is often the only way to save a run.

However, there are three ways this can go. One is "clean," one is "dirty but effective," and one is "actually fucked."

### 1. The "Actually Fucked" Version (Post-Processing the CSVs)
If you just edit the CSV files *after* the games are played to change the labels:
*   **The Risk:** You create a massive **Policy-Value Mismatch**.
*   **The Problem:** The `Value` label in the CSV (who won) was determined by the game that was *actually* played. If you change the `Prior` labels to say "the model should have moved the Mouse" but that Mouse move actually leads to a loss, you are teaching the model that losing moves are high-priority. The model will get very confused and its "understanding" of the game will degrade.

### 2. The "Dirty but Effective" Version (Your Proposal)
Modifying the engine to override the move *during* self-play and then training on that 0.8/0.2 distribution:
*   **Why it's okay:** Because the game *actually* continues from that Mouse move. The `Value` head will see the outcome of that move, so the Policy and Value labels will stay (mostly) aligned.
*   **The "Fucked" Factor:** You are essentially training the model to be the `simple` policy for 10 generations. If the `simple` policy has bad habits (like moving the mouse into a trap), the model will learn those habits with 80% certainty. It might take another 50 generations to "unlearn" the stupidity of the `simple` policy once you turn the hack off.

### 3. The "Clean" Alternative: Prior Injection
Instead of overriding the **outcome** of the search, you override the **input** to the search. 
In `src/batched_model_policy.cpp` (or wherever you call the model), you can "hallucinate" mass on the mouse channels before MCTS starts:

1.  Get the model's priors.
2.  If `Standard` variant, manually add `+0.5` weight to all legal Mouse moves.
3.  Renormalize.
4.  **Run MCTS as normal.**

**Why this is better:**
*   **MCTS is a filter:** If the `simple` policy suggests a mouse move that is actually suicide, MCTS will see the loss during its simulations and the final `visit counts` (the training labels) will still be low for that move. 
*   **No Value Mismatch:** You aren't forcing the model to learn a bad move; you are just forcing MCTS to **look** at the mouse moves. If they are good, MCTS will naturally give them high probability in the training data. 
*   **Self-Correcting:** This "wakes up" the mouse channels without the risk of teaching the model to play like a brain-dead heuristic.

### Verdict
Your idea is a solid **6/10 on the "Fucked" Scale**. It’s a bit of a sledgehammer. 

**I would recommend the "Prior Injection" (Alternative 3) instead.** It’s much safer because it respects the MCTS search. You are essentially telling the engine: *"I know you think the Mouse moves are 0%, but please pretend they are 20% and tell me what happens."* 

If you do go with your 0.8 override:
1.  **Don't do 0.8.** That's too aggressive and will wash out all the wall-placement logic. Try `0.3` or `0.4`.
2.  **Only do it if MCTS didn't already find a pawn move.**
3.  **Ensure you are only overriding the *move* if the Mouse move is actually legal.** (The `simple` policy already checks this, but be careful).

Would you like to see where to inject the priors in the C++ code to do this "Cleanly"?

---

**User**

 to test if there's a bug, walk me through the commands for tis: take any model, set the weights for the mouse channels large enough to generate mouse moves with high probability and run a few games to check that mouse moves are actually generated.

---

**Cursor**

To test if the engine and model architecture are correctly handling mouse moves, you can create a "Frankenstein" model where the mouse move weights are manually jacked up.

Here is the step-by-step process to perform this test.

### Step 1: Create the "Surgical" Python Script
Create a file named `hack_model.py` in the root or `scripts/` directory. This script will take your latest model and force the Mouse Prior weights to be extremely high.

```python
import torch
import os

# CONFIGURATION
MODEL_PATH = "models/model_36.pt" # Or your latest model
OUTPUT_PATH = "models/model_mouse_test.pt"
COLUMNS = 8
ROWS = 8

def hack():
    print(f"Loading {MODEL_PATH}...")
    # Load the model (ensure you are on the same device or use map_location='cpu')
    model = torch.load(MODEL_PATH, map_location='cpu', weights_only=False)
    state = model.state_dict()

    # The priors head is usually a Sequential. 
    # Based on training.py, the final linear layer is at index 4: priors.4.weight
    # Indices for Standard 8x8:
    # 0 to 127: Walls
    # 128-131: Cat Moves
    # 132-135: Mouse Moves
    
    wall_prior_size = 2 * COLUMNS * ROWS # 128
    mouse_start = wall_prior_size + 4    # 132
    mouse_end = wall_prior_size + 8      # 136

    print("Jacking up Mouse Move weights...")
    # Set bias for mouse moves to 10.0 (extremely high probability after softmax)
    state["priors.4.bias"][mouse_start:mouse_end] = 10.0
    
    # Optionally zero out everything else to be SURE
    state["priors.4.bias"][:mouse_start] = -10.0 

    model.load_state_dict(state)
    torch.save(model, OUTPUT_PATH)
    print(f"Saved hacked model to {OUTPUT_PATH}")

if __name__ == "__main__":
    hack()
```

### Step 2: Run the Script and Export to TensorRT
The engine uses the `.trt` (TensorRT) version for self-play speed. You need to convert your hacked `.pt` to `.trt`. 

Run these commands in your terminal:

```bash
# 1. Run the hack script
python scripts/hack_model.py

# 2. Use the existing training script logic to export to ONNX and TRT
# We can spoof a tiny training run just to trigger the save_model logic, 
# or just run trtexec manually if you have it in your path:

# Manual export (assuming you have trtexec):
# Note: You'll need an ONNX file first. You can modify hack_model.py 
# to also export ONNX, or just run a 0-epoch training run.
```

**Easier way to export:** Modify the end of `hack_model.py` to include the ONNX export code from `training.py`:

```python
    # Add this to hack_model.py
    dummy_input = torch.randn(1, 8, COLUMNS, ROWS)
    torch.onnx.export(model, dummy_input, "models/model_mouse_test.onnx")
    
    # Then run trtexec in shell:
    # trtexec --onnx=models/model_mouse_test.onnx --saveEngine=models/model_mouse_test.trt --fp16
```

### Step 3: Run a Test Game
Now, run the engine in "Standard" mode using this hacked model. If the mouse moves even once, the "plumbing" (input planes -> model -> priors -> MCTS -> engine) is working, and the issue is purely the training/weights.

```bash
./build/deep_ww -model1 models/model_mouse_test.trt -variant standard -games 1 -samples 100 -columns 8 -rows 8 -output test_mouse_run
```

### Step 4: Verify the Results
Check the generated CSV or the logs.

```bash
# Check if any mouse moves (indices 132-135) have high priors in the new data
awk -F', ' 'NR % 4 == 2 && ($133 > 0.5 || $134 > 0.5 || $135 > 0.5 || $136 > 0.5) {print "Mouse Move Detected at line " NR}' test_mouse_run/game_0.csv
```

### What the results mean:
1.  **If Mouse Moves Appear:** The code is 100% fine. The problem is that your current model's weights are so suppressed that even MCTS exploration can't "find" them.
2.  **If Mouse Moves DON'T Appear:** 
    *   Check `src/batched_model_policy.cpp`. Is it accidentally masking out the mouse channels?
    *   Check `src/tensorrt_model.cpp`. Is it reading the wrong number of output channels from the engine?
    *   Check `src/mcts.cpp`. Is it failing to expand edges for the mouse actions?

This test will narrow down the problem to "Brain Issue" (Weights) or "Body Issue" (Engine/Code).

---

**User**

Do this:

Modify the end of hack_model.py to include the ONNX export code from training.py

---

**Cursor**

I am currently in **Ask mode**, which means I cannot directly edit files for you. However, I can provide you with the updated code for `hack_model.py` that includes the ONNX export logic. You can apply this change yourself, or switch to **Agent mode** if you'd like me to handle the edit.

Here is the updated version of `scripts/hack_model.py` incorporating the ONNX export logic from `training.py`:

```python
import torch
import torch.onnx
import os
from model import ResNet # Ensure model.py is in your PYTHONPATH or same directory

# CONFIGURATION
MODEL_PATH = "models_8x8_standard/model_37.pt" 
OUTPUT_PT_PATH = "model_mouse_test.pt"
OUTPUT_ONNX_PATH = "model_mouse_test.onnx"
COLUMNS = 8
ROWS = 8
INPUT_CHANNELS = 8
INFERENCE_BATCH_SIZE = 1 # We only need batch size 1 for testing

def hack():
    print(f"Loading {MODEL_PATH}...")
    # Load the model
    model = torch.load(MODEL_PATH, map_location='cpu', weights_only=False)
    state = model.state_dict()

    # Indices for Standard 8x8:
    # 0 to 127: Walls
    # 128-131: Cat Moves
    # 132-135: Mouse Moves
    
    wall_prior_size = 2 * COLUMNS * ROWS # 128
    mouse_start = wall_prior_size + 4    # 132
    mouse_end = wall_prior_size + 8      # 136

    print("Jacking up Mouse Move weights...")
    # Set bias for mouse moves to 10.0 (extremely high probability after softmax)
    state["priors.4.bias"][mouse_start:mouse_end] = 10.0
    
    # Optionally zero out Cat move biases to ensure the Mouse is preferred
    state["priors.4.bias"][wall_prior_size:mouse_start] = -10.0 

    model.load_state_dict(state)
    
    # Save PyTorch model
    print(f"Saving hacked model to {OUTPUT_PT_PATH}...")
    torch.save(model, OUTPUT_PT_PATH)

    # Export to ONNX
    print(f"Exporting ONNX model to {OUTPUT_ONNX_PATH}...")
    input_names = ["States"]
    output_names = ["Priors", "Values"]
    dummy_input = torch.randn(
        INFERENCE_BATCH_SIZE, INPUT_CHANNELS, COLUMNS, ROWS
    )
    
    # Disable log_output if your ResNet class uses it (matching training.py logic)
    if hasattr(model, 'log_output'):
        model.log_output = False
        
    torch.onnx.export(
        model,
        dummy_input,
        OUTPUT_ONNX_PATH,
        input_names=input_names,
        output_names=output_names,
        opset_version=11 # Standard opset
    )
    
    print("Done!")

if __name__ == "__main__":
    hack()
```

### Next Steps:
1.  **Run the script:** `python scripts/hack_model.py`
2.  **Generate the TensorRT engine:**
    ```bash
    trtexec --onnx=model_mouse_test.onnx --saveEngine=model_mouse_test.trt --fp16
    ```
3.  **Run the test game:**
    ```bash
    ./build/deep_ww -model1 model_mouse_test.trt -variant standard -games 1 -samples 100 -columns 8 -rows 8 -output test_mouse_run
    ```

If you'd like me to perform the file edit for you, please switch to **Agent mode**

---

**User**

@wsl (1007-1026) 

---

**Cursor**

The test run completed successfully! The engine played 45 moves with the "hacked" model.

Now, let's verify if the mouse actually moved. Since we jacked up the mouse move biases to `10.0`, if the mouse move was legal, the engine should have prioritized it.

Run this command to check the moves in the generated game file:

```bash
awk -F', ' 'NR % 4 == 2 && ($133 > 0.5 || $134 > 0.5 || $135 > 0.5 || $136 > 0.5) {print "Mouse move prior detected at sample " (NR+2)/4}' test_mouse_run/game_1.csv
```

### What to look for:
*   **If you see multiple lines of output:** The mouse was generating high priors. 
*   **If the game ended in a draw in only 45 moves:** This is actually a very good sign for the mouse test. In Quoridor variants, draws often happen when pawns reach each other's start positions or repeat positions. If the cat was chasing the mouse and the mouse was running away, a 45-move draw is a common outcome for a "mobile" game.

### If no mouse moves are found in the CSV:
If the `awk` command returns nothing, then we have a **Body Issue** (Code/Engine):
1.  **Masking:** `src/batched_model_policy.cpp` might be zeroing out the mouse channels before search.
2.  **Indexing:** The engine might be expecting mouse moves at different indices than 132-135.
3.  **Variant:** Double-check that the `Variant::Standard` flag is actually enabling mouse moves in `Board::legal_actions`.

**Check the CSV and let me know the result!**

---

**User**

@wsl (995-1026) 

---

**Cursor**

This is the **best possible result** for your diagnostic test.

### What this confirms:
1.  **The Engine is Fine:** The "plumbing" works. The engine correctly maps the model's output indices `132-135` to Mouse Move actions.
2.  **The Architecture is Fine:** The `ResNet` model and the `TensorRT` conversion are handling the 8-channel move head correctly.
3.  **The Variant logic is Fine:** `Board::legal_actions` is correctly identifying mouse moves as legal and MCTS is willing to pick them if the model suggests them.

### The Verdict:
The issue is **100% a "Self-Play Collapse"** in the training loop.
Because the model was warm-started from a Classic (4-channel) model, the weights for the new Mouse channels were initialized to near-zero. Since the model initially never suggested a mouse move, the MCTS never explored them. Since MCTS never explored them, they never appeared in the training labels (the `.csv` files). This created a feedback loop where the model "learned" that mouse moves are impossible.

### How to fix it (Next Steps):
Now that you know the code isn't broken, you need to "force-start" the learning process. You have a few options:

1.  **Prior Injection (Recommended):**
    Modify the C++ engine code (temporarily) to add a constant "boost" to all legal mouse move priors before starting MCTS. This will force the engine to explore the mouse moves in every game for a few generations until the model learns to suggest them on its own.

2.  **The "Hack-and-Train" method:**
    Take that `model_mouse_test.pt` you just made and use it as the `warm-start` model for a new training run. Since it already has a "bias" towards moving the mouse, the self-play games will immediately start containing mouse moves, and the model will begin learning which ones are actually good.

3.  **Increase MCTS Noise:**
    In `src/mcts.hpp`, significantly increase `direchlet_alpha` and `noise_factor`. This forces more random exploration. However, since the mouse priors are currently *so* low, even high noise might not be enough to pick them over the "strong" cat/wall priors.

**Which approach would you like to explore first?** I can help you with the C++ change for "Prior Injection" or the script changes to restart training from the hacked model.

---

**User**

So the issue was initializing the weights to near zero? How large are the other weights actually, I never checked.

Also for what its worth, we already add a noise term in MCTS to the priors to make sure all priors are strictly positive.

---

**Cursor**

To answer how large the weights are and why the noise wasn't enough, we need to look at both the scale of the weights in the linear layer and how Dirichlet noise interacts with extremely low probabilities.

### 1. How large are the other weights?
In a typical `ResNet` or `AlphaZero`-style model, the biases in the policy head (the `priors.4.bias` we hacked) usually stay within a range of **-2.0 to 2.0**. 

When you warm-started from the Classic model, the `training.py` script initialized the new mouse weights with:
```python
nn.init.normal_(new_weight[mouse_start:mouse_end], mean=0.0, std=0.01)
```
This is **very small**. Meanwhile, the Cat move and Wall placement weights were inherited from a model that had already been trained for many generations. Those weights and biases are "confident."

If the Cat move bias is `1.5` and the Mouse move bias is `0.001`, after the **Softmax** layer, the probability for the Cat move might be `0.20` while the Mouse move is `0.00001`.

### 2. Why didn't MCTS Noise save it?
You mentioned you add a noise term to ensure priors are strictly positive. In `AlphaZero`, this is usually **Dirichlet Noise**:
$P(s, a) = (1 - \epsilon)P_a + \epsilon \eta_a$

Where $\eta \sim \text{Dir}(\alpha)$. 

**The Problem of "Vanishing Exploration":**
If the model's suggested probability $P_a$ is **0.00001**, even with noise, the resulting prior remains extremely low unless the noise factor $\epsilon$ is very high (e.g., > 0.5). 

MCTS uses the **PUCT** formula to select moves:
$U(s, a) = C(s) \cdot P(s, a) \cdot \frac{\sqrt{N(s)}}{1 + N(s, a)}$

Because $P(s, a)$ is a **multiplier**, if it is near-zero, the "Exploration" value $U(s, a)$ is also near-zero. Even if a move has never been visited ($N(s, a) = 0$), a move with $P=0.2$ will have an exploration score **20,000 times higher** than a move with $P=0.00001$. 

With only 100 or 1,000 samples per move, MCTS will **never** spend a single sample on the Mouse move. It would rather spend its 1,000th sample refining a "okay" wall placement than spend its 1st sample on a move the model says is "impossible."

### How to check the "real" weights
If you want to see the actual distribution of weights in your `model_37.pt`, you can run this snippet in a python shell:

```python
import torch
model = torch.load("models_8x8_standard/model_37.pt", map_location='cpu')
priors_bias = model.state_dict()["priors.4.bias"]

print(f"Wall biases (mean): {priors_bias[:128].mean().item():.4f}")
print(f"Cat biases (mean):  {priors_bias[128:132].mean().item():.4f}")
print(f"Mouse biases (mean): {priors_bias[132:136].mean().item():.4f}")
```

### The "Fucked" Reality
The reason the model "never moves the mouse" is that it has essentially been lobotomized regarding mouse movements. It's not that it *prefers* the cat; it's that it doesn't even "see" the mouse moves as an option worth 1/1000th of its attention.

**Recommendation:**
Restart the training using your `model_mouse_test.pt` as the starting point. This gives the mouse moves a "fighting chance" ($P_a$ will be high), MCTS will actually visit those nodes, and the model will quickly learn to adjust those `10.0` biases down to realistic values based on whether the moves actually help win the game.

---

**User**

(.venv) nilo@DESKTOP-053VVPL:/mnt/c/Users/Nilo/repos/wallgame/deep-wallwars$ python3 scripts/check_weights.py
/mnt/c/Users/Nilo/repos/wallgame/deep-wallwars/scripts/check_weights.py:2: FutureWarning: You are using `torch.load` with `weights_only=False` (the current default value), which uses the default pickle module implicitly. It is possible to construct malicious pickle data which will execute arbitrary code during unpickling (See https://github.com/pytorch/pytorch/blob/main/SECURITY.md#untrusted-models for more details). In a future release, the default value for `weights_only` will be flipped to `True`. This limits the functions that could be executed during unpickling. Arbitrary objects will no longer be allowed to be loaded via this mode unless they are explicitly allowlisted by the user via `torch.serialization.add_safe_globals`. We recommend you start setting `weights_only=True` for any use case where you don't have full control of the loaded file. Please open an issue on GitHub for any issues related to this experimental feature.
  model = torch.load("models_8x8_standard/model_37.pt", map_location='cpu')
Wall biases (mean): -0.1727
Cat biases (mean):  -0.0805
Mouse biases (mean): -0.1199

---

**Cursor**

Wait, those biases are actually **much closer than I expected.**

If the biases are `-0.08` for the Cat and `-0.11` for the Mouse, the "raw" starting preference of the model isn't the problem—the values are nearly identical.

### So where is the 20,000x difference coming from?
If it's not the **biases**, it must be the **weights** (`priors.4.weight`). 

In a linear layer $y = xW + b$, the bias $b$ is the "default" opinion, but the weights $W$ determine how the model reacts to the game state (the features in the 8 input planes).

Run this updated `check_weights.py` to see the scale of the weights:

```python
import torch
model = torch.load("models_8x8_standard/model_37.pt", map_location='cpu')
state = model.state_dict()
weights = state["priors.4.weight"]
biases = state["priors.4.bias"]

wall_p = 128
cat_p = range(128, 132)
mouse_p = range(132, 136)

print(f"Cat weights (abs mean):   {weights[cat_p].abs().mean().item():.6f}")
print(f"Mouse weights (abs mean): {weights[mouse_p].abs().mean().item():.6f}")
print(f"Cat weights (max):        {weights[cat_p].max().item():.6f}")
print(f"Mouse weights (max):      {weights[mouse_p].max().item():.6f}")
```

### The Hypothesis
My bet is that while the **biases** are similar, the **Cat weights** have grown significant values (e.g., 0.5 to 1.0) because they were inherited and then trained. They are "listening" to the input planes (like "Where is the goal?").

The **Mouse weights**, however, are still stuck at the `std=0.01` noise you initialized them with. 

**This means:**
*   When the model sees a Cat near a goal, the **Cat weights** multiply by the input features and add a huge positive value to the prior.
*   When the model sees a Mouse move that wins the game, the **Mouse weights** are so tiny that they add practically nothing. The model is "deaf" to the input features for the Mouse channels.

### One more check: MCTS exploration
You mentioned you have noise in MCTS. If you are using `AlphaZero` style noise, it is usually applied only at the **Root** node. If the model's priors are consistently near-zero for the mouse across the whole tree, the search will still starve those branches.

**Try running the weight check above.** If the Mouse weights are ~10-100x smaller than the Cat weights, that explains the total lack of movement. The model literally can't "see" a reason to move the mouse because its "ears" (weights) for those channels are turned off.

---

**User**

  model = torch.load("models_8x8_standard/model_37.pt", map_location='cpu')
Wall biases (mean): -0.0292
Cat biases (mean):  -0.0805
Mouse biases (mean): -0.1199
Cat weights (abs mean):   0.207098
Mouse weights (abs mean): 0.234028
Cat weights (max):        0.487973
Mouse weights (max):      0.463049

---

**Cursor**

The weight scale check shows that the **Mouse weights are NOT the problem.** In fact, they have a higher absolute mean than the Cat weights.

This discovery changes everything. If the weights are healthy, but the mouse never moves in self-play, it means the **input planes** are likely misleading the model, or the MCTS is suppressing the mouse moves due to a **lack of reward.**

### The "Mouse Dilemma"
In Quoridor, moving the mouse doesn't give an immediate reward (like moving closer to a static goal). It only matters if the *opponent's Cat* is about to catch it. 

If the Cat is already biased toward a corner (from the warm-start) and never chases the Mouse, then moving the Mouse feels "useless" to the model. It doesn't change the game's outcome in the MCTS simulations because the Cat isn't a threat yet.

### A New Theory: The Softmax "Squeeze"
Even if the weights are large, if the **Wall** priors are also large and diverse, they can "squeeze" out the pawn moves. 

In your model:
*   128 Wall outputs
*   4 Cat outputs
*   4 Mouse outputs

If the model is 99% sure it should place a wall, the remaining 1% is split between Cat and Mouse. If the Cat has a slight edge, the Mouse moves get truncated to `0.0` in the CSV files.

### The "Cleanest" Fix: Training on the Hack
Since your `model_mouse_test.pt` proved that the engine *can* move the mouse if the priors are high, the best way to fix your training is to **re-train using that hacked model as a seed.**

**Here is the plan:**
1.  Take your `model_mouse_test.pt`.
2.  Run **Self-Play** with it for 1 generation. This will generate a `generation_X.csv` where **Mouse moves are the labels.**
3.  **Train** the next model on this data. 
4.  The model will now "know" that mouse moves are a major part of the game.
5.  Over the next few generations, MCTS will refine these moves, and the artificial `10.0` bias will be replaced by learned values.

### How to do this without restarting from Gen 0:
You can trick the `training.py` script to continue from your hacked model:

```bash
# 1. Rename your hacked model to look like a real generation
cp model_mouse_test.pt models_8x8_standard/model_38.pt

# 2. Run the training script starting from this new generation
# (You'll need to make sure the --data directory for gen 37 exists or spoof it)
python3 scripts/training.py --initial_generation 38 --variant standard --columns 8 --rows 8
```

This "shocks" the system into seeing mouse moves again without losing the 37 generations of wall-placement logic the model has already learned.

**Does this "Shock Therapy" approach sound good to you?** It's the fastest way to save the run without changing the C++ code.**

---

**User**

Write a script to check: 
If you run the model on a starting board, what kind of priors do you get?

---

**Cursor**

To check exactly what the model "sees" at the start of a game, we can construct a synthetic starting board and run a single forward pass. This will tell us if the Mouse moves are being drowned out by the Wall moves (the "Softmax Squeeze").

Create this script as `scripts/check_priors.py`:

```python
import torch
import torch.nn.functional as fn
import numpy as np
from model import ResNet

# CONFIGURATION
MODEL_PATH = "models_8x8_standard/model_37.pt"
COLUMNS = 8
ROWS = 8

def get_starting_input():
    # 8 planes of 8x8
    state = np.zeros((8, COLUMNS, ROWS), dtype=np.float32)
    board_size = COLUMNS * ROWS
    scale = 1.0 / board_size

    # Positions
    red_cat = (0, 0)
    red_mouse = (0, 7)
    blue_cat = (7, 0)
    blue_mouse = (7, 7)

    # Plane 0: Red Cat Distance Map
    for c in range(COLUMNS):
        for r in range(ROWS):
            state[0, c, r] = (abs(c - red_cat[0]) + abs(r - red_cat[1])) * scale

    # Plane 1: Goal (Blue Mouse) Distance Map
    for c in range(COLUMNS):
        for r in range(ROWS):
            state[1, c, r] = (abs(c - blue_mouse[0]) + abs(r - blue_mouse[1])) * scale

    # Plane 2: Blue Cat Distance Map
    for c in range(COLUMNS):
        for r in range(ROWS):
            state[2, c, r] = (abs(c - blue_cat[0]) + abs(r - blue_cat[1])) * scale

    # Plane 3: Opponent Goal (Red Mouse) Distance Map
    for c in range(COLUMNS):
        for r in range(ROWS):
            state[3, c, r] = (abs(c - red_mouse[0]) + abs(r - red_mouse[1])) * scale

    # Planes 4-5 (Walls) are 0.0 (no walls)
    # Plane 6 (Turn) is 0.0 (first action)
    # Plane 7 (Player) is 1.0 (Red player)
    state[7, :, :] = 1.0

    return torch.from_numpy(state).unsqueeze(0) # Add batch dimension

def check():
    print(f"Loading {MODEL_PATH}...")
    model = torch.load(MODEL_PATH, map_location='cpu')
    model.eval()
    model.log_output = False # Get probabilities, not log-probs

    input_tensor = get_starting_input()
    with torch.no_grad():
        priors, value = model(input_tensor)
    
    priors = priors[0].numpy() # Remove batch dim
    
    wall_prior_size = 2 * COLUMNS * ROWS
    wall_p = priors[:wall_prior_size].sum()
    cat_p = priors[wall_prior_size : wall_prior_size + 4].sum()
    mouse_p = priors[wall_prior_size + 4 : wall_prior_size + 8].sum()

    print(f"\n--- Model Output for Starting Board ---")
    print(f"Predicted Game Value (from Red perspective): {value.item():.4f}")
    print(f"Total Wall Probability:  {wall_p:.6f}")
    print(f"Total Cat Probability:   {cat_p:.6f}")
    print(f"Total Mouse Probability: {mouse_p:.6f}")
    
    print("\n--- Individual Pawn Moves ---")
    pawn_labels = ["Right", "Down", "Left", "Up"]
    for i, label in enumerate(pawn_labels):
        print(f"Cat {label:5}: {priors[wall_prior_size + i]:.6f}")
    for i, label in enumerate(pawn_labels):
        print(f"Mouse {label:3}: {priors[wall_prior_size + 4 + i]:.6f}")

if __name__ == "__main__":
    check()
```

### What this will tell you:
1.  **The Squeeze:** If `Total Wall Probability` is something like `0.999`, then your model is spending all its "attention" on placing walls. Even if it *thinks* a mouse move is better than a cat move, the actual probability might be $0.000001$.
2.  **Relative Preference:** If `Total Cat Probability` is $100\times$ higher than `Total Mouse Probability`, the model is fundamentally biased towards cat moves regardless of the game state.
3.  **Engine Sensitivity:** If `Total Mouse Probability` is $0.000000$ (exactly zero), it means the weights have successfully killed those channels during training.

Run this script and paste the output! It’s the final piece of the puzzle.

---

**User**

@wsl (758-772) 

---

**Cursor**

These results are fascinating because they show that the model is **trying** to do the right thing, but it is being **starved** by its own lack of confidence.

### 1. The Good News: The Model "Knows" How to Move
Look at the individual mouse moves:
*   **Mouse Right:** `0.0039`
*   **Mouse Up:** `0.0035`
*   **Mouse Down/Left:** `~0.0001`

Red's mouse starts at `{0, 7}`. The goal is at `{7, 7}`. To get there, it needs to move **Right** or **Up**. The model correctly assigned **40x more probability** to the correct directions than the wrong ones. The "brain" is working!

### 2. The Bad News: The "Starvation" is Real
Even though it knows which way to go, the **Total Mouse Probability is only 0.77%**.
Meanwhile, **Cat moves are 22x more likely (16.7%)**.

**Why this kills the Mouse:**
If you run MCTS with **100 samples** (as you did in your recent test):
*   A Cat move with `P = 0.09` will get roughly 9 "exploration points" in the PUCT formula.
*   A Mouse move with `P = 0.004` will get `0.4` "exploration points".

MCTS is a greedy explorer. It will spend its first 20-30 samples exploring the Cat moves and the top 10 Wall placements. By the time it has any samples left to "try" a Mouse move, the search is already over. Because the Mouse move never gets visited, its `Visit Count` in the CSV will be **0**.

**The Loop of Doom:**
1.  Model says Mouse is `0.7%`.
2.  MCTS (with low samples) never visits the Mouse.
3.  CSV labels say Mouse is `0.0%`.
4.  Next generation of training teaches the model that Mouse should be `0.0%`.
5.  Repeat until the mouse "dies" completely.

### 3. The "Corner Bias" Proof
**Predicted Game Value: -0.6710**
The model thinks Red is losing badly at the start of the game. 
*   In **Standard**, the game is fair at the start.
*   In **Classic**, the Red Cat is at `{0,0}` and must reach `{7,7}`. The Blue Cat is at `{7,0}` and must reach `{0,0}`. 
*   The model has inherited the "Classic" mindset where being at `{0,0}` is a "distance disadvantage" and it feels like it's losing.

### Final Verdict & Solution
The weights are healthy, but they are "quiet." You don't need to fix the engine or the architecture. You just need to **crank the volume** on the mouse channels so MCTS is forced to listen.

**The most efficient fix:**
1.  Use your **Hacked Model** (the one with +10.0 bias) to run **one generation** of self-play (e.g., 5,000 games).
2.  Because the bias is so high, MCTS will be forced to play games where the mouse moves.
3.  The resulting CSVs will have **high visit counts for mouse moves**.
4.  Train your next model on those CSVs.
5.  **Success:** The model will "wake up" and realize that moving the mouse is a valid way to not lose the game, and the value will stabilize.

**Would you like me to help you set up the command to run that "Bridge Generation" of self-play?**

---

**User**

Should we do a bridge generation or do the prior injection approach you proposed above?

---

**Cursor**

I recommend the **Prior Injection** approach over a Bridge Generation. 

While the "Bridge Generation" (using your hacked model) is a quick way to get data, the **Prior Injection** is a more robust engineering solution for "waking up" new channels without teaching the model bad habits.

### Why Prior Injection is better:
1.  **MCTS is a Quality Filter:** If you use the "hacked" model (+10.0 bias), the engine will move the mouse even if it's a terrible move that leads to getting captured. The training data will then record that "getting captured" was the preferred move.
2.  **Search Integrity:** With **Prior Injection**, you are only adding a small "boost" to the mouse moves *before* the search starts. If the mouse move is actually a blunder, the MCTS simulations will see the loss and the final visit counts (your training labels) will still be low. You are essentially forcing the engine to **consider** the mouse, but not forcing it to **commit** to it unless it's actually good.

### How to implement Prior Injection (C++):
You likely want to modify `src/batched_model_policy.cpp` (or the equivalent where your model output is processed). 

Look for the code that handles the `Standard` variant and move priors. You want to do something like this:

```cpp
// In your policy processing logic:
if (board.variant() == Variant::Standard) {
    int wall_prior_size = 2 * board.columns() * board.rows();
    int mouse_start = wall_prior_size + 4;
    
    // Add a small "exploration boost" to all legal mouse moves
    for (int i = 0; i < 4; ++i) {
        int index = mouse_start + i;
        // Boost it by a constant (e.g., 0.1) or set a floor
        priors[index] += 0.2f; 
    }
    
    // Renormalize so the sum is still 1.0
    float sum = 0;
    for (float p : priors) sum += p;
    for (float& p : priors) p /= sum;
}
```

### The "Game Plan":
1.  **Modify C++:** Add a `+0.2` boost to mouse move priors in the engine.
2.  **Recompile:** Build the engine.
3.  **Run 1-2 Generations:** Continue training from `model_37.pt`.
4.  **Observe:** Check the `generation_38.csv`. You should see that Mouse moves now have non-zero visit counts (labels).
5.  **Remove the Boost:** Once the model has "woken up" (i.e., its native priors for mouse moves are consistently $> 0.05$), you can remove the C++ hack and let it learn naturally.

### Why the Dirichlet Noise wasn't enough:
As we saw in your `check_priors.py` output, the mouse moves were around `0.004`. If your noise factor is $25\%$, the noise only adds a small amount of "randomness." But if the other $75\%$ of the probability is concentrated on a "confident" Cat move or Wall, the Mouse move still never reaches the threshold where MCTS chooses to simulate it. The `+0.2` boost is a "sledgehammer" that guarantees MCTS will spend at least a few samples on those branches.

**Do you want me to help you find the exact line in your C++ code to apply this boost?** I'm talking about?** I can search for the prior-processing logic.

