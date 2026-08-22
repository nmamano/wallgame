"""CPU parity proof for the generation-93 9-to-16-plane migration."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import torch

from migrate_universal_checkpoint import verify_exact_migration

ATOL = 2e-6
FIXTURE_NAMES = [
    "classic",
    "standard",
    "historical_freestyle_equivalent_standard",
]


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def onnx_artifact_hashes(path):
    paths = [path, Path(f"{path}.data")]
    return {candidate.name: file_sha256(candidate) for candidate in paths if candidate.exists()}


def distance_plane(columns, rows, cell):
    column, row = cell
    scale = float(columns * rows)
    return np.fromfunction(
        lambda c, r: (np.abs(c - column) + np.abs(r - row)) / scale,
        (columns, rows),
        dtype=np.float32,
    ).astype(np.float32)


def base_state(columns, rows, landmarks, second_action, red_to_move, offset):
    state = np.zeros((8, columns, rows), dtype=np.float32)
    for plane, cell in enumerate(landmarks):
        state[plane] = distance_plane(columns, rows, cell)
    for column in range(columns):
        for row in range(rows):
            state[4, column, row] = float((column + 2 * row + offset) % 7 == 0)
            state[5, column, row] = float((2 * column + row + offset) % 11 == 0)
    state[6].fill(float(second_action))
    state[7].fill(float(red_to_move))
    return state


def fixtures(columns, rows):
    specs = [
        ("classic", [(1, 1), (10, 8), (9, 2), (0, 7)], False, True, False, 1),
        ("standard", [(2, 2), (9, 7), (8, 1), (1, 8)], True, False, True, 2),
        (
            "historical_freestyle_equivalent_standard",
            [(4, 3), (7, 6), (6, 4), (3, 5)],
            True,
            True,
            True,
            3,
        ),
    ]
    old_states = []
    new_states = []
    for name, landmarks, standard, second, red, offset in specs:
        base = base_state(columns, rows, landmarks, second, red, offset)
        old = np.zeros((9, columns, rows), dtype=np.float32)
        old[:8] = base
        old[8].fill(float(standard))
        new = np.zeros((16, columns, rows), dtype=np.float32)
        new[:8] = base
        new[8 if standard else 9].fill(1.0)
        old_states.append(old)
        new_states.append(new)
        assert name == FIXTURE_NAMES[len(old_states) - 1]
    return np.stack(old_states), np.stack(new_states)


def export_onnx(model, states, path):
    import onnx

    model.log_output = False
    model.eval()
    torch.onnx.export(
        model,
        torch.from_numpy(states),
        path,
        input_names=["States"],
        output_names=["Priors", "Values"],
    )
    graph = onnx.load(path)
    onnx.checker.check_model(graph)
    shape = [
        dimension.dim_value
        for dimension in next(i for i in graph.graph.input if i.name == "States")
        .type.tensor_type.shape.dim
    ]
    if shape != list(states.shape):
        raise ValueError(f"ONNX input shape mismatch: {shape} != {list(states.shape)}")
    return shape


def model_outputs(model, states):
    model.log_output = False
    model.eval()
    with torch.inference_mode():
        return [value.detach().cpu().numpy() for value in model(torch.from_numpy(states))]


def onnx_outputs(path, states):
    import onnxruntime as ort

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    return session.run(["Priors", "Values"], {"States": states})


def compare(name, left, right):
    diffs = {
        "priors_max_abs": float(np.max(np.abs(left[0] - right[0]))),
        "values_max_abs": float(np.max(np.abs(left[1] - right[1]))),
    }
    if diffs["priors_max_abs"] > ATOL or diffs["values_max_abs"] > ATOL:
        raise ValueError(f"{name} exceeds {ATOL}: {diffs}")
    return diffs


def main():
    import onnx
    import onnxruntime as ort

    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--migrated", required=True)
    parser.add_argument("--outdir", required=True)
    args = parser.parse_args()

    source_path = Path(args.source).resolve()
    migrated_path = Path(args.migrated).resolve()
    outdir = Path(args.outdir).resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    report_path = outdir / "parity-report.json"
    old_onnx = outdir / "generation-93-9-plane.onnx"
    new_onnx = outdir / "generation-93-16-plane.onnx"
    for path in (report_path, old_onnx, new_onnx):
        if path.exists():
            raise SystemExit(f"FATAL: refusing to overwrite {path}")

    source = torch.load(source_path, map_location="cpu", weights_only=False)
    migrated = torch.load(migrated_path, map_location="cpu", weights_only=False)
    verify_exact_migration(source, migrated)
    columns, rows = source.columns, source.rows
    old_states, new_states = fixtures(columns, rows)

    old_pt = model_outputs(source, old_states)
    new_pt = model_outputs(migrated, new_states)
    old_shape = export_onnx(source, old_states, old_onnx)
    new_shape = export_onnx(migrated, new_states, new_onnx)
    old_ort = onnx_outputs(old_onnx, old_states)
    new_ort = onnx_outputs(new_onnx, new_states)

    comparisons = {
        "pytorch_old_vs_migrated": compare("PyTorch old vs migrated", old_pt, new_pt),
        "onnx_old_vs_migrated": compare("ONNX old vs migrated", old_ort, new_ort),
        "old_pytorch_vs_onnx": compare("old PyTorch vs ONNX", old_pt, old_ort),
        "migrated_pytorch_vs_onnx": compare("migrated PyTorch vs ONNX", new_pt, new_ort),
    }
    per_fixture = {}
    for index, name in enumerate(FIXTURE_NAMES):
        per_fixture[name] = {
            "pytorch_priors_max_abs": float(
                np.max(np.abs(old_pt[0][index] - new_pt[0][index]))
            ),
            "pytorch_values_max_abs": float(
                np.max(np.abs(old_pt[1][index] - new_pt[1][index]))
            ),
            "onnx_priors_max_abs": float(
                np.max(np.abs(old_ort[0][index] - new_ort[0][index]))
            ),
            "onnx_values_max_abs": float(
                np.max(np.abs(old_ort[1][index] - new_ort[1][index]))
            ),
        }

    report = {
        "kind": "wallgame-generation-93-cpu-parity",
        "tolerance_max_abs": ATOL,
        "fixtures": FIXTURE_NAMES,
        "per_fixture": per_fixture,
        "comparisons": comparisons,
        "onnx_shapes": {"source": old_shape, "migrated": new_shape},
        "artifacts": {
            "source_pt_sha256": file_sha256(source_path),
            "migrated_pt_sha256": file_sha256(migrated_path),
            "source_onnx": onnx_artifact_hashes(old_onnx),
            "migrated_onnx": onnx_artifact_hashes(new_onnx),
        },
        "runtime": {
            "torch": torch.__version__,
            "onnx": onnx.__version__,
            "onnxruntime": ort.__version__,
            "providers": ["CPUExecutionProvider"],
        },
    }
    with open(report_path, "x") as destination:
        json.dump(report, destination, indent=2, sort_keys=True)
        destination.write("\n")
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
