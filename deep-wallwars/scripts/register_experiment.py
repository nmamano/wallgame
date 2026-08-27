#!/usr/bin/env python3
"""Register one policy-Elo experiment from its plan."""

import argparse
import json
import os
from pathlib import Path

from policy_elo_experiment import PlanError, load_experiment


def relative(path: Path, repo: Path) -> str:
    try:
        return path.resolve().relative_to(repo).as_posix()
    except ValueError:
        return str(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--registry", type=Path)
    args = parser.parse_args()
    deep = Path(__file__).resolve().parents[1]
    repo = deep.parent
    registry = args.registry or deep / "elo_db" / "experiments.json"
    try:
        plan, experiment = load_experiment(args.plan, deep)
    except PlanError as error:
        parser.error(str(error))
    data = json.loads(registry.read_text()) if registry.exists() else {}
    if experiment.name in data:
        raise SystemExit(f"refusing duplicate experiment name: {experiment.name}")
    claimed_paths = {
        relative(experiment.archive, repo), relative(experiment.result, repo),
        relative(experiment.provenance, repo),
    }
    for other_name, entry in data.items():
        paths = {
            entry.get("canonical_archive", {}).get("path"),
            entry.get("results", {}).get("path"),
            entry.get("provenance", {}).get("path"),
        }
        conflict = claimed_paths.intersection(paths - {None})
        if conflict:
            raise SystemExit(f"refusing path conflict with {other_name}: {sorted(conflict)}")
    settings = plan.get("settings", {})
    data[experiment.name] = {
        "arch": "tf",
        "sources": [],
        "samples": settings.get("samples"),
        "noise_factor": settings.get("rootNoiseFactor"),
        "move_selection": settings.get("moveSelection"),
        "seat_alternation": settings.get("seatAlternation"),
        "engine_sha256": experiment.engine_sha256,
        "plan": {"pairings": experiment.pairings, "requestedAcceptedGames": experiment.games},
        "generation_range": {
            "evidenceStart": experiment.generations[0],
            "evidenceEnd": experiment.generations[-1],
        },
        "canonical_archive": {"path": relative(experiment.archive, repo), "hashStatus": "pending"},
        "provenance": {"path": relative(experiment.provenance, repo)},
        "evidenceStatus": "planned",
    }
    registry.parent.mkdir(parents=True, exist_ok=True)
    temporary = registry.with_name(registry.name + ".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n")
    os.replace(temporary, registry)
    print(json.dumps(experiment.as_dict(), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
