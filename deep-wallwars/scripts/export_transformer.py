"""S3 export script (transformer-ready loop, plans/transformer-ready-loop.md).

Exports ONNX models into build-tests/ ONLY:
  - WallgameTransformer (seeded fresh weights) at batch 1 and batch 256,
  - the batch-256 ResNet reference regenerated from
    assets/models/12x10_universal_model_48.pt (read-only load).

Writes a manifest JSON (seed, config, checkpoint path, onnx paths) and a
state-dict checkpoint so parity_check.py provably compares the SAME weights
that were exported. Both models are exported with log_output=False and
model.eval() (eval matters for ResNet BatchNorm).
"""

import argparse
import json
import os
import sys

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import MODEL_INPUT_CHANNELS, WallgameTransformer  # noqa: E402

REPO_DW = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_TESTS = os.path.join(REPO_DW, "build-tests")
RESNET_PT = os.path.join(REPO_DW, "assets", "models", "12x10_universal_model_48.pt")


def guarded_dir(outdir):
    """Prove outdir is under build-tests/ BEFORE any directory is created."""
    real = os.path.realpath(outdir)
    root = os.path.realpath(BUILD_TESTS)
    if real != root and not real.startswith(root + os.sep):
        sys.exit(f"FATAL: refusing to write outside build-tests/: {real}")
    return real


def guarded_path(outdir, name):
    """Resolve outdir/name and refuse anything outside build-tests/."""
    path = os.path.realpath(os.path.join(outdir, name))
    root = os.path.realpath(BUILD_TESTS)
    if not path.startswith(root + os.sep):
        sys.exit(f"FATAL: refusing to write outside build-tests/: {path}")
    return path


def load_transformer_weights(path):
    """Accept both a state_dict (torch.save(model.state_dict())) and a full
    pickled model (training.py saves torch.save(model, path))."""
    try:
        obj = torch.load(path, weights_only=True)
    except Exception:
        obj = torch.load(path, weights_only=False, map_location="cpu")
    if isinstance(obj, WallgameTransformer):
        return obj.state_dict()
    if isinstance(obj, dict):
        return obj
    sys.exit(f"FATAL: unsupported checkpoint type {type(obj).__name__} in {path}")


def should_export_resnet_reference(checkpoint):
    """The legacy ResNet is an S3 comparison, not part of trained parity."""
    return checkpoint is None


def export(model, dummy, path):
    model.log_output = False
    model.eval()
    torch.onnx.export(
        model, dummy, path, input_names=["States"], output_names=["Priors", "Values"]
    )
    print(f"exported {path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--outdir", default=os.path.join(BUILD_TESTS, "s3"))
    parser.add_argument("--seed", type=int, default=1234)
    parser.add_argument("--columns", type=int, default=12)
    parser.add_argument("--rows", type=int, default=10)
    parser.add_argument("--d-model", type=int, default=256)
    parser.add_argument("--layers", type=int, default=10)
    parser.add_argument("--heads", type=int, default=8)
    parser.add_argument("--stem", default="pointwise")
    parser.add_argument("--move-channels", type=int, default=8)
    parser.add_argument("--pt", default=None, help="optional transformer checkpoint")
    parser.add_argument("--big-batch", type=int, default=256)
    args = parser.parse_args()

    # Containment BEFORE any side effect (S3 write-safety requirement).
    outdir = guarded_dir(args.outdir)
    os.makedirs(outdir, exist_ok=True)
    args.outdir = outdir

    config = dict(
        columns=args.columns,
        rows=args.rows,
        d_model=args.d_model,
        layers=args.layers,
        heads=args.heads,
        stem=args.stem,
        move_channels=args.move_channels,
    )
    torch.manual_seed(args.seed)
    transformer = WallgameTransformer(**config)
    if args.pt:
        transformer.load_state_dict(load_transformer_weights(args.pt))

    checkpoint = guarded_path(args.outdir, "transformer_s3.pt")
    torch.save(transformer.state_dict(), checkpoint)

    cols, rows, ch = args.columns, args.rows, MODEL_INPUT_CHANNELS
    onnx_b1 = guarded_path(args.outdir, "transformer_b1.onnx")
    onnx_bN = guarded_path(args.outdir, f"transformer_b{args.big_batch}.onnx")
    export(transformer, torch.randn(1, ch, cols, rows), onnx_b1)
    export(transformer, torch.randn(args.big_batch, ch, cols, rows), onnx_bN)

    resnet_pt_source = None
    resnet_onnx = {}
    if should_export_resnet_reference(args.pt):
        # The legacy ResNet is only an S3 comparison. A trained-transformer
        # parity run can use a different board shape and input-plane count.
        resnet = torch.load(RESNET_PT, weights_only=False, map_location="cpu")
        resnet_path = guarded_path(args.outdir, f"resnet48_b{args.big_batch}.onnx")
        export(resnet, torch.randn(args.big_batch, ch, cols, rows), resnet_path)
        resnet_pt_source = RESNET_PT
        resnet_onnx = {str(args.big_batch): resnet_path}

    manifest = {
        "seed": args.seed,
        "config": config,
        "input_channels": ch,
        "checkpoint": checkpoint,
        "transformer_onnx": {"1": onnx_b1, str(args.big_batch): onnx_bN},
        "resnet_pt_source": resnet_pt_source,
        "resnet_onnx": resnet_onnx,
        "torch_version": torch.__version__,
        "note": "fresh seeded random transformer weights; parity/throughput are "
        "architecture properties here. Trained-weight parity re-runs in S4 smoke.",
    }
    manifest_path = guarded_path(args.outdir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"manifest: {manifest_path}")


if __name__ == "__main__":
    main()
