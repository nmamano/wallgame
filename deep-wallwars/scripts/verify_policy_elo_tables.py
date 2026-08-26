#!/usr/bin/env python3
"""Check the tracked results tables against the shipped policy Elo snapshot.

The point of the tables is checkout-only reconstruction: after the 2026-08-23
backfill landing, `build_policy_elo_app_data.py` builds the phase 7 policy
experiments and the generations 1-140 evidence from
`elo_db/results/*.csv` instead of reaching the 4090 desktop over SSH. This script
proves the tables carry the same evidence the shipped snapshot was built from,
and it needs no desktop access at all.

    python3 deep-wallwars/scripts/verify_policy_elo_tables.py

It compares, per experiment: accepted (clean) games, excluded games, and the set of
raw source files. It also asserts the three totals measured on 2026-08-26:
290,138 rows, 290,135 accepted, 3 excluded.

It does NOT compare `generatedAtUtc` or require a byte-identical snapshot file; a
timestamp differing is not a difference in evidence.
"""
import argparse
import base64
import gzip
import json
import subprocess
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_policy_elo_app_data import REMOTE_AGGREGATOR, table_edges  # noqa: E402
from elo_results_tables import TableError, read_table, results_record  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CONDITIONS = ROOT / "scripts/policy_elo_conditions.json"
SNAPSHOT = ROOT / "policy-elo-app/data/policy-elo.json"
TABLES = ROOT / "elo_db/results"
EXPERIMENTS = ROOT / "elo_db/experiments.json"

EXPECTED_ROWS = 290138
EXPECTED_CLEAN = 290135
EXPECTED_EXCLUDED = 3


def snapshot_sources(snapshot):
    """Per-source clean/excluded/rawFiles as the shipped snapshot records them.

    Components and `unconnectedSources` are disjoint by construction - the builder
    selects unconnected edges by identity, from those not already taken - so summing
    both does not double count.
    """
    found = {}

    def visit(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if isinstance(value, dict) and "clean" in value and "excluded" in value:
                    entry = found.setdefault(
                        key, {"clean": 0, "excluded": 0, "rawFiles": set()},
                    )
                    entry["clean"] += value["clean"]
                    entry["excluded"] += value["excluded"]
                    entry["rawFiles"].update(value.get("rawFiles", []))
                else:
                    visit(value)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(snapshot)
    return found


def table_integrity(experiments):
    """Read every tracked table through the shared gate, including the non-policy ones.

    The builder already applies this gate to the eight policy tables on its normal
    path. This covers the four search-strength tables as well, which are registered
    evidence but never enter the policy snapshot, so nothing else would read them.
    """
    problems = []
    checked = 0
    for name, entry in sorted(experiments.items()):
        if not entry.get("results"):
            continue
        try:
            read_table(ROOT.parent / entry["results"]["path"], name,
                       results_record(experiments, name))
            checked += 1
        except TableError as exc:
            problems.append(str(exc))
    return checked, problems


def raw_edges(raw_sources, config):
    """Run the builder's own raw aggregator over the JSONL archives.

    Only possible where the archives are - the 4090 desktop. The shipped snapshot
    keeps no per-edge win/loss/draw counts, so this is the only way to check that
    half of the equivalence.
    """
    encoded = base64.b64encode(zlib.compress(REMOTE_AGGREGATOR.encode(), level=9)).decode()
    bootstrap = f'import base64,zlib;exec(zlib.decompress(base64.b64decode("{encoded}")))'
    result = subprocess.run(
        [sys.executable, "-c", bootstrap, str(raw_sources),
         json.dumps(config["archiveExperiments"], separators=(",", ":")),
         json.dumps(config["archiveConditionAdapters"], separators=(",", ":"))],
        check=True, text=True, stdout=subprocess.PIPE,
    )
    return json.loads(gzip.decompress(base64.b64decode(result.stdout.strip())))


def compare_edges(tables, raw):
    """Every edge must agree on condition, both ends, wins, draws, clean and excluded."""
    def key(edge):
        return (edge["condition"], edge["a"], edge["b"])

    left = {key(e): e for e in tables}
    right = {key(e): e for e in raw}
    problems = []
    if set(left) != set(right):
        problems.append(
            "edge sets differ: %d only from tables, %d only from raw"
            % (len(set(left) - set(right)), len(set(right) - set(left)))
        )
    for k in sorted(set(left) & set(right)):
        for field in ("winsA", "winsB", "draws", "clean", "excluded"):
            if left[k][field] != right[k][field]:
                problems.append(
                    "edge %s: %s is %d from tables, %d from raw"
                    % (k, field, left[k][field], right[k][field])
                )
        for name, source in left[k]["sources"].items():
            other = right[k]["sources"].get(name)
            if other is None:
                problems.append("edge %s: source %s missing from raw" % (k, name))
            elif sorted(source["rawFiles"]) != sorted(other["rawFiles"]):
                problems.append("edge %s: source %s raw file list differs" % (k, name))
    return problems


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-sources", type=Path,
                        help="elo_db/sources on the box that holds the raw archives. "
                             "Adds a per-edge win/loss/draw comparison the snapshot "
                             "cannot provide.")
    opt = parser.parse_args()

    config = json.loads(CONDITIONS.read_text())
    policy_names = set(config["archiveExperiments"])
    experiments = json.loads(EXPERIMENTS.read_text())

    # Read every table through the gate first. If one is bad, say so plainly here
    # rather than letting the aggregation below raise on the way past.
    checked, problems = table_integrity(experiments)
    print("tables read through the shared fingerprint and schema gate: %d" % checked)
    if problems:
        for problem in problems:
            print("FAIL: %s" % problem)
        return 1

    tables = table_edges(TABLES, config, experiments)
    from_tables = {}
    for edge in tables:
        for name, source in edge["sources"].items():
            entry = from_tables.setdefault(
                name, {"clean": 0, "excluded": 0, "rawFiles": set()},
            )
            entry["clean"] += source["clean"]
            entry["excluded"] += source["excluded"]
            entry["rawFiles"].update(source["rawFiles"])

    from_snapshot = {
        name: value
        for name, value in snapshot_sources(json.loads(SNAPSHOT.read_text())).items()
        if name in policy_names
    }

    if set(from_tables) != set(from_snapshot):
        problems.append(
            "experiment sets differ: tables %s, snapshot %s"
            % (sorted(set(from_tables) - set(from_snapshot)),
               sorted(set(from_snapshot) - set(from_tables)))
        )

    total_rows = total_clean = total_excluded = 0
    for name in sorted(set(from_tables) & set(from_snapshot)):
        table, shipped = from_tables[name], from_snapshot[name]
        total_clean += table["clean"]
        total_excluded += table["excluded"]
        total_rows += table["clean"] + table["excluded"]
        for field in ("clean", "excluded"):
            if table[field] != shipped[field]:
                problems.append(
                    "%s: %s is %d in the tables, %d in the snapshot"
                    % (name, field, table[field], shipped[field])
                )
        if table["rawFiles"] != shipped["rawFiles"]:
            problems.append(
                "%s: raw file coverage differs (%d in tables, %d in snapshot, "
                "%d only in tables, %d only in snapshot)"
                % (name, len(table["rawFiles"]), len(shipped["rawFiles"]),
                   len(table["rawFiles"] - shipped["rawFiles"]),
                   len(shipped["rawFiles"] - table["rawFiles"]))
            )
        print("%-56s %5d accepted  %2d excluded  %3d files"
              % (name[:56], table["clean"], table["excluded"], len(table["rawFiles"])))

    for label, got, want in (
        ("rows", total_rows, EXPECTED_ROWS),
        ("accepted", total_clean, EXPECTED_CLEAN),
        ("excluded", total_excluded, EXPECTED_EXCLUDED),
    ):
        if got != want:
            problems.append("total %s is %d, expected %d" % (label, got, want))

    print("\ntotals: %d rows, %d accepted, %d excluded" % (total_rows, total_clean, total_excluded))

    if opt.raw_sources:
        edge_problems = compare_edges(tables, raw_edges(opt.raw_sources, config))
        problems.extend(edge_problems)
        print("per-edge comparison against the raw archives: %d edges, %d disagreements"
              % (len(tables), len(edge_problems)))
    else:
        print("per-edge win/loss/draw comparison skipped - pass --raw-sources on the box "
              "that holds the archives")
    if problems:
        for problem in problems:
            print("FAIL: %s" % problem)
        return 1
    print("OK: tracked tables match the shipped snapshot for all %d policy experiments"
          % len(from_tables))
    return 0


if __name__ == "__main__":
    sys.exit(main())
