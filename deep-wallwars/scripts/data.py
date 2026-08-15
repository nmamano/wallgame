from torch import tensor
from random import sample

def tensor_from_csv_line(line):
    return tensor([float(x) for x in line.split(", ")])


def parse_file(file, input_channels, columns, rows, move_channels):
    if input_channels != 16:
        raise ValueError(
            f"Replay loader accepts only the 16-plane format, not {input_channels} planes. "
            "Convert old sources with migrate_replay_data.py before loading them."
        )
    if move_channels != 8:
        raise ValueError(
            f"Universal replay labels require 8 pawn-move channels, not {move_channels}."
        )
    expected_num_values = input_channels * columns * rows
    expected_priors = 2 * columns * rows + move_channels
    result = []
    with open(file) as f:
        lines = f.readlines()
        for i in range(0, len(lines), 4):
            parsed_tensor_line = tensor_from_csv_line(lines[i])
            actual_num_values = len(parsed_tensor_line)
            if actual_num_values != expected_num_values:
                print(f"ERROR in file {file}, line index {i}: Data dimension mismatch for board state.")
                print(f"Expected {expected_num_values} values (channels:{input_channels} x cols:{columns} x rows:{rows}).")
                print(f"Found {actual_num_values} values.")
                print("This probably means you are trying to load training data from an older run with different board dimensions.")
                exit(1)
            priors = tensor_from_csv_line(lines[i + 1])
            values = tensor_from_csv_line(lines[i + 2])

            if len(priors) != expected_priors:
                print(f"ERROR in file {file}, line index {i + 1}: Prior size mismatch.")
                print(f"Expected {expected_priors} priors (walls + moves).")
                print(f"Found {len(priors)} values.")
                print("This probably means you are trying to load training data from a different variant.")
                exit(1)
            if len(values) != 1:
                print(f"ERROR in file {file}, line index {i + 2}: Value size mismatch.")
                print("Expected 1 value.")
                print(f"Found {len(values)} values.")
                exit(1)
            result.append(
                (
                    parsed_tensor_line.view(input_channels, columns, rows),
                    (priors, values),
                )
            )
    return result


def parse_files(files, input_channels, columns, rows, move_channels):
    return [
        entry for file in files for entry in parse_file(file, input_channels, columns, rows, move_channels)
    ]


def get_datasets(paths, games, input_channels, columns, rows, move_channels, splitter=None):
    from fastai.data.all import RandomSplitter, get_files

    if splitter is None:
        splitter = RandomSplitter()
    files = [file for path in paths for file in get_files(path)]
    if games < len(files):
        files = sample(files, games)
    training_files, valid_files = splitter(files)
    return parse_files((files[i] for i in training_files), input_channels, columns, rows, move_channels), parse_files(
        (files[i] for i in valid_files), input_channels, columns, rows, move_channels
    )
