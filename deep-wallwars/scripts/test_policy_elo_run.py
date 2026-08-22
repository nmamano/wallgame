import json
import tempfile
import unittest
from pathlib import Path

import policy_elo_run as runner


def plan():
    return {
        "experiment": "test",
        "windows": [{"id": "w1"}, {"id": "w2"}],
        "pairings": [{"windowId": "w1"}, {"windowId": "w2"}, {"windowId": "w2"}],
    }


class LauncherAuthorityTest(unittest.TestCase):
    def test_active_incomplete_run_has_no_success_authority(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.assertEqual(runner.completed_windows(root, plan()), {})
            self.assertFalse((root / "launcher-results" / "active.success.json").exists())

    def test_only_exact_durable_completions_count(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            completions = root / "completions"
            completions.mkdir()
            for window, count in (("w1", 1), ("w2", 2)):
                (completions / f"{window}.a.json").write_text(json.dumps({
                    "schema": runner.COMPLETION_SCHEMA,
                    "experiment": "test",
                    "window": window,
                    "attempt": "a",
                    "pairings": count,
                }) + "\n")
            self.assertEqual(set(runner.completed_windows(root, plan())), {"w1", "w2"})

    def test_off_plan_completion_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            completions = root / "completions"
            completions.mkdir()
            (completions / "wrong.a.json").write_text(json.dumps({
                "schema": runner.COMPLETION_SCHEMA,
                "experiment": "test",
                "window": "wrong",
                "pairings": 1,
            }))
            with self.assertRaisesRegex(runner.RunError, "off-plan"):
                runner.completed_windows(root, plan())

    def test_attempt_record_is_fail_if_existing(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "attempt.failure.json"
            runner.durable_exclusive_json(path, {"exitCode": 7})
            self.assertEqual(json.loads(path.read_text()), {"exitCode": 7})
            with self.assertRaises(FileExistsError):
                runner.durable_exclusive_json(path, {"exitCode": 0})


if __name__ == "__main__":
    unittest.main()
