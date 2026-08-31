#!/usr/bin/env python3

import copy
import unittest

from closing_speed_ab import run_rog_session, run_session


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
    def __init__(self, terminal_after_apply=None, refuse_move=None):
        self.terminal_after_apply = terminal_after_apply
        self.refuse_move = refuse_move
        self.requests = []
        self.evaluations = 0
        self.applies = 0

    def request(self, payload):
        self.requests.append(payload)
        if payload["type"] == "evaluate_position":
            move = "Cg3" if self.evaluations % 2 == 0 else "Cg1"
            self.evaluations += 1
            return {
                "success": True,
                "bestMove": move,
                "searchDiagnostics": {"currentWinner": "undecided"},
            }
        if payload["type"] == "apply_move":
            if payload["move"] == self.refuse_move:
                return {"success": False, "error": "scripted move is illegal"}
            self.applies += 1
            mover = "red" if self.applies % 2 == 1 else "blue"
            winner = mover if self.applies == self.terminal_after_apply else "undecided"
            return {
                "success": True,
                "postApplyDiagnostics": {
                    "currentWinner": winner,
                    "nextPlayer": "blue" if mover == "red" else "red",
                    "nextTurn": "first",
                },
            }
        return {"success": True}


class RogScriptedOpponentTest(unittest.TestCase):
    case = {
        "search": {"bgsId": "rog-budget-test"},
        "config": {"fixture": "fake"},
        "modelTurnBudget": 40,
        "recordedModelMoves": ["Cg3" if i % 2 == 0 else "Cg1" for i in range(15)],
        "scriptedOpponentPolicy": {
            "player": "blue",
            "initialMouse": "h3",
            "h3": "Mh1",
            "h1": "Mh3",
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
        after_opponent = run_rog_session(RogFakeEngine(terminal_after_apply=2), self.case)
        self.assertEqual(after_opponent["closure"], {
            "winner": "blue", "afterPlayer": "blue",
            "modelTurns": 1, "opponentTurns": 1, "totalPlies": 2,
        })

    def test_off_cycle_or_illegal_scripted_state_fails_closed(self):
        off_cycle = copy.deepcopy(self.case)
        off_cycle["scriptedOpponentPolicy"]["initialMouse"] = "g2"
        with self.assertRaisesRegex(RuntimeError, "off cycle"):
            run_rog_session(RogFakeEngine(), off_cycle)
        with self.assertRaisesRegex(RuntimeError, "failed closed"):
            run_rog_session(RogFakeEngine(refuse_move="Mh1"), self.case)


if __name__ == "__main__":
    unittest.main()
