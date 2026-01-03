import subprocess
import argparse
import gc
import os
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
input_channels = 8
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
    help="Game variant (classic or standard)",
    default="classic",
)
parser.add_argument(
    "--warm-start",
    help="Path to a classic .pt model to warm-start standard training",
    default="",
)
parser.add_argument(
    "--generations",
    help="Number of generations to train for",
    default=40,
    type=int,
)
parser.add_argument(
    "--initial_generation",
    help="Initial generation to start from (to continue previous run)",
    default=0,
    type=int,
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

variant_move_channels = {"classic": 4, "standard": 8}
if args.variant not in variant_move_channels:
    print(f"Error: Unsupported variant '{args.variant}'. Use 'classic' or 'standard'.")
    exit(1)
move_channels = variant_move_channels[args.variant]


def get_training_paths(generation):
    lb = max(generation - args.max_training_window, (generation - 1) // 2)
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

    if "priors.4.weight" not in base_state or "priors.4.bias" not in base_state:
        print("Error: Warm-start model is missing the priors head.")
        exit(1)

    old_weight = base_state["priors.4.weight"]
    old_bias = base_state["priors.4.bias"]
    old_out = old_weight.shape[0]

    if old_out != wall_prior_size + 4:
        print("Error: Warm-start model does not look like a classic model.")
        print(f"Expected priors size {wall_prior_size + 4}, found {old_out}.")
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

        if move_channels > 4:
            cat_start = wall_prior_size
            cat_end = wall_prior_size + 4
            mouse_start = wall_prior_size + 4
            mouse_end = wall_prior_size + move_channels

            nn.init.normal_(new_weight[mouse_start:mouse_end], mean=0.0, std=0.01)

    model.load_state_dict(state)
    return model.to(device)


def run_self_play(model1, model2, generation):
    os.makedirs(args.data, exist_ok=True)
    print(f"Running self play (generation {generation})...")
    cmd = [
        args.deep_ww,
        "-model1",
        model1,
        "-model2", 
        model2,
        "-output",
        f"{args.data}/generation_{generation}",
        "-columns",
        str(args.columns),
        "-rows", 
        str(args.rows),
        "-variant",
        args.variant,
        "-j",
        str(args.threads),
        "-games",
        str(args.games),
        "-samples",
        str(args.samples),
    ]
    
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


def train_model(model, generation, epochs, device):
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

    learner = Learner(
        loaders, model, loss_func=loss, metrics=[valuation_accuracy, move_accuracy]
    )
    learning_rate = learner.lr_find(show_plot=False)[0]
    print(f"Training generation {generation} with learning rate {learning_rate}...")
    learner.fit(epochs, learning_rate)

def init():
    device = torch.device(default_cuda_device)
    expected_priors = 2 * args.columns * args.rows + move_channels

    print("Starting training...")
    print(f"Variant: {args.variant} (move channels: {move_channels})")
    if args.initial_generation == 0:
        print("Bootstrap generation 0 data with simple model")
        print("Running self play for generation 0...")
        run_self_play("simple", "", 0)
        if args.warm_start:
            model = warm_start_model(args.warm_start, device, expected_priors)
        else:
            model = ResNet(args.columns, args.rows, args.hidden_channels, args.layers, move_channels)
        start_generation = 2
        train_model(model, 1, bootstrap_epochs, device)
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
        run_self_play(f"{args.models}/model_{generation - 1}.trt", "", generation - 1)
        train_model(model, generation, args.epochs, device)
        save_model(model, f"model_{generation}", device)
        gc.collect()


if __name__ == "__main__":
    init()
