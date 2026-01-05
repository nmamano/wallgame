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
