#!/usr/bin/env python3
"""Run the pinned Torch-to-BGS parity gate for a small generation sample."""

import argparse
import json
import subprocess
import sys
from pathlib import Path


def transcript(engine, model, config, output, diagnostic):
    command = [
        str(engine), "--model", str(model), "--samples", "1",
        "--seed", "616", "--root_noise_factor", "0",
    ]
    if diagnostic:
        command.append("--policy_probe_details")
    process = subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True,
    )
    requests = [
        {"type": "start_game_session", "bgsId": "sample", "botId": "sample", "config": config},
        {"type": "evaluate_position", "bgsId": "sample", "expectedPly": 0},
        {"type": "end_game_session", "bgsId": "sample"},
    ]
    rows = []
    assert process.stdin is not None and process.stdout is not None
    for request in requests:
        rows.append(request)
        process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
        process.stdin.flush()
        response = process.stdout.readline()
        if not response:
            raise RuntimeError(process.stderr.read() if process.stderr else "engine ended")
        rows.append(json.loads(response))
    process.stdin.close()
    code = process.wait(timeout=60)
    if code != 0:
        raise RuntimeError(f"engine exited {code}: {process.stderr.read() if process.stderr else ''}")
    output.write_text("".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--fixture-source", type=Path, required=True)
    parser.add_argument("--diagnostic-engine", type=Path, required=True)
    parser.add_argument("--production-engine", type=Path, required=True)
    parser.add_argument("--extension-models", type=Path, required=True)
    parser.add_argument("--generations", type=int, nargs="+", required=True)
    args = parser.parse_args()
    output_root = args.run_root / "semantic-gate" / "sample"
    output_root.mkdir(parents=True, exist_ok=False)
    fixture_row = json.loads(args.fixture_source.read_text().splitlines()[0])
    fixture = output_root / "fixture.jsonl"
    fixture.write_text(json.dumps(fixture_row, separators=(",", ":")) + "\n")
    config = {
        "variant": fixture_row["variant"],
        "boardWidth": int(fixture_row["board"].split("x")[0]),
        "boardHeight": int(fixture_row["board"].split("x")[1]),
        "initialState": fixture_row["initialState"],
    }
    verifier = Path(__file__).with_name("verify_torch_bgs_policy_parity.py")
    results = []
    for generation in args.generations:
        model_root = args.run_root / "models" if generation <= 92 else args.extension_models
        checkpoint = (
            model_root / f"model_{generation}.pt"
            if generation <= 92 else args.run_root / "boundary-oracle" / "model_93_16plane.pt"
        )
        onnx = model_root / f"model_{generation}.onnx"
        trt = model_root / f"model_{generation}.trt"
        manifest = (
            args.run_root / "models" / f"model_{generation}.migration.json"
            if generation <= 92 else args.run_root / "boundary-oracle" / "migration-manifest.json"
        )
        export_log = (
            args.run_root / "models" / f"model_{generation}.export.log"
            if generation <= 92 else args.run_root / "bulk.log"
        )
        build_log = (
            args.run_root / "models" / f"model_{generation}.trtexec.log"
            if generation <= 91 else args.run_root / "bulk.log"
        )
        generation_root = output_root / f"g{generation}"
        generation_root.mkdir()
        paths = {}
        for kind, engine, diagnostic in [
            ("diagnostic-a", args.diagnostic_engine, True),
            ("diagnostic-b", args.diagnostic_engine, True),
            ("production-a", args.production_engine, False),
            ("production-b", args.production_engine, False),
        ]:
            path = generation_root / f"{kind}.jsonl"
            transcript(engine, trt, config, path, diagnostic)
            paths[kind] = path
        report = generation_root / "report.json"
        command = [
            sys.executable, str(verifier), "--generation", str(generation), "--checkpoint", str(checkpoint),
            "--migration-manifest", str(manifest), "--onnx", str(onnx), "--trt", str(trt),
            "--export-log", str(export_log), "--build-log", str(build_log),
            "--engine", str(args.production_engine), "--diagnostic-engine", str(args.diagnostic_engine),
            "--fixture", str(fixture), "--fixture-index", "0",
            "--diagnostic-a", str(paths["diagnostic-a"]), "--diagnostic-b", str(paths["diagnostic-b"]),
            "--production-a", str(paths["production-a"]), "--production-b", str(paths["production-b"]),
            "--export-command", "pinned bulk export command in bulk-config.json",
            "--build-command", "pinned TensorRT conversion command in bulk-config.json",
            "--output", str(report),
        ]
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
        result = json.loads(report.read_text())
        results.append({"generation": generation, "matched": result["matched"]})
    summary = output_root / "summary.json"
    summary.write_text(json.dumps({"schema": "wallgame-policy-parity-sample-v1", "results": results}, indent=2) + "\n")
    print(json.dumps({"passed": len(results), "generations": args.generations}, separators=(",", ":")))


if __name__ == "__main__":
    main()
