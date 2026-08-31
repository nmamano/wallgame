#!/usr/bin/env python3
"""Run the frozen closing-speed shortcut A/B against one immutable engine/model pair."""

import argparse
import hashlib
import json
import pathlib
import subprocess
import tempfile


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class Engine:
    def __init__(self, command):
        self.stderr = tempfile.TemporaryFile(mode="w+")
        self.process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self.stderr, text=True, bufsize=1)

    def request(self, payload):
        self.process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("engine ended before response: " + self.stderr_text())
        response = json.loads(line)
        if response.get("success") is False:
            raise RuntimeError(f"engine refused request: {response}")
        return response

    def close(self):
        error = None
        if self.process.poll() is None:
            self.process.stdin.close()
            code = self.process.wait(timeout=60)
            if code:
                error = f"engine exited {code}"
        text = self.stderr_text()
        self.stderr.close()
        if error:
            raise RuntimeError(f"{error}: {text}")
        return text

    def stderr_text(self):
        self.stderr.flush()
        self.stderr.seek(0)
        text = self.stderr.read()
        self.stderr.seek(0, 2)
        return text


def run_case(engine_path, model_path, case, shortcut, rollout_plies=0):
    search = case["search"]
    command = [
        engine_path, "--model", model_path,
        "--samples", str(search["samples"]),
        "--parallel_samples", "32", "--thread_pool_size", "4",
        "--root_noise_factor", str(search["rootNoise"]),
        "--seed", str(search["seed"]), "--search_diagnostics",
    ]
    if shortcut:
        command.append("--terminal_after_first_action_shortcut")
    engine = Engine(command)
    bgs_id = search["bgsId"]
    responses = []
    closing = None
    pass_or_no_legal = None
    stderr = ""
    try:
        engine.request({"type": "start_game_session", "bgsId": bgs_id,
                        "botId": "closing-speed-ab", "config": case["config"]})
        limit = rollout_plies or 1
        for ply in range(limit):
            response = engine.request({"type": "evaluate_position", "bgsId": bgs_id,
                                       "expectedPly": ply})
            responses.append(response)
            diagnostics = response["searchDiagnostics"]
            if diagnostics["currentWinner"] != "undecided":
                closing = {"winner": diagnostics["currentWinner"], "ply": ply,
                           "playerTurnsPlayed": ply,
                           "fullTurnsCompleted": ply // 2,
                           "fullTurnNumber": (ply + 1) // 2}
                break
            if response["bestMove"] == "---":
                pass_or_no_legal = {"ply": ply, "bestMove": "---"}
                break
            if ply + 1 < limit:
                engine.request({"type": "apply_move", "bgsId": bgs_id,
                                "expectedPly": ply, "move": response["bestMove"]})
        engine.request({"type": "end_game_session", "bgsId": bgs_id})
    finally:
        stderr = engine.close()
    return {"command": command, "stderr": stderr, "responses": responses,
            "closure": closing, "passOrNoLegal": pass_or_no_legal,
            "closedWithinRollout": closing is not None}


def baseline_reproduced(case, result):
    move = result["responses"][0]["bestMove"]
    if "expectedBaselineMove" in case:
        return move == case["expectedBaselineMove"]
    if "expectedBaselineMoves" in case:
        return move in case["expectedBaselineMoves"]
    if case["id"] == "dfbffab8-UD-4x4-control":
        return move == case["expectedMove"]
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", required=True)
    parser.add_argument("--engine-sha256", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-sha256", required=True)
    parser.add_argument("--fixtures", default="test/fixtures/closing-speed.json")
    parser.add_argument("--output", required=True)
    parser.add_argument("--require-known-bad", action="store_true")
    args = parser.parse_args()

    output_path = pathlib.Path(args.output)
    if output_path.exists():
        raise RuntimeError("refusing to overwrite existing output")

    if sha256(args.engine) != args.engine_sha256:
        raise RuntimeError("engine hash mismatch")
    if sha256(args.model) != args.model_sha256:
        raise RuntimeError("model hash mismatch")
    fixture_path = pathlib.Path(args.fixtures)
    fixtures = json.loads(fixture_path.read_text())
    evidence = {
        "sourceCommit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True).strip(),
        "runner": {"path": str(pathlib.Path(__file__).resolve()),
                   "sha256": sha256(__file__)},
        "engine": {"path": args.engine, "sha256": args.engine_sha256},
        "model": {"path": args.model, "sha256": args.model_sha256},
        "fixtures": {"path": str(fixture_path), "sha256": sha256(fixture_path)},
        "cases": [],
    }
    failures = []
    for case in fixtures["cases"]:
        rollout = 80 if case["id"] == "rogYDkzs-p61" else 0
        off = run_case(args.engine, args.model, case, False, rollout)
        on = run_case(args.engine, args.model, case, True, rollout)
        reproduced = baseline_reproduced(case, off)
        if case["id"] == "rogYDkzs-p61":
            reproduced = reproduced and not off["closedWithinRollout"]
        if not reproduced:
            failures.append(case["id"])
        evidence["cases"].append({"id": case["id"], "baselineKnownBad": reproduced,
                                  "shortcutOff": off, "shortcutOn": on})
    with output_path.open("x") as stream:
        json.dump(evidence, stream, indent=2)
        stream.write("\n")
    if failures and args.require_known_bad:
        raise RuntimeError("known-bad baseline did not reproduce: " + ", ".join(failures))


if __name__ == "__main__":
    main()
