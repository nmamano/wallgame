"""S3 parity check: TensorRT fp16 engine vs PyTorch fp32 (transformer-ready loop).

No python-tensorrt dependency: inputs are written as raw C-contiguous fp32
little-endian binaries and run through `trtexec --loadEngine --loadInputs
--exportOutput`; outputs are parsed from the JSON BY TENSOR NAME.

Gates (agreed at S3 plan-gate with Game Reviewer):
  - Priors max-abs-diff <= 1e-2 (post-softmax, export mode)
  - Values max-abs-diff <= 1e-2
  - Priors sums ~ 1 on BOTH sides (catches layout/parsing mistakes cheaply)
  - Top-1 equality gated ONLY on samples where the PyTorch top1-top2 margin
    >= 5e-3; all flips reported with margins. Top-5 overlap is informational.

Exits nonzero on any gate failure, printing the worst offender.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import WallgameTransformer  # noqa: E402

MARGIN = 5e-3
TOL = 1e-2
SUM_TOL = 5e-3


def build_reference(manifest, kind):
    if kind == "transformer":
        model = WallgameTransformer(**manifest["config"])
        model.load_state_dict(torch.load(manifest["checkpoint"], weights_only=True))
    elif kind == "resnet":
        model = torch.load(
            manifest["resnet_pt_source"], weights_only=False, map_location="cpu"
        )
    else:
        sys.exit(f"FATAL: unknown kind {kind!r}")
    model.log_output = False
    model.eval()
    return model


def run_trtexec(engine, states, workdir):
    """states: (B,9,cols,rows) float32 tensor -> dict name -> np array."""
    arr = states.numpy()
    assert arr.dtype == np.float32, arr.dtype
    arr = np.ascontiguousarray(arr)
    expected_bytes = arr.size * 4
    in_path = os.path.join(workdir, "states.bin")
    arr.astype("<f4").tofile(in_path)
    actual_bytes = os.path.getsize(in_path)
    if actual_bytes != expected_bytes:
        sys.exit(f"FATAL: input bytes {actual_bytes} != expected {expected_bytes}")

    out_path = os.path.join(workdir, "out.json")
    cmd = [
        "trtexec",
        f"--loadEngine={engine}",
        f"--loadInputs=States:{in_path}",
        f"--exportOutput={out_path}",
        "--warmUp=0",
        "--iterations=1",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f"FATAL: trtexec failed:\n{proc.stdout[-2000:]}\n{proc.stderr[-500:]}")

    with open(out_path) as f:
        raw = json.load(f)
    outputs = {}
    for entry in raw:
        name = entry.get("name")
        dims = [int(d) for d in str(entry["dimensions"]).split("x")]
        values = np.array(entry["values"], dtype=np.float32).reshape(dims)
        outputs[name] = values
    return outputs


def check_sample(torch_priors, torch_values, trt_out, batch, n_priors, label, records):
    """Returns list of failure strings; appends worst-diff records."""
    failures = []
    for name, want_shape in (("Priors", (batch, n_priors)), ("Values", (batch, 1))):
        if name not in trt_out:
            failures.append(f"{label}: output {name!r} missing from trtexec JSON")
            return failures
        if tuple(trt_out[name].shape) != want_shape:
            failures.append(
                f"{label}: {name} shape {trt_out[name].shape} != {want_shape}"
            )
            return failures

    tp = torch_priors.numpy()
    ep = trt_out["Priors"]
    tv = torch_values.numpy()
    ev = trt_out["Values"]

    priors_diff = np.abs(tp - ep).max()
    values_diff = np.abs(tv - ev).max()
    torch_sums = tp.sum(axis=1)
    trt_sums = ep.sum(axis=1)
    records.append(
        dict(label=label, priors_diff=float(priors_diff), values_diff=float(values_diff))
    )

    if priors_diff > TOL:
        failures.append(f"{label}: priors max-abs-diff {priors_diff:.4g} > {TOL}")
    if values_diff > TOL:
        failures.append(f"{label}: values max-abs-diff {values_diff:.4g} > {TOL}")
    if np.abs(torch_sums - 1).max() > SUM_TOL:
        failures.append(f"{label}: PyTorch priors sums off 1: {torch_sums}")
    if np.abs(trt_sums - 1).max() > SUM_TOL:
        failures.append(
            f"{label}: TRT priors sums off 1 (max dev {np.abs(trt_sums-1).max():.4g})"
        )

    # Margin-gated top-1 (Game Reviewer's criterion); top-5 informational.
    for b in range(tp.shape[0]):
        order = np.argsort(tp[b])[::-1]
        margin = tp[b][order[0]] - tp[b][order[1]]
        trt_top1 = int(ep[b].argmax())
        if trt_top1 != int(order[0]):
            top5_overlap = len(set(order[:5]) & set(np.argsort(ep[b])[::-1][:5]))
            print(
                f"  FLIP {label}[{b}]: torch top1={int(order[0])} trt top1={trt_top1} "
                f"margin={margin:.5f} top5-overlap={top5_overlap}/5"
                + ("  (margin-gated: FAILURE)" if margin >= MARGIN else "  (near-tie: allowed)")
            )
            if margin >= MARGIN:
                failures.append(
                    f"{label}[{b}]: top-1 flip with margin {margin:.5f} >= {MARGIN}"
                )
    return failures


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--engine", required=True)
    parser.add_argument("--kind", choices=["transformer", "resnet"], required=True)
    parser.add_argument("--batch", type=int, required=True)
    parser.add_argument("--samples", type=int, default=64,
                        help="number of seeded inputs (batch-1 mode). For batch>1 "
                        "a single full batch is compared (plan-gate req 5).")
    parser.add_argument("--base-seed", type=int, default=7000)
    args = parser.parse_args()

    with open(args.manifest) as f:
        manifest = json.load(f)
    cfg = manifest["config"]
    cols, rows, ch = cfg["columns"], cfg["rows"], manifest["input_channels"]
    n_priors = 2 * cols * rows + cfg["move_channels"]

    model = build_reference(manifest, args.kind)

    runs = args.samples if args.batch == 1 else 1
    failures, records = [], []
    with tempfile.TemporaryDirectory() as workdir:
        for i in range(runs):
            torch.manual_seed(args.base_seed + i)
            states = torch.randn(args.batch, ch, cols, rows)
            with torch.no_grad():
                torch_priors, torch_values = model(states)
            trt_out = run_trtexec(args.engine, states, workdir)
            failures += check_sample(
                torch_priors, torch_values, trt_out, args.batch, n_priors,
                f"{args.kind}-b{args.batch}#{i}", records,
            )

    worst = max(records, key=lambda r: r["priors_diff"])
    print(f"\nruns: {runs} x batch {args.batch} | engine: {args.engine}")
    print(f"worst priors max-abs-diff: {worst['priors_diff']:.6f} ({worst['label']})")
    print(f"worst values max-abs-diff: "
          f"{max(r['values_diff'] for r in records):.6f}")
    if failures:
        print(f"\nPARITY FAILED ({len(failures)}):")
        for f_ in failures:
            print(f"  {f_}")
        sys.exit(1)
    print(f"PARITY OK (tol {TOL}, sum-tol {SUM_TOL}, margin {MARGIN})")


if __name__ == "__main__":
    main()
