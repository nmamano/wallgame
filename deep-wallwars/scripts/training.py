import subprocess
import argparse
import gc
import os
from pathlib import Path
print("Importing torch...")  # Print because it takes a while
import torch
import torch.onnx
import torch.nn as nn
import torch.functional as F
print("Importing fastai...")
from fastai.data.all import DataLoader, DataLoaders
from fastai.learner import Learner
from fastai.callback.schedule import lr_find
from model import ResNet
from data import get_datasets

default_cuda_device = "cuda:0"
input_channels = 9
bootstrap_epochs = 10

parser = argparse.ArgumentParser()
parser.add_argument(
    "--deep_ww", help="Path to deep wallwars executable", default="../build/deep_ww"
)
parser.add_argument("--models", help="Path to store the models", default="../models")
parser.add_argument("--data", help="Path to store training data", default="../data")
parser.add_argument("-c", "--columns", help="Number of columns", default=6, type=int)
parser.add_argument("-r", "--rows", help="Number of rows", default=6, type=int)
parser.add_argument(
    "--variant",
    help="Game variant (classic, standard, or universal)",
    default="classic",
)
parser.add_argument(
    "--warm-start",
    help="Path to a .pt model to warm-start training (can be different board size)",
    default="",
)
parser.add_argument(
    "--warm-start-cols",
    help="Columns of the warm-start model (required if different from target)",
    type=int,
    default=0,
)
parser.add_argument(
    "--warm-start-rows",
    help="Rows of the warm-start model (required if different from target)",
    type=int,
    default=0,
)
parser.add_argument(
    "--generations",
    help="Number of generations to train for",
    default=40,
    type=int,
)
parser.add_argument(
    "--initial_generation",
    help="Initial generation to start from (to continue previous run). You can use 'latest' to start from the latest generation in the models directory.",
    default="0",
    type=str,
)
parser.add_argument(
    "--training-batch-size",
    help="Batch size used during training",
    default=512,
    type=int,
)
parser.add_argument(
    "--inference-batch-size",
    help="Batch size used during inference (self-play)",
    default=256,
    type=int,
)
parser.add_argument(
    "--hidden_channels",
    help="Number of channels to use in the hidden layers of the ResNet",
    default=128,
    type=int,
)
parser.add_argument(
    "--layers",
    help="Number of layers in the ResNet",
    default=20,
    type=int,
)
parser.add_argument(
    "--max-training-window",
    help="Determines the maximum number of past generations used for training data",
    default=20,
    type=int,
)
parser.add_argument(
    "--training-games",
    help="Determines the maximum number of games used for training data",
    default=20000,
    type=int,
)
parser.add_argument(
    "--games",
    help="Number of games to play in one iteration of self play",
    default=5000,
    type=int,
)
parser.add_argument(
    "-s",
    "--samples",
    help="Number of samples to use per action during self play",
    default=1000,
    type=int,
)
parser.add_argument(
    "--epochs",
    help="Number of epochs to train per training loop",
    default=1,
    type=int,
)
parser.add_argument(
    "-j",
    "--threads",
    help="Number of threads to use for sample generation during self play",
    default=20,
    type=int,
)
parser.add_argument(
    "--log",
    help="Log file location",
    default="log.txt",
)
args = parser.parse_args()

variant_move_channels = {"classic": 4, "standard": 8, "universal": 8}
if args.variant not in variant_move_channels:
    print(f"Error: Unsupported variant '{args.variant}'. Use 'classic', 'standard' or 'universal'.")
    exit(1)
move_channels = variant_move_channels[args.variant]

def resolve_initial_generation(value: str) -> int:
    value = value.strip()
    if value == "latest":
        models_dir = args.models
        if not os.path.isdir(models_dir):
            print(f"Error: Models directory does not exist: {models_dir}")
            exit(1)

        latest = -1
        for filename in os.listdir(models_dir):
            if not filename.startswith("model_") or not filename.endswith(".pt"):
                continue
            stem = filename[len("model_") : -len(".pt")]
            if not stem.isdigit():
                continue
            latest = max(latest, int(stem))

        if latest < 0:
            print(
                "Error: --initial_generation latest requires at least one "
                f"'model_<N>.pt' in {models_dir}"
            )
            exit(1)

        return latest

    if not value.isdigit():
        print(
            f"Error: Invalid --initial_generation '{value}'. Use an integer or 'latest'."
        )
        exit(1)

    return int(value)


args.initial_generation = resolve_initial_generation(args.initial_generation)


def get_training_paths(generation):
    lb = max(generation - args.max_training_window, (generation - 1) // 2)
    if args.variant == "universal":
        # Include both variant directories for each generation
        paths = []
        for i in range(lb, generation):
            paths.append(f"{args.data}/generation_{i}_standard")
            paths.append(f"{args.data}/generation_{i}_classic")
        return paths
    return [f"{args.data}/generation_{i}" for i in range(lb, generation)]


def save_model(model, name, device):
    os.makedirs(args.models, exist_ok=True)
    
    pt_path = f"{args.models}/{name}.pt"
    onnx_path = f"{args.models}/{name}.onnx"
    trt_path = f"{args.models}/{name}.trt"

    print(f"Saving PyTorch model to {pt_path}...")
    torch.save(model, pt_path)
    input_names = ["States"]
    output_names = ["Priors", "Values"]
    dummy_input = torch.randn(
        args.inference_batch_size, input_channels, args.columns, args.rows
    ).to(device)
    model.log_output = False
    print(f"Exporting ONNX model to {onnx_path}...")
    torch.onnx.export(
        model,
        dummy_input,
        onnx_path,
        input_names=input_names,
        output_names=output_names,
    )
    print(f"Converting ONNX model to TensorRT engine ({trt_path})...")
    with open(args.log, "a") as f:
        subprocess.run(
            [
                "trtexec",
                f"--onnx={onnx_path}",
                f"--saveEngine={trt_path}",
                "--fp16",
            ],
            stdout=f,
            stderr=f,
        )
    model.log_output = True


def load_model(name, device):
    return torch.load(f"{args.models}/{name}.pt", weights_only=False).to(device)


def warm_start_model(path, device, expected_priors):
    wall_prior_size = 2 * args.columns * args.rows
    print(f"Warm-starting from {path}...")
    base_model = torch.load(path, weights_only=False, map_location=device)
    base_state = base_model.state_dict()

    model = ResNet(args.columns, args.rows, args.hidden_channels, args.layers, move_channels)
    state = model.state_dict()

    for key, value in base_state.items():
        if key in state and state[key].shape == value.shape:
            state[key] = value
        elif key == "start.0.weight" and state[key].shape[1] == input_channels and value.shape[1] == input_channels - 1:
            print(f"Expanding {key} from {value.shape[1]} to {state[key].shape[1]} channels")
            state[key].zero_()
            state[key][:, :value.shape[1], :, :] = value

    if "priors.4.weight" not in base_state or "priors.4.bias" not in base_state:
        print("Error: Warm-start model is missing the priors head.")
        exit(1)

    old_weight = base_state["priors.4.weight"]
    old_bias = base_state["priors.4.bias"]
    old_out = old_weight.shape[0]

    if old_out != wall_prior_size + 4 and old_out != wall_prior_size + 8:
        print("Error: Warm-start model does not look like a valid model.")
        print(f"Expected priors size {wall_prior_size + 4} or {wall_prior_size + 8}, found {old_out}.")
        exit(1)

    if expected_priors == old_out:
        state["priors.4.weight"] = old_weight
        state["priors.4.bias"] = old_bias
    else:
        new_weight = state["priors.4.weight"]
        new_bias = state["priors.4.bias"]
        new_weight.zero_()
        new_bias.zero_()
        new_weight[:old_out] = old_weight
        new_bias[:old_out] = old_bias

        if move_channels > 4 and old_out == wall_prior_size + 4:
            cat_start = wall_prior_size
            cat_end = wall_prior_size + 4
            mouse_start = wall_prior_size + 4
            mouse_end = wall_prior_size + move_channels

            nn.init.normal_(new_weight[mouse_start:mouse_end], mean=0.0, std=0.01)

    model.load_state_dict(state)
    return model.to(device)


def warm_start_model_resize(path, device, old_cols, old_rows, new_cols, new_rows, hidden_channels, layers, move_channels):
    """
    Warm-start from a model trained on a different board size.

    Transfers all conv/bn layers directly (they're size-independent).
    For Linear layers, embeds the old board spatially within the new board,
    preserving learned spatial relationships.

    The old board is centered within the new board:
    - col_offset = (new_cols - old_cols) // 2
    - row_offset = (new_rows - old_rows) // 2
    """
    print(f"Warm-starting from {path} with board resize ({old_cols}x{old_rows} -> {new_cols}x{new_rows})...")

    base_model = torch.load(path, weights_only=False, map_location=device)
    base_state = base_model.state_dict()

    # Infer old model's move channels from output size
    old_priors_out = base_model.priors[-1].out_features
    old_board_size = old_cols * old_rows
    old_move_channels = old_priors_out - 2 * old_board_size
    print(f"  Old model: {old_cols}x{old_rows}, {old_move_channels} move channels")
    print(f"  New model: {new_cols}x{new_rows}, {move_channels} move channels")

    # Create new model
    new_model = ResNet(new_cols, new_rows, hidden_channels, layers, move_channels)
    new_state = new_model.state_dict()

    # Calculate spatial offset (center the old board in the new board)
    col_offset = (new_cols - old_cols) // 2
    row_offset = (new_rows - old_rows) // 2
    print(f"  Spatial offset: col={col_offset}, row={row_offset}")

    # 1. Transfer all conv/bn layers directly (they're size-independent)
    for key, value in base_state.items():
        if key in new_state and new_state[key].shape == value.shape:
            new_state[key] = value.clone()
            print(f"  Copied {key} (shape {value.shape})")
        elif key in new_state:
            print(f"  Skipped {key}: shape mismatch {value.shape} -> {new_state[key].shape}")

    # 2. Handle input channel expansion (8 -> 9 channels for variant indicator)
    if "start.0.weight" in base_state:
        old_start = base_state["start.0.weight"]
        new_start = new_state["start.0.weight"]
        if old_start.shape[1] < new_start.shape[1]:
            print(f"  Expanding start.0.weight input channels: {old_start.shape[1]} -> {new_start.shape[1]}")
            new_state["start.0.weight"].zero_()
            new_state["start.0.weight"][:, :old_start.shape[1], :, :] = old_start

    # 3. Transfer priors Linear layer with spatial remapping
    _transfer_priors_linear(
        base_state, new_state,
        old_cols, old_rows, old_move_channels,
        new_cols, new_rows, move_channels,
        col_offset, row_offset
    )

    # 4. Transfer value Linear layer with spatial remapping
    _transfer_value_linear(
        base_state, new_state,
        old_cols, old_rows,
        new_cols, new_rows,
        col_offset, row_offset
    )

    new_model.load_state_dict(new_state)
    return new_model.to(device)


def _transfer_priors_linear(base_state, new_state,
                            old_cols, old_rows, old_move_channels,
                            new_cols, new_rows, new_move_channels,
                            col_offset, row_offset):
    """
    Transfer priors.4 Linear layer weights with spatial remapping.

    Input: 32 channels × (cols × rows) spatial positions
    Output: 2 × (cols × rows) wall positions + move_channels pawn moves
    """
    old_w = base_state["priors.4.weight"]
    old_b = base_state["priors.4.bias"]
    new_w = new_state["priors.4.weight"]
    new_b = new_state["priors.4.bias"]

    old_board_size = old_cols * old_rows
    new_board_size = new_cols * new_rows

    # Initialize with random values matching the source model's weight scale
    weight_std = old_w.std().item()
    print(f"  Transferring priors.4: ({old_w.shape[1]}, {old_w.shape[0]}) -> ({new_w.shape[1]}, {new_w.shape[0]})")
    print(f"  Using weight std={weight_std:.4f} for new positions")
    nn.init.normal_(new_w, mean=0.0, std=weight_std)
    nn.init.zeros_(new_b)

    # Build input index mapping: old_input_idx -> new_input_idx
    # Input layout: [ch0_pos0, ch0_pos1, ..., ch0_posN, ch1_pos0, ..., ch31_posN]
    input_map = {}
    for old_r in range(old_rows):
        for old_c in range(old_cols):
            new_c = old_c + col_offset
            new_r = old_r + row_offset
            old_pos = old_r * old_cols + old_c
            new_pos = new_r * new_cols + new_c
            for ch in range(32):
                old_idx = ch * old_board_size + old_pos
                new_idx = ch * new_board_size + new_pos
                input_map[old_idx] = new_idx

    # Build output index mapping for walls: old_output_idx -> new_output_idx
    # Output layout: [right_walls (board_size), down_walls (board_size), moves (move_channels)]
    output_map = {}
    for old_r in range(old_rows):
        for old_c in range(old_cols):
            new_c = old_c + col_offset
            new_r = old_r + row_offset
            old_pos = old_r * old_cols + old_c
            new_pos = new_r * new_cols + new_c

            # Right walls
            output_map[old_pos] = new_pos
            # Down walls (offset by board_size)
            output_map[old_board_size + old_pos] = new_board_size + new_pos

    # Transfer wall weights using the mappings
    for old_out_idx, new_out_idx in output_map.items():
        # Transfer bias
        new_b[new_out_idx] = old_b[old_out_idx]

        # Transfer weights for mapped input positions
        for old_in_idx, new_in_idx in input_map.items():
            new_w[new_out_idx, new_in_idx] = old_w[old_out_idx, old_in_idx]

    # Move channels: transfer if same count, otherwise leave as random init
    old_wall_size = 2 * old_board_size
    new_wall_size = 2 * new_board_size
    moves_to_transfer = min(old_move_channels, new_move_channels)

    if moves_to_transfer > 0:
        print(f"  Transferring {moves_to_transfer} move channel outputs (spatially remapped inputs)")
        for m in range(moves_to_transfer):
            old_out_idx = old_wall_size + m
            new_out_idx = new_wall_size + m

            # Transfer bias
            new_b[new_out_idx] = old_b[old_out_idx]

            # Transfer weights for mapped input positions
            for old_in_idx, new_in_idx in input_map.items():
                new_w[new_out_idx, new_in_idx] = old_w[old_out_idx, old_in_idx]


def _transfer_value_linear(base_state, new_state,
                           old_cols, old_rows,
                           new_cols, new_rows,
                           col_offset, row_offset):
    """
    Transfer value.4 Linear layer weights with spatial remapping.

    Input: 32 channels × (cols × rows) spatial positions
    Output: 1 (position evaluation)
    """
    old_w = base_state["value.4.weight"]
    old_b = base_state["value.4.bias"]
    new_w = new_state["value.4.weight"]
    new_b = new_state["value.4.bias"]

    old_board_size = old_cols * old_rows
    new_board_size = new_cols * new_rows

    # Initialize with random values matching the source model's weight scale
    weight_std = old_w.std().item()
    print(f"  Transferring value.4: ({old_w.shape[1]}, {old_w.shape[0]}) -> ({new_w.shape[1]}, {new_w.shape[0]})")
    print(f"  Using weight std={weight_std:.4f} for new positions")
    nn.init.normal_(new_w, mean=0.0, std=weight_std)

    # Transfer bias directly (only 1 value)
    new_b[0] = old_b[0]

    # Transfer weights with spatial remapping
    for old_r in range(old_rows):
        for old_c in range(old_cols):
            new_c = old_c + col_offset
            new_r = old_r + row_offset
            old_pos = old_r * old_cols + old_c
            new_pos = new_r * new_cols + new_c

            for ch in range(32):
                old_idx = ch * old_board_size + old_pos
                new_idx = ch * new_board_size + new_pos
                new_w[0, new_idx] = old_w[0, old_idx]


def run_self_play(model1, model2, generation, variant, boost_mouse_priors=False, games=None):
    """Run self-play to generate training data.

    Args:
        games: Number of games to play. If None, uses args.games.
    """
    if games is None:
        games = args.games
    os.makedirs(args.data, exist_ok=True)

    # For universal variant, separate output dirs per variant to avoid overwriting
    output_dir = f"{args.data}/generation_{generation}"
    if args.variant == "universal":
        output_dir = f"{args.data}/generation_{generation}_{variant}"

    # Check how many games already exist (resume partial generations)
    output_path = Path(output_dir)
    existing_files = list(output_path.glob("*.csv")) if output_path.exists() else []
    existing_games = len(existing_files)
    remaining_games = games - existing_games

    if remaining_games <= 0:
        print(f"Self-play (generation {generation}, {variant}): {existing_games} games already exist, skipping.")
        return

    # Find the max existing file number to continue numbering from
    max_file_num = 0
    for f in existing_files:
        try:
            num = int(f.stem.split("_")[1])  # game_123.csv -> 123
            max_file_num = max(max_file_num, num)
        except (IndexError, ValueError):
            pass
    start_game = max_file_num + 1

    if existing_games > 0:
        print(f"Self-play (generation {generation}, {variant}): {existing_games} games exist (up to game_{max_file_num}.csv), generating {remaining_games} more starting at game_{start_game}.csv...")
    else:
        print(f"Running self play (generation {generation}, variant {variant}, games {games})...")

    # When using simple policy (no neural network), skip MCTS samples entirely
    # Simple policy just walks toward the goal - no search needed
    is_simple_policy = (model1 == "simple")
    samples = 1 if is_simple_policy else args.samples

    cmd = [
        args.deep_ww,
        "-model1",
        model1,
        "-model2",
        model2,
        "-output",
        output_dir,
        "-columns",
        str(args.columns),
        "-rows",
        str(args.rows),
        "-variant",
        variant,
        "-j",
        str(args.threads),
        "-games",
        str(remaining_games),
        "-start_game",
        str(start_game),
        "-samples",
        str(samples),
    ]

    if boost_mouse_priors:
        cmd.append("--boost_mouse_priors")
    
    # Open log file in append mode
    with open(args.log, "a") as f:
        # Run the process and pipe output directly to the log file
        process = subprocess.Popen(
            cmd,
            stdout=f,
            stderr=f,
            text=True,
            bufsize=1  # Line buffered
        )
        
        # Wait for the process to complete
        returncode = process.wait()
    
    if returncode != 0:
        print(f"Error: Self play failed with return code {returncode}")
        print("Command executed:")
        print(" ".join(cmd))
        print(f"Check the log file at {args.log} for details")
        exit(1)


def predict_valuation(xs):
    return torch.where(xs[1] >= 0.05, 1.0, 0.0) + torch.where(xs[1] <= 0.05, -1.0, 0.0)


def valuation_accuracy(xs, ys):
    return (predict_valuation(xs) == predict_valuation(ys)).float().mean()


def predict_move(xs):
    return torch.max(xs[0], 1).indices


def move_accuracy(xs, ys):
    return (predict_move(xs) == predict_move(ys)).float().mean()


def loss(out, label):
    priors_out, values_out = out
    priors_label, values_label = label

    mse = nn.MSELoss()
    kl_div = nn.KLDivLoss(reduction="batchmean")

    return kl_div(priors_out, priors_label) + mse(values_out, values_label)


def freeze_body(model):
    """Freeze conv body layers, leaving only head Linear layers trainable."""
    # Freeze start block
    for param in model.start.parameters():
        param.requires_grad = False
    # Freeze all ResNet layers
    for layer in model.layers:
        for param in layer.parameters():
            param.requires_grad = False
    # Freeze head conv layers (priors[0-3], value[0-3]), keep Linear trainable
    for i in range(4):
        for param in model.priors[i].parameters():
            param.requires_grad = False
        for param in model.value[i].parameters():
            param.requires_grad = False

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    print(f"  Froze body: {trainable:,} / {total:,} params trainable ({100*trainable/total:.1f}%)")


def unfreeze_all(model):
    """Unfreeze all model parameters."""
    for param in model.parameters():
        param.requires_grad = True
    print("  Unfroze all layers")


def train_model(model, generation, epochs, device, freeze_until_gen=0):
    print(f"Loading training data (generation {generation})...")
    training_paths = get_training_paths(generation)
    print(f"Training paths: {training_paths}")
    training_data, valid_data = get_datasets(
        training_paths,
        args.training_games,
        input_channels,
        args.columns,
        args.rows,
        move_channels,
    )

    if not training_data:
        print(f"Error: No training data found for generation {generation}.")
        print(f"Looked for data in the following paths: {training_paths}")
        print(f"Please check the '--data' argument (currently '{args.data}')")
        exit(1)

    training_loader = DataLoader(
        training_data,
        bs=args.training_batch_size,
        device=device,
        pin_memory=True,
        shuffle=True,
        num_workers=0,  # Otherwise we are at risk of OOM...
    )
    valid_loader = DataLoader(
        valid_data,
        bs=args.training_batch_size,
        device=device,
        pin_memory=True,
        num_workers=0,
    )
    loaders = DataLoaders(training_loader, valid_loader)

    # Freeze body for early generations to protect transferred weights
    is_frozen = generation < freeze_until_gen
    if is_frozen:
        freeze_body(model)
    elif freeze_until_gen > 0 and generation == freeze_until_gen:
        unfreeze_all(model)

    learner = Learner(
        loaders, model, loss_func=loss, metrics=[valuation_accuracy, move_accuracy]
    )

    if is_frozen:
        # Use conservative fixed LR when frozen - don't trust lr_find with junk data
        learning_rate = 1e-3
        print(f"Training generation {generation} with fixed LR {learning_rate} (body frozen)...")
    else:
        learning_rate = learner.lr_find(show_plot=False)[0]
        print(f"Training generation {generation} with learning rate {learning_rate}...")

    learner.fit(epochs, learning_rate)

def init():
    device = torch.device(default_cuda_device)
    expected_priors = 2 * args.columns * args.rows + move_channels

    # For resize warm-start, freeze body for first few generations to protect transferred weights
    # Generation 1 uses simple policy data (low quality), gen 2-3 uses early MCTS data
    # By gen 4, data quality is good enough to fine-tune the full model
    freeze_until_gen = 0

    print("Starting training...")
    print(f"Variant: {args.variant} (move channels: {move_channels})")
    if args.initial_generation == 0:
        if args.warm_start:
            # Determine if this is a resize warm-start
            old_cols = args.warm_start_cols if args.warm_start_cols > 0 else args.columns
            old_rows = args.warm_start_rows if args.warm_start_rows > 0 else args.rows
            is_resize = (old_cols != args.columns or old_rows != args.rows)

            if is_resize:
                freeze_until_gen = 4
                print(f"Resize warm-start: will freeze body until generation {freeze_until_gen}")
                model = warm_start_model_resize(
                    args.warm_start, device,
                    old_cols, old_rows,
                    args.columns, args.rows,
                    args.hidden_channels, args.layers, move_channels
                )
            else:
                model = warm_start_model(args.warm_start, device, expected_priors)

            save_model(model, "model_0", device)

            # For resize warm-start, use simple policy for bootstrap (warm-started model
            # has random weights for boundary positions, causing erratic pawn moves)
            if is_resize:
                print("Bootstrap generation 0 data with simple policy (resize warm-start)")
                if args.variant == "universal":
                    half_games = args.games // 2
                    run_self_play("simple", "", 0, "standard", games=half_games)
                    run_self_play("simple", "", 0, "classic", games=half_games)
                else:
                    run_self_play("simple", "", 0, args.variant)
            else:
                print("Bootstrap generation 0 data with warm-started model")
                if args.variant == "universal":
                    half_games = args.games // 2
                    run_self_play(f"{args.models}/model_0.trt", "", 0, "standard", games=half_games)
                    run_self_play(f"{args.models}/model_0.trt", "", 0, "classic", games=half_games)
                else:
                    run_self_play(f"{args.models}/model_0.trt", "", 0, args.variant)
        else:
            print("Bootstrap generation 0 data with simple model")
            if args.variant == "universal":
                # Run both variants with half the games each
                half_games = args.games // 2
                run_self_play("simple", "", 0, "standard", games=half_games)
                run_self_play("simple", "", 0, "classic", games=half_games)
            else:
                run_self_play("simple", "", 0, args.variant)
            model = ResNet(args.columns, args.rows, args.hidden_channels, args.layers, move_channels)
        
        start_generation = 2
        train_model(model, 1, bootstrap_epochs, device, freeze_until_gen)
        save_model(model, "model_1", device)
        gc.collect()
    else:
        if args.warm_start:
            print("Error: --warm-start requires --initial_generation 0.")
            exit(1)
        print(f"Loading model from generation {args.initial_generation}...")
        model = load_model(f"model_{args.initial_generation}", device)
        if model.priors[-1].out_features != expected_priors:
            print("Error: Loaded model does not match expected output size.")
            print(
                f"Expected {expected_priors} priors for {args.columns}x{args.rows} "
                f"{args.variant}, found {model.priors[-1].out_features}."
            )
            exit(1)
        save_model(model, f"model_{args.initial_generation}", device)
        start_generation = args.initial_generation + 1

    for generation in range(start_generation, start_generation + args.generations - 1):
        # One-off hack to boost mouse priors for specific generations
        # TODO: remove it.
        boost = (generation - 1) in [37, 38, 39]

        model_path = f"{args.models}/model_{generation - 1}.trt"
        if args.variant == "universal":
            # Run both variants with half the games each
            half_games = args.games // 2
            run_self_play(model_path, "", generation - 1, "standard", boost_mouse_priors=boost, games=half_games)
            run_self_play(model_path, "", generation - 1, "classic", boost_mouse_priors=boost, games=half_games)
        else:
            run_self_play(model_path, "", generation - 1, args.variant, boost_mouse_priors=boost)

        train_model(model, generation, args.epochs, device, freeze_until_gen)
        save_model(model, f"model_{generation}", device)
        gc.collect()


if __name__ == "__main__":
    init()
