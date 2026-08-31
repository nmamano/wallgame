#!/usr/bin/env python3

import unittest

from closing_speed_ab import run_session


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


if __name__ == "__main__":
    unittest.main()
