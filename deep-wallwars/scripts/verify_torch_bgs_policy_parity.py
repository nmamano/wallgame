"""Bind a migrated Torch policy argmax to the real TensorRT/BGS move."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import torch

POLICY_MARGIN_TOLERANCE = 2e-6


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_transcript(path):
    responses = [json.loads(line) for line in path.read_text().splitlines() if line]
    starts = [row for row in responses if row.get("type") == "start_game_session"]
    started = [row for row in responses if row.get("type") == "game_session_started"]
    matches = [row for row in responses if row.get("type") == "evaluate_response"]
    if len(starts) != 1 or not isinstance(starts[0].get("config"), dict):
        raise ValueError(f"expected one start_game_session request with config: {path}")
    if len(started) != 1 or started[0].get("success") is not True:
        raise ValueError(f"expected one successful game_session_started response: {path}")
    if len(matches) != 1 or matches[0].get("success") is not True:
        raise ValueError(f"expected one successful evaluate response: {path}")
    bgs_ids = {starts[0].get("bgsId"), started[0].get("bgsId"), matches[0].get("bgsId")}
    if None in bgs_ids or len(bgs_ids) != 1:
        raise ValueError(f"session/evaluate bgsId mismatch: {path}")
    return matches[0], starts[0]["config"]


def fixture_config(fixture_record):
    if not isinstance(fixture_record, dict):
        raise ValueError("selected fixture row is not a JSON object")
    variant = fixture_record.get("variant")
    initial_state = fixture_record.get("initialState")
    width = fixture_record.get("boardWidth")
    height = fixture_record.get("boardHeight")
    if width is None or height is None:
        board = fixture_record.get("board")
        if not isinstance(board, str) or "x" not in board:
            raise ValueError("selected fixture row lacks board dimensions")
        parts = board.split("x")
        if len(parts) != 2:
            raise ValueError("selected fixture row has malformed board dimensions")
        try:
            width, height = (int(part) for part in parts)
        except ValueError as error:
            raise ValueError("selected fixture row has malformed board dimensions") from error
    if not isinstance(variant, str) or not isinstance(initial_state, dict):
        raise ValueError("selected fixture row lacks variant or initialState")
    return {
        "variant": variant,
        "boardWidth": width,
        "boardHeight": height,
        "initialState": initial_state,
    }


def require_fixture_sessions(selected_config, transcripts):
    for path, (_, actual_config) in transcripts:
        if actual_config != selected_config:
            raise ValueError(f"fixture/session config mismatch: {path}")


def expected_indices(model, response):
    probe = response.get("policyProbe")
    if not isinstance(probe, dict):
        raise ValueError("diagnostic response lacks policyProbe")
    positions = probe.get("positions")
    chosen = probe.get("chosenPolicyIndices")
    if not isinstance(positions, list) or not isinstance(chosen, list):
        raise ValueError("diagnostic policyProbe is malformed")
    if not positions or len(positions) != len(chosen):
        raise ValueError("diagnostic position/chosen counts differ")

    expected = []
    margins = []
    with torch.inference_mode():
        for position in positions:
            inputs = np.asarray(position["input"], dtype=np.float32).reshape(
                1, 16, model.columns, model.rows
            )
            priors, _ = model(torch.from_numpy(inputs))
            policy = priors[0].detach().cpu().numpy()
            legal = sorted(
                {int(action["policyIndex"]) for action in position["legalActions"]}
            )
            if len(legal) < 2:
                raise ValueError("pinned fixture has fewer than two legal policy actions")
            ranked = sorted(((float(policy[index]), index) for index in legal), reverse=True)
            margin = ranked[0][0] - ranked[1][0]
            if margin <= POLICY_MARGIN_TOLERANCE:
                raise ValueError(
                    f"pinned fixture policy margin {margin} is not greater than "
                    f"{POLICY_MARGIN_TOLERANCE}"
                )
            expected.append(ranked[0][1])
            margins.append(margin)
    if expected != chosen:
        raise ValueError(f"Torch/BGS policy argmax mismatch: {expected} != {chosen}")
    return expected, margins


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--generation", type=int, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--migration-manifest", type=Path, required=True)
    parser.add_argument("--onnx", type=Path, required=True)
    parser.add_argument("--trt", type=Path, required=True)
    parser.add_argument("--export-log", type=Path, required=True)
    parser.add_argument("--build-log", type=Path, required=True)
    parser.add_argument("--engine", type=Path, required=True)
    parser.add_argument("--diagnostic-engine", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--fixture-index", type=int, required=True)
    parser.add_argument("--diagnostic-a", type=Path, required=True)
    parser.add_argument("--diagnostic-b", type=Path, required=True)
    parser.add_argument("--production-a", type=Path, required=True)
    parser.add_argument("--production-b", type=Path, required=True)
    parser.add_argument("--export-command", required=True)
    parser.add_argument("--build-command", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit(f"FATAL: refusing to overwrite {args.output}")

    transcripts = [
        read_transcript(args.diagnostic_a),
        read_transcript(args.diagnostic_b),
        read_transcript(args.production_a),
        read_transcript(args.production_b),
    ]
    diagnostic = [transcripts[0][0], transcripts[1][0]]
    production = [transcripts[2][0], transcripts[3][0]]
    moves = [row["bestMove"] for row in [*diagnostic, *production]]
    if len(set(moves)) != 1:
        raise ValueError(f"BGS repeat or diagnostic/production move mismatch: {moves}")
    if diagnostic[0]["policyProbe"] != diagnostic[1]["policyProbe"]:
        raise ValueError("diagnostic policy probe is not deterministic")

    model = torch.load(args.checkpoint, map_location="cpu", weights_only=False).eval()
    model.log_output = False
    expected, margins = expected_indices(model, diagnostic[0])
    fixture_rows = [line for line in args.fixture.read_text().splitlines() if line]
    if args.fixture_index < 0 or args.fixture_index >= len(fixture_rows):
        raise ValueError("fixture index is outside the pinned JSONL file")
    selected_fixture = json.loads(fixture_rows[args.fixture_index])
    selected_config = fixture_config(selected_fixture)
    require_fixture_sessions(
        selected_config,
        list(
            zip(
                [
                    args.diagnostic_a,
                    args.diagnostic_b,
                    args.production_a,
                    args.production_b,
                ],
                transcripts,
            )
        ),
    )
    fixture_record_sha256 = hashlib.sha256(
        fixture_rows[args.fixture_index].encode()
    ).hexdigest()
    record = {
        "schema": "wallgame-torch-bgs-policy-parity-v1",
        "generation": args.generation,
        "checkpointSha256": sha256(args.checkpoint),
        "migrationManifestSha256": sha256(args.migration_manifest),
        "onnxSha256": sha256(args.onnx),
        "trtSha256": sha256(args.trt),
        "exportLogSha256": sha256(args.export_log),
        "buildLogSha256": sha256(args.build_log),
        "engineSha256": sha256(args.engine),
        "diagnosticEngineSha256": sha256(args.diagnostic_engine),
        "fixtureSha256": sha256(args.fixture),
        "fixtureIndex": args.fixture_index,
        "fixtureRecordSha256": fixture_record_sha256,
        "exportCommand": args.export_command,
        "buildCommand": args.build_command,
        "expectedPolicyIndices": expected,
        "torchTop1Top2Margins": margins,
        "policyMarginTolerance": POLICY_MARGIN_TOLERANCE,
        "expectedMove": moves[0],
        "diagnosticReturnedMoves": moves[:2],
        "productionReturnedMoves": moves[2:],
        "deterministic": True,
        "matched": True,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "x") as destination:
        json.dump(record, destination, indent=2, sort_keys=True)
        destination.write("\n")
    print(json.dumps(record, separators=(",", ":")))


if __name__ == "__main__":
    main()
