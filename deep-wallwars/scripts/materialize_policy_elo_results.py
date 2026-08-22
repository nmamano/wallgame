#!/usr/bin/env python3
"""Materialize exact v1 Elo evidence from accepted policy-Elo journals."""

import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path

from elo_results_tables import COLUMNS


class MaterializeError(ValueError):
    pass


def game_identity(experiment, pairing, game_index):
    fields = [
        experiment, pairing["conditionId"], pairing["generationA"],
        pairing["generationB"], game_index,
    ]
    return hashlib.sha256("\0".join(str(value) for value in fields).encode()).hexdigest()


def expected_games(plan):
    expected = {}
    for pairing in plan["pairings"]:
        for offset in range(pairing["games"]):
            game_index = pairing["existingAcceptedGames"] + offset
            identity = game_identity(plan["experiment"], pairing, game_index)
            if identity in expected:
                raise MaterializeError(f"plan repeats game ID {identity}")
            expected[identity] = (pairing, game_index)
    return expected


def read_journals(raw_root, plan):
    expected = expected_games(plan)
    records = {}
    for path in sorted(raw_root.glob("*/*.jsonl")):
        relative = path.relative_to(raw_root).as_posix()
        with path.open("rb") as stream:
            for line_number, raw_line in enumerate(stream, 1):
                if not raw_line.endswith(b"\n"):
                    raise MaterializeError(f"torn raw row: {relative}:{line_number}")
                payload = raw_line[:-1]
                try:
                    row = json.loads(payload)
                except ValueError as error:
                    raise MaterializeError(
                        f"malformed raw row: {relative}:{line_number}: {error}"
                    ) from error
                identity = row.get("gameId")
                where = f"{relative}:{line_number}"
                if identity not in expected:
                    raise MaterializeError(f"off-plan game ID {identity!r}: {where}")
                raw_record_sha256 = hashlib.sha256(payload).hexdigest()
                if row.get("accepted") is False:
                    recovered = (
                        path.parent / "failures" / "recovered"
                        / f"{identity}.{raw_record_sha256}.json"
                    )
                    if not recovered.exists():
                        raise MaterializeError(
                            f"failed root row lacks exact recovered artifact: {where}"
                        )
                    if recovered.read_bytes() != raw_line:
                        raise MaterializeError(
                            f"recovered failure artifact differs from root row: {where}"
                        )
                    continue
                if identity in records:
                    raise MaterializeError(f"duplicate raw game ID {identity}: {where}")
                if row.get("accepted") is not True or row.get("failure") is not None:
                    raise MaterializeError(f"failed or unaccepted game in accepted journal: {where}")
                pairing, game_index = expected[identity]
                expected_p1 = (
                    pairing["generationA"] if game_index % 2 == 0
                    else pairing["generationB"]
                )
                expected_p2 = (
                    pairing["generationB"] if game_index % 2 == 0
                    else pairing["generationA"]
                )
                checks = {
                    "experiment": plan["experiment"],
                    "conditionId": pairing["conditionId"],
                    "variant": pairing["variant"],
                    "setup": pairing["setup"],
                    "boardWidth": pairing["width"],
                    "boardHeight": pairing["height"],
                    "gameIndex": game_index,
                    "p1Generation": expected_p1,
                    "p2Generation": expected_p2,
                }
                for field, value in checks.items():
                    if row.get(field) != value:
                        raise MaterializeError(
                            f"{where}: {field}={row.get(field)!r}, expected {value!r}"
                        )
                if row.get("winner") not in ("p1", "p2", "draw"):
                    raise MaterializeError(f"{where}: invalid winner {row.get('winner')!r}")
                records[identity] = {
                    "row": row,
                    "sourceFile": relative,
                    "line": line_number,
                    "rawRecordSha256": raw_record_sha256,
                    "pairing": pairing,
                    "gameIndex": game_index,
                }
    missing = sorted(set(expected) - set(records))
    if missing:
        raise MaterializeError(f"accepted journals lack {len(missing)} expected game IDs")
    return records


def build_outputs(raw_root, plan):
    records = read_journals(raw_root, plan)
    ordered = sorted(
        records.items(),
        key=lambda item: (
            item[1]["pairing"]["conditionId"],
            item[1]["pairing"]["generationA"],
            item[1]["pairing"]["generationB"],
            item[1]["gameIndex"],
        ),
    )
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=COLUMNS, lineterminator="\n")
    writer.writeheader()
    fingerprints = []
    for identity, record in ordered:
        row = record["row"]
        pairing = record["pairing"]
        p1 = row["p1Generation"]
        p2 = row["p2Generation"]
        writer.writerow({
            "exp": plan["experiment"],
            "sourceFile": record["sourceFile"],
            "conditionId": pairing["conditionId"],
            "variant": pairing["variant"],
            "setup": pairing["setup"],
            "board": f"{pairing['width']}x{pairing['height']}",
            "p1": f"tf:{p1}",
            "p2": f"tf:{p2}",
            "candidateIsP1": "true" if p1 == pairing["generationB"] else "false",
            "winner": row["winner"],
            "evidenceStatus": "accepted",
            "exclusionReason": "",
            "engineSeed": row["engineSeed"],
            "randomStartSeed": "" if row["randomStartSeed"] is None else row["randomStartSeed"],
            "game": record["gameIndex"],
        })
        fingerprints.append({
            "gameId": identity,
            "rawRecordSha256": record["rawRecordSha256"],
            "sourceFile": record["sourceFile"],
            "line": record["line"],
        })
    table = output.getvalue().encode()
    fingerprint_payload = (json.dumps({
        "schema": "wallgame-policy-elo-raw-fingerprints-v1",
        "experiment": plan["experiment"],
        "rows": len(fingerprints),
        "records": fingerprints,
    }, sort_keys=True, indent=2) + "\n").encode()
    return table, fingerprint_payload


def write_exclusive(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--raw-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fingerprints", type=Path, required=True)
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text())
    table, fingerprints = build_outputs(args.raw_root, plan)
    write_exclusive(args.output, table)
    write_exclusive(args.fingerprints, fingerprints)
    print(json.dumps({
        "rows": table.count(b"\n") - 1,
        "tableSha256": hashlib.sha256(table).hexdigest(),
        "fingerprintsSha256": hashlib.sha256(fingerprints).hexdigest(),
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
