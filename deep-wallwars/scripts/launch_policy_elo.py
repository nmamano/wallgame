#!/usr/bin/env python3
"""Launch one policy-Elo plan without experiment-specific constants."""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from policy_elo_experiment import PlanError, load_experiment


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_runner_final(final: Path, original_status: int, engine: Path, expected_hash: str) -> int:
    engine_after = sha256(engine) if engine.exists() else "missing"
    status = original_status if engine_after == expected_hash else 97
    final.write_text(
        f"status={status}\n"
        f"originalStatus={original_status}\n"
        f"measuredAtUtc={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n"
        f"engineAfter={engine_after}\n"
    )
    return status


def run_with_final(command, final: Path, engine: Path, expected_hash: str, runner=subprocess.call) -> int:
    status = 1
    try:
        status = runner(command)
    finally:
        status = write_runner_final(final, status, engine, expected_hash)
    return status


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--describe", action="store_true")
    parser.add_argument("--concurrency", type=int, default=8)
    args = parser.parse_args()
    try:
        _, experiment = load_experiment(args.plan)
    except PlanError as error:
        parser.error(str(error))
    if args.describe:
        print(json.dumps(experiment.as_dict(), indent=2))
        return 0
    registry = Path(__file__).resolve().parents[1] / "elo_db" / "experiments.json"
    registered = json.loads(registry.read_text()).get(experiment.name)
    if registered is None:
        raise SystemExit(f"experiment is not registered: {experiment.name}")
    registered_plan = registered.get("plan", {})
    if registered_plan.get("pairings") != experiment.pairings or registered_plan.get("requestedAcceptedGames") != experiment.games:
        raise SystemExit("registered counts do not match the plan")
    if sha256(experiment.engine) != experiment.engine_sha256:
        raise SystemExit("engine hash does not match the plan")
    final = experiment.run_root / "runner.final"
    if final.exists():
        raise SystemExit(f"runner final already exists: {final}")
    command = [
        sys.executable, str(Path(__file__).with_name("policy_elo_batch.py")),
        "--plan", str(experiment.plan_path), "--run-root", str(experiment.run_root / "run"),
        "--archive-root", str(experiment.archive.parent),
        "--bun", os.environ.get("BUN", str(Path.home() / ".bun/bin/bun")),
        "--concurrency", str(args.concurrency),
    ]
    return run_with_final(command, final, experiment.engine, experiment.engine_sha256)


if __name__ == "__main__":
    raise SystemExit(main())
