#!/usr/bin/env python3
"""Build the policy Elo app snapshot from legacy and remote JSONL evidence."""

import argparse
import base64
import gzip
import hashlib
import json
import math
import re
import shlex
import subprocess
import time
import zlib
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODEL = re.compile(r"_g(\d+)_vs_g(\d+)")

REMOTE_AGGREGATOR = r'''import base64,collections,glob,gzip,json,os,re,sys
root=sys.argv[1]
experiments=json.loads(sys.argv[2])
adapters=json.loads(sys.argv[3])
out={}
for experiment in experiments:
  for path in glob.glob(root+"/"+experiment+"/*.jsonl"):
    base=os.path.basename(path).split("_g")[0]
    mode="old" if "_" in base else "new"
    key=mode+":"+base
    if key not in adapters:
      continue
    match=re.search(r"_g(\d+)_vs_g(\d+)",os.path.basename(path))
    a,b=map(int,match.groups())
    wins_a=wins_b=draws=clean=excluded=0
    for line in open(path):
      try: row=json.loads(line)
      except (TypeError,ValueError):
        excluded+=1; continue
      outcome=row.get("outcome") if isinstance(row,dict) else None
      if row.get("reason")=="no-legal-move" or row.get("legalityErrors")!=[] or outcome not in ("ours","opp","draw"):
        excluded+=1; continue
      clean+=1
      if outcome=="ours": wins_a+=1
      elif outcome=="opp": wins_b+=1
      else: draws+=1
    merged=out.setdefault((adapters[key],a,b),{"condition":adapters[key],"a":a,"b":b,
      "winsA":0,"winsB":0,"draws":0,"clean":0,"excluded":0,"sources":{}})
    merged["winsA"]+=wins_a; merged["winsB"]+=wins_b; merged["draws"]+=draws
    merged["clean"]+=clean; merged["excluded"]+=excluded
    source=merged["sources"].setdefault(experiment,{"clean":0,"excluded":0,"rawFiles":[]})
    source["clean"]+=clean; source["excluded"]+=excluded; source["rawFiles"].append(os.path.basename(path))
payload=json.dumps(list(out.values()),separators=(",",":"),default=dict).encode()
print(base64.b64encode(gzip.compress(payload)).decode())'''


def options():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ssh")
    parser.add_argument("--remote-sources")
    parser.add_argument("--remote-aggregate", type=Path,
                        help="Previously collected gzip/base64 remote aggregate")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--conditions", type=Path, default=ROOT / "scripts/policy_elo_conditions.json")
    parser.add_argument("--legacy-games", type=Path, default=ROOT / "elo_db/games.jsonl")
    parser.add_argument("--policy-archive", type=Path, default=ROOT / "elo_db/policy_archive")
    parser.add_argument("--timeout", type=int, default=600)
    return parser.parse_args()


def remote_edges(opt):
    if opt.remote_aggregate:
        return json.loads(gzip.decompress(base64.b64decode(opt.remote_aggregate.read_text().strip())))
    if not opt.ssh or not opt.remote_sources:
        raise SystemExit("--ssh and --remote-sources are required without --remote-aggregate")
    config = json.loads(opt.conditions.read_text())
    adapters = config["archiveConditionAdapters"]
    encoded = base64.b64encode(zlib.compress(REMOTE_AGGREGATOR.encode(), level=9)).decode()
    bootstrap = f'import base64,zlib;exec(zlib.decompress(base64.b64decode("{encoded}")))'
    command = " ".join([
        "python3", "-c", shlex.quote(bootstrap),
        shlex.quote(opt.remote_sources),
        shlex.quote(json.dumps(config["archiveExperiments"], separators=(",", ":"))),
        shlex.quote(json.dumps(adapters, separators=(",", ":"))),
    ])
    result = subprocess.run(
        ["ssh", opt.ssh, command], check=True, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=opt.timeout,
    )
    return json.loads(gzip.decompress(base64.b64decode(result.stdout.strip())))


def legacy_edges(path):
    edges = defaultdict(lambda: defaultdict(lambda: [0, 0, 0, 0]))
    with path.open() as stream:
        for line in stream:
            try:
                row = json.loads(line)
            except (TypeError, ValueError):
                continue
            if row.get("exp") != "rr72_policy_2026-08-01" or row.get("board") != "8x8":
                continue
            white, black = row["white"], row["black"]
            if white.get("arch") != "tf" or black.get("arch") != "tf":
                continue
            condition = f'{row["variant"]}-fixed-8x8'
            a, b = white["gen"], black["gen"]
            pair = (min(a, b), max(a, b))
            counts = edges[condition][pair]
            if (row.get("reason") == "no-legal-move" or row.get("legalityErrors")
                    or row.get("result") not in ("1-0", "0-1", "1/2-1/2")):
                counts[3] += 1
                continue
            if row["result"] == "1/2-1/2":
                counts[2] += 1
            else:
                winner = a if row["result"] == "1-0" else b
                counts[0 if winner == pair[0] else 1] += 1
    return [
        {"condition": condition, "a": pair[0], "b": pair[1],
         "winsA": counts[0], "winsB": counts[1], "draws": counts[2],
         "clean": sum(counts[:3]), "excluded": counts[3],
         "experiment": "rr72_policy_2026-08-01", "file": "games.jsonl"}
        for condition, pairs in edges.items() for pair, counts in pairs.items()
    ]


def canonical_edges(root):
    if not root.exists():
        return []
    merged = {}
    identities = {}
    for experiment_root in sorted(path for path in root.iterdir() if path.is_dir()):
        experiment = experiment_root.name
        for status, directory_name in (("accepted", "accepted"), ("excluded", "quarantine")):
            directory = experiment_root / directory_name
            if not directory.exists():
                continue
            for path in sorted(directory.glob("*.jsonl")):
                with path.open() as stream:
                    for number, line in enumerate(stream, 1):
                        try:
                            row = json.loads(line)
                        except (TypeError, ValueError) as error:
                            raise ValueError(f"malformed canonical row {path}:{number}") from error
                        game = row.get("game", {})
                        if (row.get("schema") != "wallgame-policy-elo-game-v2"
                                or row.get("experiment") != experiment or row.get("status") != status
                                or row.get("samples") != 1 or row.get("rootNoiseFactor") != 0
                                or row.get("moveSelection") != "policy-argmax"
                                or game.get("outcome") not in ("ours", "opp", "draw")
                                or not isinstance(game.get("legalityErrors"), list)):
                            raise ValueError(f"invalid canonical settings or shape {path}:{number}")
                        fingerprint = hashlib.sha256(
                            json.dumps(game, sort_keys=True, separators=(",", ":")).encode()
                        ).hexdigest()
                        identifier = row.get("gameId")
                        if not identifier or row.get("gameFingerprint") != fingerprint:
                            raise ValueError(f"invalid canonical identity {path}:{number}")
                        if identifier in identities:
                            if identities[identifier] != fingerprint:
                                raise ValueError(f"conflicting canonical game identity {identifier}")
                            continue
                        identities[identifier] = fingerprint
                        rejected = game.get("reason") == "no-legal-move" or bool(game["legalityErrors"])
                        if rejected != (status == "excluded"):
                            raise ValueError(f"canonical status disagrees with game {path}:{number}")
                        condition, a, b = row.get("conditionId"), row.get("generationA"), row.get("generationB")
                        if not isinstance(condition, str) or type(a) is not int or type(b) is not int:
                            raise ValueError(f"invalid canonical condition or generations {path}:{number}")
                        target = merged.setdefault((condition, a, b), {
                            "condition": condition, "a": a, "b": b,
                            "winsA": 0, "winsB": 0, "draws": 0, "clean": 0, "excluded": 0,
                            "sources": {},
                        })
                        if status == "accepted":
                            target["clean"] += 1
                            if game["outcome"] == "ours": target["winsA"] += 1
                            elif game["outcome"] == "opp": target["winsB"] += 1
                            else: target["draws"] += 1
                        else:
                            target["excluded"] += 1
                        source = target["sources"].setdefault(
                            experiment, {"clean": 0, "excluded": 0, "rawFiles": []},
                        )
                        source["clean" if status == "accepted" else "excluded"] += 1
                        relative = path.relative_to(root)
                        source["rawFiles"].append(f"{relative}#{identifier}")
    return list(merged.values())


def merge_edges(rows):
    merged = {}
    for row in rows:
        a, b = sorted((row["a"], row["b"]))
        wins_a, wins_b = row["winsA"], row["winsB"]
        if row["a"] != a:
            wins_a, wins_b = wins_b, wins_a
        key = (row["condition"], a, b)
        target = merged.setdefault(key, {
            "condition": row["condition"], "a": a, "b": b,
            "winsA": 0, "winsB": 0, "draws": 0, "clean": 0, "excluded": 0,
            "sources": {},
        })
        target["winsA"] += wins_a
        target["winsB"] += wins_b
        for field in ("draws", "clean", "excluded"):
            target[field] += row[field]
        sources = row.get("sources") or {
            row["experiment"]: {
                "clean": row["clean"], "excluded": row["excluded"],
                "rawFiles": [row["file"]],
            }
        }
        for source_name, source in sources.items():
            provenance = target["sources"].setdefault(
                source_name, {"clean": 0, "excluded": 0, "rawFiles": []},
            )
            provenance["clean"] += source["clean"]
            provenance["excluded"] += source["excluded"]
            provenance["rawFiles"] = sorted(set(provenance["rawFiles"] + source["rawFiles"]))
    return list(merged.values())


def components(edges):
    graph = defaultdict(set)
    for edge in edges:
        graph[edge["a"]].add(edge["b"])
        graph[edge["b"]].add(edge["a"])
    seen, groups = set(), []
    for start in sorted(graph):
        if start in seen:
            continue
        stack, group = [start], []
        seen.add(start)
        while stack:
            node = stack.pop()
            group.append(node)
            for other in graph[node]:
                if other not in seen:
                    seen.add(other)
                    stack.append(other)
        groups.append(sorted(group))
    return groups


def component_sources(edges):
    sources = {}
    for edge in edges:
        for source_name, source in edge["sources"].items():
            target = sources.setdefault(source_name, {"clean": 0, "excluded": 0, "rawFiles": []})
            target["clean"] += source["clean"]
            target["excluded"] += source["excluded"]
            target["rawFiles"] = sorted(set(target["rawFiles"] + source["rawFiles"]))
    return sources


def incremental_plan(config, by_condition):
    available = sorted({
        generation
        for coverage in config["artifactCoverage"] if coverage["status"] == "available"
        for generation in range(coverage["start"], coverage["end"] + 1)
    })
    supported = set(available)
    desired = sorted({
        tuple(sorted((generation, generation-delta)))
        for generation in available for delta in config["pairingDeltas"]
        if generation-delta in supported
    })
    pairings = []
    for condition in config["conditions"]:
        existing = {
            tuple(sorted((edge["a"], edge["b"]))): edge["clean"]
            for edge in by_condition[condition["id"]]
        }
        for a, b in desired:
            have = existing.get((a, b), 0)
            need = max(0, condition["gamesPerPair"] - have)
            if need:
                pairings.append({
                    "conditionId": condition["id"], "generationA": a, "generationB": b,
                    "cleanGames": have, "acceptedGamesNeeded": need,
                })
    return {
        "status": "data-only; freeze hashes and loadability with policy_elo_plan.py before execution",
        "availableGenerations": available, "desiredEdgesPerCondition": len(desired),
        "pairings": pairings,
        "summary": {"pairings": len(pairings), "acceptedGamesNeeded": sum(item["acceptedGamesNeeded"] for item in pairings)},
    }


def fit_component(edges, players, iterations=3000, prior=0.5):
    wins = Counter()
    games = defaultdict(Counter)
    for edge in edges:
        a, b = edge["a"], edge["b"]
        games[a][b] += edge["clean"]
        games[b][a] += edge["clean"]
        wins[a] += edge["winsA"] + edge["draws"] / 2
        wins[b] += edge["winsB"] + edge["draws"] / 2
    gamma = {player: 1.0 for player in players}
    for _ in range(iterations):
        updated = {}
        for player in players:
            denominator = sum(
                games[player][other] / (gamma[player] + gamma[other])
                for other in players if games[player][other]
            )
            denominator += 2 * prior / (gamma[player] + 1)
            updated[player] = (wins[player] + prior) / denominator
        gamma = updated
    ratings = {player: 400 * math.log10(value) for player, value in gamma.items()}
    floor = min(ratings.values())
    return [
        {"generation": player, "elo": round(ratings[player] - floor, 3),
         "games": sum(games[player].values())}
        for player in players
    ]


def build(opt):
    config = json.loads(opt.conditions.read_text())
    conditions = config["conditions"]
    remote = remote_edges(opt)
    canonical = canonical_edges(opt.policy_archive)
    remote_sources = {name for row in remote for name in row.get("sources", {})}
    canonical_sources = {name for row in canonical for name in row.get("sources", {})}
    overlap = sorted(remote_sources & canonical_sources)
    if overlap:
        raise ValueError(f"evidence source appears in raw and canonical archives: {overlap}")
    rows = merge_edges(legacy_edges(opt.legacy_games) + remote + canonical)
    by_condition = defaultdict(list)
    for row in rows:
        by_condition[row["condition"]].append(row)
    output = []
    for condition in conditions:
        edges = by_condition[condition["id"]]
        fitted, selected_edge_ids = [], set()
        clean_edges = [edge for edge in edges if edge["clean"] > 0]
        for index, players in enumerate(components(clean_edges), 1):
            selected = [edge for edge in edges if edge["a"] in players and edge["b"] in players]
            selected_edge_ids.update(id(edge) for edge in selected)
            fitted.append({
                "id": f'{condition["id"]}-component-{index}',
                "generations": players,
                "ratings": fit_component(selected, players),
                "cleanGames": sum(edge["clean"] for edge in selected),
                "excludedGames": sum(edge["excluded"] for edge in selected),
                "edges": len(selected),
                "minCleanGamesPerEdge": min(edge["clean"] for edge in selected),
                "maxCleanGamesPerEdge": max(edge["clean"] for edge in selected),
                "sources": component_sources(selected),
            })
        unconnected = [edge for edge in edges if id(edge) not in selected_edge_ids]
        evidence_generations = sorted({p for component in fitted for p in component["generations"]})
        output.append({
            **condition, "components": fitted, "evidenceGenerations": evidence_generations,
            "unconnectedExcludedGames": sum(edge["excluded"] for edge in unconnected),
            "unconnectedSources": component_sources(unconnected),
        })
    plan = incremental_plan(config, by_condition)
    return {
        "schema": "wallgame-policy-elo-app-v2",
        "generatedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "settings": {
            "samples": 1, "rootNoiseFactor": 0, "moveSelection": "policy argmax",
            "fit": "Bradley-Terry MM, 3000 iterations, one virtual draw versus a unit-strength anchor per player",
            "normalization": "weakest=0 inside each connected component",
            "archiveRule": "no-legal-move, legality errors, unfinished outcomes, and malformed rows excluded",
        },
        "artifactCoverage": config["artifactCoverage"],
        "variantLabels": config["variantLabels"],
        "conditions": output,
        "incrementalPlan": plan,
    }


def main():
    opt = options()
    data = build(opt)
    opt.output.parent.mkdir(parents=True, exist_ok=True)
    opt.output.write_text(json.dumps(data, indent=2) + "\n")
    print(json.dumps({
        "output": str(opt.output), "conditions": len(data["conditions"]),
        "components": sum(len(item["components"]) for item in data["conditions"]),
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
