#!/usr/bin/env python3

import copy
import json
import pathlib
import tempfile
import unittest
from unittest import mock

from closing_speed_ab import create_evidence, run_matrix_cases, run_rog_session, run_session


class FakeEngine:
    def __init__(self, terminal_ply):
        self.terminal_ply = terminal_ply
        self.requests = []

    def request(self, payload):
        self.requests.append(payload)
        if payload["type"] != "evaluate_position":
            return {"success": True}
        ply = payload["expectedPly"]
        return {
            "success": True,
            "bestMove": ">a1",
            "searchDiagnostics": {
                "currentWinner": "red" if ply == self.terminal_ply else "undecided",
            },
        }


class RolloutBudgetTest(unittest.TestCase):
    case = {
        "search": {"bgsId": "budget-test"},
        "config": {"fixture": "fake"},
    }

    def apply_requests(self, engine):
        return [request for request in engine.requests if request["type"] == "apply_move"]

    def test_closure_after_eightieth_applied_move_is_observed(self):
        engine = FakeEngine(terminal_ply=80)
        result = run_session(engine, self.case, rollout_plies=80)

        self.assertEqual(result["closure"]["ply"], 80)
        self.assertIsNone(result["exhaustedWithoutClosure"])
        self.assertEqual(len(self.apply_requests(engine)), 80)

    def test_closure_after_budget_is_not_observed(self):
        engine = FakeEngine(terminal_ply=81)
        result = run_session(engine, self.case, rollout_plies=80)

        self.assertIsNone(result["closure"])
        self.assertEqual(result["exhaustedWithoutClosure"], {
            "statePly": 80,
            "movesApplied": 80,
        })
        self.assertEqual(len(self.apply_requests(engine)), 80)
        evaluated = [request["expectedPly"] for request in engine.requests
                     if request["type"] == "evaluate_position"]
        self.assertEqual(evaluated, list(range(81)))


class RogFakeEngine:
    def __init__(self, terminal_after_apply=None, refuse_move=None, wrong_mouse=False,
                 refusal_overrides=None):
        self.terminal_after_apply = terminal_after_apply
        self.refuse_move = refuse_move
        self.wrong_mouse = wrong_mouse
        self.refusal_overrides = refusal_overrides or {}
        self.requests = []
        self.request_modes = []
        self.evaluations = 0
        self.applies = 0
        self.mouse = "h3"

    def request(self, payload, allow_failure=False):
        self.requests.append(payload)
        self.request_modes.append((payload, allow_failure))
        if payload["type"] == "evaluate_position":
            move = "Cg3" if self.evaluations % 2 == 0 else "Cg1"
            self.evaluations += 1
            return {
                "success": True,
                "bestMove": move,
                "searchDiagnostics": {
                    "currentWinner": "undecided",
                    "modelValue": 0.75,
                    "edges": [{"action": move, "visits": 10}],
                    "principalVariation": [{"depth": 1, "action": move}],
                },
            }
        if payload["type"] == "apply_move":
            if payload["move"] == self.refuse_move:
                response = {
                    "type": "move_applied",
                    "bgsId": payload["bgsId"],
                    "success": False,
                    "error": f"Failed to parse move notation: {payload['move']}",
                    "ply": payload["expectedPly"],
                }
                response.update(self.refusal_overrides)
                if not allow_failure:
                    raise RuntimeError(f"engine refused request: {response}")
                return response
            self.applies += 1
            mover = "red" if self.applies % 2 == 1 else "blue"
            if mover == "blue":
                self.mouse = "h1" if payload["move"] == "Mh1" else "h3"
            winner = mover if self.applies == self.terminal_after_apply else "undecided"
            cell = [5, 7] if self.mouse == "h3" else [7, 7]
            if self.wrong_mouse:
                cell = [0, 0]
            return {
                "success": True,
                "postApplyDiagnostics": {
                    "currentWinner": winner,
                    "nextPlayer": "blue" if mover == "red" else "red",
                    "nextTurn": "first",
                    "pawns": {"redCat": [5, 6], "blueMouse": cell},
                },
            }
        return {"success": True}


class RogScriptedOpponentTest(unittest.TestCase):
    case = {
        "id": "rog-budget-test",
        "search": {"bgsId": "rog-budget-test"},
        "config": {"fixture": "fake"},
        "modelTurnBudget": 40,
        "recordedModelMoves": ["Cg3" if i % 2 == 0 else "Cg1" for i in range(15)],
        "scriptedOpponentPolicy": {
            "player": "blue",
            "initialMouse": "h3",
            "h3": "Mh1",
            "h1": "Mh3",
            "gameFrameCells": {"h3": [5, 7], "h1": [7, 7]},
        },
    }

    def test_only_p1_is_evaluated_and_all_forty_turns_are_applied(self):
        engine = RogFakeEngine()
        result = run_rog_session(engine, self.case)

        evaluations = [r for r in engine.requests if r["type"] == "evaluate_position"]
        applies = [r for r in engine.requests if r["type"] == "apply_move"]
        self.assertEqual([r["expectedPly"] for r in evaluations], list(range(0, 80, 2)))
        self.assertEqual(len(applies), 80)
        self.assertEqual([r["move"] for r in applies[1::2]], [
            "Mh1" if i % 2 == 0 else "Mh3" for i in range(40)
        ])
        self.assertEqual(result["exhaustedWithoutClosure"], {
            "modelTurns": 40,
            "opponentTurns": 40,
            "totalPlies": 80,
        })

    def test_terminal_after_either_seat_stops_immediately(self):
        after_model = run_rog_session(RogFakeEngine(terminal_after_apply=1), self.case)
        self.assertEqual(after_model["closure"], {
            "winner": "red", "afterPlayer": "red",
            "modelTurns": 1, "opponentTurns": 0, "totalPlies": 1,
        })
        self.assertEqual(after_model["armOutcome"], "closure")
        self.assertIsNone(after_model["recordedEvasionBroken"])
        after_opponent = run_rog_session(RogFakeEngine(terminal_after_apply=2), self.case)
        self.assertEqual(after_opponent["closure"], {
            "winner": "blue", "afterPlayer": "blue",
            "modelTurns": 1, "opponentTurns": 1, "totalPlies": 2,
        })
        self.assertEqual(after_opponent["armOutcome"], "closure")
        self.assertIsNone(after_opponent["recordedEvasionBroken"])

    def test_off_cycle_or_wrong_authoritative_state_fails_closed(self):
        off_cycle = copy.deepcopy(self.case)
        off_cycle["scriptedOpponentPolicy"]["initialMouse"] = "g2"
        with self.assertRaisesRegex(RuntimeError, "off cycle"):
            run_rog_session(RogFakeEngine(), off_cycle)
        with self.assertRaisesRegex(RuntimeError, "authoritative blueMouse mismatch"):
            run_rog_session(RogFakeEngine(wrong_mouse=True), self.case)

    def test_off_exhaustion_and_on_recorded_evasion_break_are_distinct(self):
        shortcut_off = run_rog_session(RogFakeEngine(), self.case)
        shortcut_on = run_rog_session(RogFakeEngine(refuse_move="Mh3"), self.case)

        self.assertEqual(shortcut_off["armOutcome"], "exhausted")
        self.assertIsNotNone(shortcut_off["exhaustedWithoutClosure"])
        self.assertIsNone(shortcut_off["recordedEvasionBroken"])
        self.assertEqual(shortcut_on["armOutcome"], "recordedEvasionBroken")
        self.assertIsNone(shortcut_on["closure"])
        self.assertIsNone(shortcut_on["exhaustedWithoutClosure"])

    def test_recorded_evasion_break_is_only_after_a_successful_model_apply(self):
        engine = RogFakeEngine(refuse_move="Mh3")
        result = run_rog_session(engine, self.case)
        boundary = result["recordedEvasionBroken"]

        self.assertEqual(boundary["modelTurns"], 2)
        self.assertEqual(boundary["opponentTurns"], 1)
        self.assertEqual(boundary["totalSuccessfulPlies"], 3)
        self.assertEqual(boundary["expectedPly"], 3)
        self.assertEqual(boundary["rejectedMove"], "Mh3")
        self.assertEqual(boundary["failureResponse"]["success"], False)
        self.assertEqual(boundary["lastSuccessfulModelMove"], "Cg1")
        self.assertEqual(
            boundary["lastModelEvaluateDiagnostics"]["principalVariation"][0]["action"],
            "Cg1")
        self.assertEqual(boundary["postModelApplyDiagnostics"]["currentWinner"],
                         "undecided")
        rejected = [mode for mode in engine.request_modes
                    if mode[0].get("move") == "Mh3"]
        self.assertEqual(len(rejected), 1)
        self.assertTrue(rejected[0][1])

        with self.assertRaisesRegex(RuntimeError, "engine refused request"):
            run_rog_session(RogFakeEngine(refuse_move="Cg1"), self.case)

        with self.assertRaisesRegex(RuntimeError, "unexpected scripted opponent rejection"):
            run_rog_session(RogFakeEngine(
                refuse_move="Mh3",
                refusal_overrides={
                    "ply": 99,
                    "error": "Ply mismatch: expected 3, got 99",
                }), self.case)
        with self.assertRaisesRegex(RuntimeError, "unexpected scripted opponent rejection"):
            run_rog_session(RogFakeEngine(
                refuse_move="Mh3",
                refusal_overrides={"error": "Session not found"}), self.case)

    def test_completed_recorded_evasion_boundary_is_persisted(self):
        def case_runner(_engine, _model, case, shortcut, _rollout):
            fake = RogFakeEngine(refuse_move="Mh3") if shortcut else RogFakeEngine()
            return run_rog_session(fake, case)

        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / "evidence.json"
            evidence = {"cases": []}
            run_matrix_cases(
                evidence, [self.case], output, "engine", "model", False,
                case_runner=case_runner)
            saved = json.loads(output.read_text())

        saved_case = saved["cases"][0]
        self.assertEqual(saved["verdict"], "complete")
        self.assertEqual(saved_case["shortcutOff"]["armOutcome"], "exhausted")
        self.assertEqual(
            saved_case["shortcutOn"]["armOutcome"], "recordedEvasionBroken")
        self.assertEqual(
            saved_case["shortcutOn"]["recordedEvasionBroken"]["rejectedMove"],
            "Mh3")


class PartialEvidenceTest(unittest.TestCase):
    def test_unexpected_error_preserves_completed_prior_arm(self):
        case = {"id": "partial", "expectedBaselineMove": ">a1"}
        off = {"responses": [{"bestMove": ">a1"}]}
        calls = []

        def case_runner(_engine, _model, _case, shortcut, _rollout):
            calls.append(shortcut)
            if shortcut:
                raise RuntimeError("unexpected ON failure")
            return off

        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / "evidence.json"
            evidence = {"cases": []}
            with self.assertRaisesRegex(RuntimeError, "unexpected ON failure"):
                run_matrix_cases(
                    evidence, [case], output, "engine", "model", False,
                    case_runner=case_runner)
            saved = json.loads(output.read_text())

        self.assertEqual(calls, [False, True])
        self.assertEqual(saved["cases"][0]["shortcutOff"], off)
        self.assertNotIn("shortcutOn", saved["cases"][0])
        self.assertEqual(saved["error"]["caseId"], "partial")
        self.assertEqual(saved["error"]["arm"], "shortcutOn")


class SplitProvenanceTest(unittest.TestCase):
    def test_runner_and_engine_source_commits_are_recorded_separately(self):
        runner_commit = "5" * 40
        engine_commit = "1" * 40

        def git_output(command, text):
            self.assertTrue(text)
            if command[-1] == "HEAD":
                return runner_commit + "\n"
            self.assertEqual(command[-1], engine_commit + "^{commit}")
            return engine_commit + "\n"

        with tempfile.TemporaryDirectory() as directory:
            fixture = pathlib.Path(directory) / "fixture.json"
            fixture.write_text("{}\n")
            with mock.patch("closing_speed_ab.subprocess.check_output",
                            side_effect=git_output):
                evidence = create_evidence(
                    "engine", "engine-hash", engine_commit,
                    "model", "model-hash", fixture)

        self.assertEqual(evidence["runner"]["sourceCommit"], runner_commit)
        self.assertEqual(evidence["engine"]["sourceCommit"], engine_commit)
        self.assertNotIn("sourceCommit", evidence)


if __name__ == "__main__":
    unittest.main()
