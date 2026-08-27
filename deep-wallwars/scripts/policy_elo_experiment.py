#!/usr/bin/env python3
"""Validate a policy-Elo plan and derive its experiment metadata."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


class PlanError(ValueError):
    pass


@dataclass(frozen=True)
class Experiment:
    plan_path: Path
    name: str
    pairings: int
    games: int
    generations: tuple[int, ...]
    engine: Path
    engine_sha256: str
    run_root: Path
    archive: Path
    result: Path
    provenance: Path

    def as_dict(self) -> dict:
        return {
            "experiment": self.name,
            "pairings": self.pairings,
            "games": self.games,
            "generations": list(self.generations),
            "generationRange": {
                "min": self.generations[0],
                "max": self.generations[-1],
                "distinct": len(self.generations),
            },
            "paths": {
                "plan": str(self.plan_path),
                "runRoot": str(self.run_root),
                "archive": str(self.archive),
                "result": str(self.result),
                "provenance": str(self.provenance),
                "engine": str(self.engine),
            },
            "engineSha256": self.engine_sha256,
        }


def load_experiment(plan_path: Path, deep_wallwars: Path | None = None) -> tuple[dict, Experiment]:
    plan_path = plan_path.expanduser().resolve()
    try:
        plan = json.loads(plan_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise PlanError(f"cannot read plan {plan_path}: {error}") from error
    if plan.get("schema") != "wallgame-policy-elo-plan-v1":
        raise PlanError("unsupported or missing policy-Elo plan schema")
    name = plan.get("experiment")
    if not isinstance(name, str) or not name or Path(name).name != name:
        raise PlanError("experiment must be one safe path component")
    pairings = plan.get("pairings")
    if not isinstance(pairings, list) or not pairings:
        raise PlanError("plan must contain a non-empty pairings list")
    try:
        games = sum(item["games"] for item in pairings)
        generations = tuple(sorted({
            generation
            for item in pairings
            for generation in (item["generationA"], item["generationB"])
        }))
    except (KeyError, TypeError) as error:
        raise PlanError(f"invalid pairing: {error}") from error
    if games <= 0 or not generations or any(not isinstance(item, int) for item in generations):
        raise PlanError("pairing games and generations must be positive integers")
    summary = plan.get("summary")
    derived_summary = {"pairings": len(pairings), "games": games}
    if summary != derived_summary:
        raise PlanError(f"plan summary {summary!r} does not match {derived_summary!r}")
    engine = plan.get("engine", {})
    if not isinstance(engine.get("path"), str) or not isinstance(engine.get("sha256"), str):
        raise PlanError("plan engine path and sha256 are required")
    config_path = plan.get("config", {}).get("path")
    if not isinstance(config_path, str):
        raise PlanError("plan config path is required")
    root = (deep_wallwars or Path(__file__).resolve().parents[1]).resolve()
    run_root = Path(config_path).parent
    experiment = Experiment(
        plan_path=plan_path,
        name=name,
        pairings=len(pairings),
        games=games,
        generations=generations,
        engine=Path(engine["path"]),
        engine_sha256=engine["sha256"],
        run_root=run_root,
        archive=root / "elo_db" / "policy_archive" / name,
        result=root / "elo_db" / "results" / f"{name}.csv",
        provenance=root / "elo_db" / "provenance" / name,
    )
    return plan, experiment
