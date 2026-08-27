#!/usr/bin/env python3
"""Complete policy-Elo evidence from plan-derived values and paths."""

import argparse
import csv
import hashlib
import io
import json
import os
import time
from pathlib import Path

from policy_elo_experiment import PlanError, load_experiment


COLUMNS = [
    "exp", "sourceFile", "conditionId", "variant", "setup", "board", "p1", "p2",
    "candidateIsP1", "winner", "evidenceStatus", "exclusionReason", "engineSeed",
    "randomStartSeed", "game",
]


def materialize(archive: Path, experiment) -> tuple[bytes, bytes]:
    generation_by_model = {
        str(Path(item[model]).resolve()): item[generation]
        for item in experiment["pairings"]
        for model, generation in (("modelA", "generationA"), ("modelB", "generationB"))
    }
    records, fingerprints, seen = [], [], set()
    planned_pairs = {
        (item["conditionId"], item["generationA"], item["generationB"])
        for item in experiment["pairings"]
    }
    for path in sorted((archive / "accepted").glob("*.jsonl")):
        with path.open("rb") as stream:
            for line_number, raw_line in enumerate(stream, 1):
                if not raw_line.endswith(b"\n"):
                    raise ValueError(f"torn archive row: {path.name}:{line_number}")
                payload = raw_line[:-1]
                wrapper = json.loads(payload)
                game = wrapper["game"]
                if wrapper.get("schema") != "wallgame-policy-elo-game-v2" or wrapper.get("experiment") != experiment["experiment"]:
                    raise ValueError(f"wrong archive schema or experiment: {path.name}:{line_number}")
                if wrapper.get("status") != "accepted" or wrapper.get("excludeReason") is not None:
                    raise ValueError(f"unaccepted row in accepted archive: {path.name}:{line_number}")
                settings = experiment["settings"]
                for field, value in (("samples", settings["samples"]), ("rootNoiseFactor", settings["rootNoiseFactor"]), ("moveSelection", settings["moveSelection"])):
                    if wrapper.get(field) != value:
                        raise ValueError(f"archive {field} differs from plan: {path.name}:{line_number}")
                identity = wrapper["gameId"]
                if identity in seen:
                    raise ValueError(f"duplicate game ID: {identity}")
                seen.add(identity)
                pair = (wrapper.get("conditionId"), wrapper.get("generationA"), wrapper.get("generationB"))
                if pair not in planned_pairs:
                    raise ValueError(f"off-plan pairing: {path.name}:{line_number}")
                if game.get("exp") != experiment["experiment"] or game.get("legalityErrors") != []:
                    raise ValueError(f"wrong experiment or legality errors: {path.name}:{line_number}")
                if game.get("reason") == "no-legal-move" or game.get("outcome") not in ("ours", "opp", "draw"):
                    raise ValueError(f"excluded or invalid outcome: {path.name}:{line_number}")
                canonical_game = hashlib.sha256(json.dumps(game, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                if wrapper.get("gameFingerprint") != canonical_game:
                    raise ValueError(f"game fingerprint differs: {path.name}:{line_number}")
                p1 = generation_by_model[str(Path(game["whiteModel"]).resolve())]
                p2 = generation_by_model[str(Path(game["blackModel"]).resolve())]
                candidate = p1 if game["candidateIsP1"] else p2
                baseline = p2 if game["candidateIsP1"] else p1
                if candidate != wrapper["generationA"] or baseline != wrapper["generationB"]:
                    raise ValueError(f"model generations differ from wrapper: {path.name}:{line_number}")
                winner = {"1-0": "p1", "0-1": "p2", "1/2-1/2": "draw"}[game["result"]]
                derived_outcome = "draw" if winner == "draw" else (
                    "ours" if (winner == "p1") == game["candidateIsP1"] else "opp"
                )
                if derived_outcome != game["outcome"]:
                    raise ValueError(f"result and outcome differ: {path.name}:{line_number}")
                records.append({
                    "exp": experiment["experiment"], "sourceFile": f"accepted/{path.name}#{identity}",
                    "conditionId": wrapper["conditionId"], "variant": game["variant"], "setup": game["setup"],
                    "board": game["board"], "p1": f"tf:{p1}", "p2": f"tf:{p2}",
                    "candidateIsP1": "true" if game["candidateIsP1"] else "false", "winner": winner,
                    "evidenceStatus": "accepted", "exclusionReason": "", "engineSeed": game["engineSeed"],
                    "randomStartSeed": "" if game["randomStartSeed"] is None else game["randomStartSeed"], "game": game["game"],
                })
                fingerprints.append({"gameId": identity, "rawRecordSha256": hashlib.sha256(payload).hexdigest(), "sourceFile": f"accepted/{path.name}#{identity}", "line": line_number})
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=COLUMNS, lineterminator="\n")
    writer.writeheader()
    writer.writerows(sorted(records, key=lambda row: (row["conditionId"], int(row["p1"].split(":")[1]), int(row["p2"].split(":")[1]), int(row["game"]))))
    fingerprint_payload = json.dumps({"schema": "wallgame-policy-elo-raw-fingerprints-v1", "experiment": experiment["experiment"], "rows": len(fingerprints), "records": sorted(fingerprints, key=lambda row: row["gameId"])}, sort_keys=True, indent=2) + "\n"
    return output.getvalue().encode(), fingerprint_payload.encode()


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def archive_manifest(archive: Path, experiment: str) -> dict:
    files = []
    for path in sorted(item for item in archive.rglob("*") if item.is_file()):
        files.append({"path": path.relative_to(archive).as_posix(), "sha256": file_sha256(path), "bytes": path.stat().st_size})
    payload = "".join(f"{item['path']}\0{item['sha256']}\0{item['bytes']}\n" for item in files).encode()
    return {"schema": "wallgame-policy-elo-archive-tree-v1", "experiment": experiment, "files": files, "treeSha256": hashlib.sha256(payload).hexdigest()}


def publish_evidence(outputs: dict[Path, bytes], registry_path: Path, registry_payload: bytes):
    """Publish all evidence without overwriting a target; roll back on failure."""
    staged, published = {}, []
    registry_temporary = registry_path.with_name(f".{registry_path.name}.{os.getpid()}.tmp")
    try:
        for target, payload in outputs.items():
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
            with temporary.open("xb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            staged[target] = temporary
        with registry_temporary.open("xb") as stream:
            stream.write(registry_payload)
            stream.flush()
            os.fsync(stream.fileno())
        for target, temporary in staged.items():
            os.link(temporary, target)
            published.append(target)
        os.replace(registry_temporary, registry_path)
    except BaseException:
        for target in published:
            target.unlink(missing_ok=True)
        raise
    finally:
        for temporary in staged.values():
            temporary.unlink(missing_ok=True)
        registry_temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--describe", action="store_true")
    args = parser.parse_args()
    try:
        plan, experiment = load_experiment(args.plan)
    except PlanError as error:
        parser.error(str(error))
    if args.describe:
        print(json.dumps(experiment.as_dict(), indent=2))
        return 0
    deep = Path(__file__).resolve().parents[1]
    registry_path = deep / "elo_db" / "experiments.json"
    registry = json.loads(registry_path.read_text())
    entry = registry.get(experiment.name)
    if entry is None:
        raise SystemExit(f"experiment is not registered: {experiment.name}")
    if entry.get("evidenceStatus") != "planned":
        raise SystemExit(f"refusing to change non-planned experiment: {experiment.name}")
    fingerprints = experiment.provenance / "raw-fingerprints.json"
    manifest_path = experiment.provenance / "archive-tree-files.json"
    summary_path = experiment.provenance / "completion-summary.json"
    tracked_outputs = (experiment.result, fingerprints, manifest_path, summary_path)
    existing = [str(path) for path in tracked_outputs if path.exists()]
    if existing:
        raise SystemExit(f"refusing to overwrite existing evidence: {existing}")
    runner_final = experiment.run_root / "runner.final"
    status = dict(line.split("=", 1) for line in runner_final.read_text().splitlines() if "=" in line)
    if status.get("status") != "0":
        raise SystemExit("policy-Elo runner did not finish successfully")
    if hashlib.sha256(experiment.engine.read_bytes()).hexdigest() != experiment.engine_sha256:
        raise SystemExit("engine hash does not match the plan")
    table, fingerprint_payload = materialize(experiment.archive, plan)
    rows = list(csv.DictReader(io.StringIO(table.decode())))
    pairings = {(row["conditionId"], tuple(sorted((row["p1"], row["p2"])))) for row in rows}
    generations = sorted({int(player.split(":", 1)[1]) for row in rows for player in (row["p1"], row["p2"])})
    if len(rows) != experiment.games or len(pairings) != experiment.pairings or generations != list(experiment.generations):
        raise SystemExit("materialized evidence does not match the plan")
    manifest = archive_manifest(experiment.archive, experiment.name)
    manifest_payload = (json.dumps(manifest, indent=2) + "\n").encode()
    conditions = {}
    for row in rows:
        conditions[row["conditionId"]] = conditions.get(row["conditionId"], 0) + 1
    completed = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    summary = {
        "schema": "wallgame-policy-elo-completion-v1", "experiment": experiment.name,
        "completedAtUtc": completed, "acceptedGames": len(rows), "quarantinedGames": 0,
        "pairings": len(pairings), "supportedGenerations": generations,
        "conditions": len(conditions), "archiveTreeSha256": manifest["treeSha256"],
        "archiveFileCount": len(manifest["files"]),
        "archiveBytes": sum(item["bytes"] for item in manifest["files"]),
        "gamesByCondition": dict(sorted(conditions.items())),
    }
    summary_payload = (json.dumps(summary, indent=2) + "\n").encode()
    repo = deep.parent
    relative = lambda path: path.resolve().relative_to(repo).as_posix()
    entry["results"] = {"path": relative(experiment.result), "schema": "wallgame-elo-results-table-v1", "rows": len(rows), "bytes": len(table), "sha256": hashlib.sha256(table).hexdigest(), "generator": relative(Path(__file__))}
    entry["rawFingerprints"] = {"path": relative(fingerprints), "schema": "wallgame-policy-elo-raw-fingerprints-v1", "rows": len(rows), "bytes": len(fingerprint_payload), "sha256": hashlib.sha256(fingerprint_payload).hexdigest(), "generator": relative(Path(__file__))}
    entry["canonical_archive"] = {"path": relative(experiment.archive), "contentSha256": manifest["treeSha256"], "hashStatus": "finalized after completion", "completionRecord": {"path": relative(summary_path), "sha256": hashlib.sha256(summary_payload).hexdigest()}}
    entry["localRawArchive"] = {"path": relative(experiment.archive), "tracked": False, "files": summary["archiveFileCount"], "rawBytes": summary["archiveBytes"], "contentSha256": manifest["treeSha256"], "measuredOn": completed[:10]}
    entry["evidenceStatus"] = "accepted"
    entry["measured"] = {"parsedRows": len(rows), "gamesByCondition": summary["gamesByCondition"], "pairings": len(pairings), "generationRange": experiment.as_dict()["generationRange"], "measuredOn": completed[:10]}
    registry_payload = (json.dumps(registry, indent=2) + "\n").encode()
    publish_evidence({experiment.result: table, fingerprints: fingerprint_payload, manifest_path: manifest_payload, summary_path: summary_payload}, registry_path, registry_payload)
    print(json.dumps(experiment.as_dict(), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
