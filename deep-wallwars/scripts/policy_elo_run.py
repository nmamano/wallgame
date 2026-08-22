#!/usr/bin/env python3
"""Resume a frozen policy-Elo plan with truthful attempt-scoped authority."""

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path

COMPLETION_SCHEMA = "wallgame-policy-elo-window-completion-v1"
SUCCESS_SCHEMA = "wallgame-policy-elo-run-success-v1"
FAILURE_SCHEMA = "wallgame-policy-elo-run-failure-v1"


class RunError(ValueError):
    pass


def durable_exclusive_json(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(record, sort_keys=True, indent=2) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def expected_windows(plan):
    ids = [window["id"] for window in plan["windows"]]
    if len(ids) != len(set(ids)):
        raise RunError("plan has duplicate window IDs")
    pairings = {}
    for pairing in plan["pairings"]:
        pairings[pairing["windowId"]] = pairings.get(pairing["windowId"], 0) + 1
    if set(pairings) != set(ids):
        raise RunError("plan window and pairing membership differ")
    return ids, pairings


def completed_windows(run_root, plan):
    ids, pairings = expected_windows(plan)
    expected = set(ids)
    found = {}
    completion_root = run_root / "completions"
    for path in sorted(completion_root.glob("*.json")) if completion_root.exists() else []:
        try:
            record = json.loads(path.read_text())
        except (OSError, ValueError) as error:
            raise RunError(f"malformed completion {path}: {error}") from error
        window = record.get("window")
        if record.get("schema") != COMPLETION_SCHEMA:
            raise RunError(f"wrong completion schema: {path}")
        if record.get("experiment") != plan["experiment"]:
            raise RunError(f"completion experiment differs: {path}")
        if window not in expected:
            raise RunError(f"completion names off-plan window {window!r}: {path}")
        if record.get("pairings") != pairings[window]:
            raise RunError(f"completion pairing count differs: {path}")
        found.setdefault(window, []).append({"path": str(path), "sha256": sha256(path)})
    return found


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--bun", default="bun")
    parser.add_argument(
        "--runner", type=Path,
        default=Path(__file__).with_name("policy_elo_window.ts"),
    )
    return parser.parse_args()


def main():
    args = parse_args()
    plan_path = args.plan.resolve()
    run_root = args.run_root.resolve()
    plan = json.loads(plan_path.read_text())
    window_ids, _ = expected_windows(plan)
    authority = run_root / "launcher-results"
    success_path = authority / f"{args.attempt}.success.json"
    failure_path = authority / f"{args.attempt}.failure.json"
    if success_path.exists() or failure_path.exists():
        raise RunError(f"launcher attempt already has an authority record: {args.attempt}")

    completed = completed_windows(run_root, plan)
    for window in window_ids:
        if window in completed:
            continue
        command = [
            args.bun, str(args.runner.resolve()),
            "--plan", str(plan_path), "--window", window,
            "--run-root", str(run_root), "--attempt", args.attempt,
        ]
        try:
            result = subprocess.run(command, check=False)
            exit_code = result.returncode
            reason = None
        except OSError as error:
            exit_code = 127
            reason = str(error)
        if exit_code != 0:
            durable_exclusive_json(failure_path, {
                "schema": FAILURE_SCHEMA,
                "experiment": plan["experiment"],
                "attempt": args.attempt,
                "window": window,
                "exitCode": exit_code,
                "reason": reason,
                "completedWindows": sorted(completed),
            })
            raise SystemExit(exit_code)
        completed = completed_windows(run_root, plan)
        if window not in completed:
            durable_exclusive_json(failure_path, {
                "schema": FAILURE_SCHEMA,
                "experiment": plan["experiment"],
                "attempt": args.attempt,
                "window": window,
                "exitCode": 1,
                "reason": "runner exited zero without a valid durable completion",
                "completedWindows": sorted(completed),
            })
            raise SystemExit(1)

    completed = completed_windows(run_root, plan)
    missing = [window for window in window_ids if window not in completed]
    if missing:
        durable_exclusive_json(failure_path, {
            "schema": FAILURE_SCHEMA,
            "experiment": plan["experiment"],
            "attempt": args.attempt,
            "exitCode": 1,
            "reason": f"{len(missing)} windows lack durable completion",
            "completedWindows": sorted(completed),
        })
        raise SystemExit(1)
    durable_exclusive_json(success_path, {
        "schema": SUCCESS_SCHEMA,
        "experiment": plan["experiment"],
        "attempt": args.attempt,
        "plan": str(plan_path),
        "planSha256": sha256(plan_path),
        "windows": len(window_ids),
        "completionEvidence": completed,
    })
    print(json.dumps({"complete": True, "windows": len(window_ids)}, separators=(",", ":")))


if __name__ == "__main__":
    main()
