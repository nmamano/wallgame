#!/usr/bin/env python3
"""Plan the smallest configured policy-Elo graph extension.

The planner does not invent players or ratings. It reports missing model
artifacts, counts only accepted games, and emits disconnected components.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import defaultdict, deque
from pathlib import Path

MODEL = re.compile(r"model_(\d+)\.trt$")
SUPPORTED_CONTRACTS = {"8-plane-legacy", "16-plane-universal"}


def args():
    p = argparse.ArgumentParser()
    here = Path(__file__).resolve().parent
    p.add_argument("--config", type=Path, default=here / "policy_elo_conditions.json")
    p.add_argument("--base-models", type=Path, required=True)
    p.add_argument("--extension-models", type=Path, required=True)
    p.add_argument("--legacy-games", type=Path, required=True)
    p.add_argument("--existing-sources", type=Path, required=True)
    p.add_argument("--policy-archive", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--engine", type=Path, required=True)
    p.add_argument("--benchmark", type=Path, required=True)
    p.add_argument("--loadability-map", type=Path, required=True)
    p.add_argument("--experiment", required=True)
    p.add_argument("--prefer-extension-duplicates", action="store_true")
    p.add_argument("--duplicate-reason")
    return p.parse_args()


def generation(path: str | Path) -> int | None:
    match = MODEL.search(Path(path).name)
    return int(match.group(1)) if match else None


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inventory(base: Path, extension: Path, prefer_extension=False, duplicate_reason=None):
    models, duplicates = {}, []
    for source, root in (("base", base), ("extension", extension)):
        for path in sorted(root.glob("model_*.trt")):
            gen = generation(path)
            if gen is None:
                continue
            resolved = path.resolve()
            fingerprint = sha256(resolved)
            if gen not in models:
                models[gen] = {"path": resolved, "sha256": fingerprint, "source": source}
                continue
            previous = models[gen]
            if previous["sha256"] == fingerprint:
                duplicates.append({
                    "generation": gen, "resolution": "equal-hash",
                    "selected": str(previous["path"]), "other": str(resolved),
                    "sha256": fingerprint,
                })
                continue
            if not prefer_extension or source != "extension" or not duplicate_reason:
                raise ValueError(
                    f"generation {gen} has different artifacts; use "
                    "--prefer-extension-duplicates with --duplicate-reason"
                )
            duplicates.append({
                "generation": gen, "resolution": "extension-selected",
                "selected": str(resolved), "other": str(previous["path"]),
                "selectedSha256": fingerprint, "otherSha256": previous["sha256"],
                "reason": duplicate_reason,
            })
            models[gen] = {"path": resolved, "sha256": fingerprint, "source": source}
    return models, duplicates


def loadability(path: Path):
    rows = {}
    with path.open() as stream:
        for number, line in enumerate(stream, 1):
            try:
                row = json.loads(line)
                gen = int(row["generation"])
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError(f"malformed loadability row {path}:{number}") from error
            if gen in rows:
                raise ValueError(f"duplicate loadability generation {gen}")
            rows[gen] = row
    return rows


def validate_loadability(rows, models, engine_sha):
    available, unavailable = [], []
    for gen, model in sorted(models.items()):
        row = rows.get(gen)
        if row is None:
            unavailable.append({"generation": gen, "reason": "not-probed"})
            continue
        if row.get("modelSha256") != model["sha256"]:
            raise ValueError(f"loadability map model hash is stale for generation {gen}")
        if row.get("engineSha256") != engine_sha:
            raise ValueError(f"loadability map engine hash is stale for generation {gen}")
        contract = row.get("inputContract")
        if not isinstance(contract, str) or not contract:
            raise ValueError(f"loadability map lacks input contract for generation {gen}")
        if row.get("loadability") == "supported":
            if contract not in SUPPORTED_CONTRACTS:
                raise ValueError(f"unsupported declared input contract for generation {gen}: {contract}")
            available.append(gen)
        else:
            unavailable.append({"generation": gen, "reason": row.get("loadability", "probe-failed")})
    return available, unavailable


def condition_key(row):
    board = row.get("board", "")
    try:
        width, height = (int(value) for value in board.split("x"))
    except (AttributeError, ValueError):
        return None
    return row.get("variant"), row.get("setup", "fixed"), width, height


def edge(a, b):
    return tuple(sorted((int(a), int(b))))


def accepted_existing(config, legacy_games: Path, sources: Path, policy_archive: Path):
    counts = defaultdict(lambda: defaultdict(int))
    seeds = set()
    by_legacy = {
        (c.get("legacyExperiment"), c["variant"], f'{c["width"]}x{c["height"]}'): c
        for c in config["conditions"] if c.get("legacyExperiment")
    }
    if legacy_games.exists():
        with legacy_games.open() as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                except (TypeError, ValueError):
                    continue
                condition = by_legacy.get((row.get("exp"), row.get("variant"), row.get("board")))
                if condition and isinstance(row.get("engineSeed"), int):
                    seeds.add(row["engineSeed"])
                if (not condition or row.get("reason") == "no-legal-move"
                        or row.get("legalityErrors")):
                    continue
                white, black = row.get("white", {}), row.get("black", {})
                if (white.get("arch") != "tf" or black.get("arch") != "tf"
                        or row.get("result") not in ("1-0", "0-1", "1/2-1/2")):
                    continue
                counts[condition["id"]][edge(white["gen"], black["gen"])] += 1

    conditions_by_id = {condition["id"]: condition for condition in config["conditions"]}
    adapters = config.get("archiveConditionAdapters", {})
    source_names = config.get("archiveExperiments", [])
    if not source_names:
        source_names = sorted({
            condition["existingSource"] for condition in config["conditions"]
            if condition.get("existingSource")
        })
    for source_name in source_names:
        root = sources / source_name
        if not root.exists():
            continue
        for path in root.glob("*.jsonl"):
            base = path.name.split("_g", 1)[0]
            adapter = ("old:" if "_" in base else "new:") + base
            condition = conditions_by_id.get(adapters.get(adapter))
            if condition is None and not adapters:
                candidates = [item for item in config["conditions"] if item.get("existingSource") == source_name]
                condition = candidates[0] if len(candidates) == 1 else None
            if condition is None:
                continue
            expected_key = (condition["variant"], condition["setup"], condition["width"], condition["height"])
            with path.open() as stream:
                for line in stream:
                    if not line.strip():
                        continue
                    try:
                        row = json.loads(line)
                    except (TypeError, ValueError):
                        continue
                    if condition_key(row) != expected_key:
                        continue
                    if isinstance(row.get("engineSeed"), int):
                        seeds.add(row["engineSeed"])
                    if (row.get("reason") == "no-legal-move" or row.get("legalityErrors") != []
                            or row.get("outcome") not in ("ours", "opp", "draw")):
                        continue
                    a = generation(row.get("candidateModel", ""))
                    b = generation(row.get("baselineModel", ""))
                    if a is not None and b is not None:
                        counts[condition["id"]][edge(a, b)] += 1
    if policy_archive.exists():
        paths = list(policy_archive.glob("*/accepted/*.jsonl"))
        paths += list(policy_archive.glob("*/quarantine/*.jsonl"))
        for path in paths:
            with path.open() as stream:
                for line in stream:
                    if not line.strip():
                        continue
                    try:
                        row = json.loads(line)
                    except (TypeError, ValueError):
                        continue
                    game = row.get("game", {})
                    if isinstance(game.get("engineSeed"), int):
                        seeds.add(game["engineSeed"])
                    if (row.get("status") != "accepted" or row.get("samples") != 1
                            or row.get("rootNoiseFactor") != 0
                            or row.get("moveSelection") != "policy-argmax"
                            or game.get("reason") == "no-legal-move"
                            or game.get("legalityErrors") != []):
                        continue
                    counts[row["conditionId"]][edge(row["generationA"], row["generationB"])] += 1
    return counts, seeds


def components(generations, edges):
    graph = {gen: set() for gen in generations}
    for a, b in edges:
        if a in graph and b in graph:
            graph[a].add(b)
            graph[b].add(a)
    result, unseen = [], set(graph)
    while unseen:
        start = min(unseen)
        queue, found = deque([start]), []
        unseen.remove(start)
        while queue:
            node = queue.popleft()
            found.append(node)
            for other in graph[node]:
                if other in unseen:
                    unseen.remove(other)
                    queue.append(other)
        result.append(sorted(found))
    return result


def desired_pairings(available, deltas):
    supported = set(available)
    return {
        edge(gen, gen - delta)
        for gen in available for delta in deltas
        if gen - delta in supported
    }


def star_windows(pairings, max_resident=8):
    if max_resident < 2:
        raise ValueError("max resident models must be at least two")
    by_high = defaultdict(set)
    for pairing in pairings:
        low, high = edge(pairing["generationA"], pairing["generationB"])
        by_high[high].add(low)

    windows, assignment = [], {}
    leaves_per_window = max_resident - 1
    for high, lows in sorted(by_high.items()):
        ordered = sorted(lows, reverse=True)
        for index in range(0, len(ordered), leaves_per_window):
            leaves = ordered[index:index + leaves_per_window]
            window_id = f"g{high}-star-{index // leaves_per_window + 1:02d}"
            edges = [edge(low, high) for low in leaves]
            windows.append({
                "id": window_id,
                "generations": [high, *leaves],
                "edges": [[low, upper] for low, upper in edges],
            })
            for assigned_edge in edges:
                if assigned_edge in assignment:
                    raise ValueError(f"pairing assigned twice: {assigned_edge}")
                assignment[assigned_edge] = window_id
    return windows, assignment


def assign_window_seeds(windows, experiment, used_seeds):
    used = set(used_seeds)
    for window in windows:
        seed = int(hashlib.sha256(
            f'{experiment}\0{window["id"]}'.encode()
        ).hexdigest()[:8], 16) & 0x7fffffff
        while seed in used:
            seed = (seed + 1) & 0x7fffffff
        window["engineSeed"] = seed
        used.add(seed)
    return windows


def main():
    opt = args()
    config = json.loads(opt.config.read_text())
    models, duplicate_artifacts = inventory(
        opt.base_models, opt.extension_models,
        opt.prefer_extension_duplicates, opt.duplicate_reason,
    )
    if not models:
        raise ValueError("no model artifacts found")
    engine = opt.engine.resolve()
    engine_sha = sha256(engine)
    loadability_rows = loadability(opt.loadability_map)
    available, unavailable_artifacts = validate_loadability(loadability_rows, models, engine_sha)
    if not available:
        raise ValueError("no inventoried model has a supported loadability probe")
    existing, used_engine_seeds = accepted_existing(
        config, opt.legacy_games, opt.existing_sources, opt.policy_archive,
    )
    desired_edges = desired_pairings(available, config["pairingDeltas"])

    planned, condition_summaries = [], []
    for condition in config["conditions"]:
        counts = existing[condition["id"]]
        enough = {pair for pair, count in counts.items() if count >= condition["gamesPerPair"]}
        for a, b in sorted(desired_edges):
            have = counts.get((a, b), 0)
            need = max(0, condition["gamesPerPair"] - have)
            if need:
                if need % 2:
                    need += 1
                planned.append({
                    "conditionId": condition["id"], "variant": condition["variant"],
                    "setup": condition["setup"], "width": condition["width"], "height": condition["height"],
                    "generationA": a, "generationB": b,
                    "modelA": str(models[a]["path"]), "modelB": str(models[b]["path"]),
                    "existingAcceptedGames": have, "games": need,
                })
        condition_summaries.append({
            "id": condition["id"], "availableGenerations": available,
            "artifactGenerations": sorted(models),
            "missingArtifactGenerations": [0] + [g for g in range(1, max(models) + 1) if g not in models],
            "unavailableArtifacts": unavailable_artifacts,
            "existingAcceptedGames": sum(counts.values()), "sufficientEdges": len(enough),
            "componentsBefore": components(available, enough),
        })

    windows, window_assignment = star_windows(planned)
    assign_window_seeds(windows, opt.experiment, used_engine_seeds)
    for pairing in planned:
        pairing["windowId"] = window_assignment[
            edge(pairing["generationA"], pairing["generationB"])
        ]

    plan = {
        "schema": "wallgame-policy-elo-plan-v1", "experiment": opt.experiment,
        "settings": {"samples": 1, "rootNoiseFactor": 0, "moveSelection": "policy-argmax", "seatAlternation": True},
        "engine": {"path": str(engine), "sha256": engine_sha},
        "benchmark": {"path": str(opt.benchmark.resolve()), "sha256": sha256(opt.benchmark.resolve())},
        "config": {"path": str(opt.config.resolve()), "sha256": sha256(opt.config.resolve())},
        "loadabilityMap": {
            "path": str(opt.loadability_map.resolve()),
            "sha256": sha256(opt.loadability_map.resolve()),
        },
        "models": {
            str(gen): {"path": str(item["path"]), "sha256": item["sha256"], "source": item["source"]}
            for gen, item in sorted(models.items())
        },
        "duplicateArtifacts": duplicate_artifacts,
        "usedEngineSeeds": sorted(used_engine_seeds),
        "conditions": condition_summaries, "windows": windows, "pairings": planned,
        "summary": {
            "pairings": len(planned),
            "games": sum(p["games"] for p in planned),
            "windows": len(windows),
            "maxResidentModels": max((len(window["generations"]) for window in windows), default=0),
        },
    }
    opt.output.parent.mkdir(parents=True, exist_ok=True)
    opt.output.write_text(json.dumps(plan, indent=2) + "\n")
    print(json.dumps(plan["summary"], separators=(",", ":")))


if __name__ == "__main__":
    main()
