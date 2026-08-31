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


def run_session(engine, case, rollout_plies=0):
    search = case["search"]
    bgs_id = search["bgsId"]
    responses = []
    closing = None
    pass_or_no_legal = None
    exhausted = None
    engine.request({"type": "start_game_session", "bgsId": bgs_id,
                    "botId": "closing-speed-ab", "config": case["config"]})
    move_budget = rollout_plies
    for ply in range(move_budget + 1):
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
        if ply == move_budget:
            if move_budget:
                exhausted = {"statePly": ply, "movesApplied": move_budget}
            break
        engine.request({"type": "apply_move", "bgsId": bgs_id,
                        "expectedPly": ply, "move": response["bestMove"]})
    engine.request({"type": "end_game_session", "bgsId": bgs_id})
    return {"responses": responses,
            "closure": closing, "passOrNoLegal": pass_or_no_legal,
            "exhaustedWithoutClosure": exhausted,
            "closedWithinRollout": closing is not None}


def require_post_apply(response, expected_player, expected_blue_mouse=None):
    if response.get("success") is not True:
        raise RuntimeError(f"scripted apply_move failed closed: {response}")
    post = response.get("postApplyDiagnostics")
    if not post:
        raise RuntimeError("apply_move response lacks postApplyDiagnostics")
    if post["currentWinner"] == "undecided" and (
            post["nextPlayer"] != expected_player or post["nextTurn"] != "first"):
        raise RuntimeError(f"unexpected post-apply turn: {post}")
    if expected_blue_mouse is not None:
        actual = post.get("pawns", {}).get("blueMouse")
        if actual != expected_blue_mouse:
            raise RuntimeError(
                f"authoritative blueMouse mismatch: expected {expected_blue_mouse}, got {actual}")
    return post


def rog_closure(post, model_turns, opponent_turns, after_player):
    if post["currentWinner"] == "undecided":
        return None
    return {
        "winner": post["currentWinner"],
        "afterPlayer": after_player,
        "modelTurns": model_turns,
        "opponentTurns": opponent_turns,
        "totalPlies": model_turns + opponent_turns,
    }


def run_rog_session(engine, case):
    search = case["search"]
    bgs_id = search["bgsId"]
    policy = case["scriptedOpponentPolicy"]
    cycle_cells = policy["gameFrameCells"]
    mouse = policy["initialMouse"]
    if mouse not in ("h3", "h1"):
        raise RuntimeError(f"scripted opponent mouse is off cycle: {mouse}")
    budget = case["modelTurnBudget"]
    recorded = case["recordedModelMoves"]
    evaluations = []
    applied = []
    model_moves = []
    recorded_mismatches = []
    closure = None
    model_turns = 0
    opponent_turns = 0
    engine.request({"type": "start_game_session", "bgsId": bgs_id,
                    "botId": "closing-speed-ab", "config": case["config"]})
    for model_index in range(budget):
        ply = model_turns + opponent_turns
        response = engine.request({"type": "evaluate_position", "bgsId": bgs_id,
                                   "expectedPly": ply})
        evaluations.append(response)
        if response["searchDiagnostics"]["currentWinner"] != "undecided":
            raise RuntimeError("rog fixture was terminal before the model turn")
        move = response["bestMove"]
        model_moves.append(move)
        if model_index < len(recorded) and move != recorded[model_index]:
            recorded_mismatches.append({
                "modelTurn": model_index + 1,
                "expected": recorded[model_index],
                "actual": move,
            })
        model_apply = engine.request({"type": "apply_move", "bgsId": bgs_id,
                                      "expectedPly": ply, "move": move})
        applied.append({"player": "red", "move": move, "response": model_apply})
        model_turns += 1
        post = require_post_apply(model_apply, "blue", cycle_cells[mouse])
        closure = rog_closure(post, model_turns, opponent_turns, "red")
        if closure:
            break

        if mouse == "h3":
            reply = policy["h3"]
            next_mouse = "h1"
        elif mouse == "h1":
            reply = policy["h1"]
            next_mouse = "h3"
        else:
            raise RuntimeError(f"scripted opponent mouse is off cycle: {mouse}")
        opponent_apply = engine.request({"type": "apply_move", "bgsId": bgs_id,
                                         "expectedPly": ply + 1, "move": reply})
        applied.append({"player": "blue", "move": reply, "response": opponent_apply})
        opponent_turns += 1
        post = require_post_apply(opponent_apply, "red", cycle_cells[next_mouse])
        mouse = next_mouse
        closure = rog_closure(post, model_turns, opponent_turns, "blue")
        if closure:
            break
    engine.request({"type": "end_game_session", "bgsId": bgs_id})
    exhausted = None if closure else {
        "modelTurns": model_turns,
        "opponentTurns": opponent_turns,
        "totalPlies": model_turns + opponent_turns,
    }
    return {
        "responses": evaluations,
        "appliedMoves": applied,
        "modelMoves": model_moves,
        "recordedPrefixReproduced": not recorded_mismatches,
        "recordedPrefixMismatches": recorded_mismatches,
        "closure": closure,
        "passOrNoLegal": None,
        "exhaustedWithoutClosure": exhausted,
        "closedWithinRollout": closure is not None,
    }


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
    stderr = ""
    try:
        if "scriptedOpponentPolicy" in case:
            result = run_rog_session(engine, case)
        else:
            result = run_session(engine, case, rollout_plies)
    finally:
        stderr = engine.close()
    return {"command": command, "stderr": stderr, **result}


def baseline_reproduced(case, result):
    if "scriptedOpponentPolicy" in case:
        exhausted = result["exhaustedWithoutClosure"]
        return (result["recordedPrefixReproduced"] and result["closure"] is None and
                exhausted is not None and
                exhausted["modelTurns"] == case["modelTurnBudget"] and
                exhausted["opponentTurns"] == case["modelTurnBudget"])
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
        rollout = 0
        off = run_case(args.engine, args.model, case, False, rollout)
        on = run_case(args.engine, args.model, case, True, rollout)
        reproduced = baseline_reproduced(case, off)
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
