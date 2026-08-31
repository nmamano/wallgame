import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from materialized_resume import verify_materialized_progress


def record(index: int) -> dict:
    return {
        "gameIndex": index,
        "seed": 730117,
        "gameSeed": index * 17,
        "variant": "standard",
        "boardWidth": 8,
        "boardHeight": 8,
        "dimensionMode": "low",
        "startMode": "traditional",
        "initialState": {"pawns": {"marker": index}, "walls": []},
    }


def replacement(source: dict, game_index: int, attempt: int) -> dict:
    result = copy.deepcopy(source)
    result.update(
        {
            "gameIndex": game_index,
            "gameSeed": 1000 + game_index,
            "replacementOfGameIndex": source["gameIndex"],
            "replacementAttempt": attempt,
            "replacementIdentity": f'{source["gameIndex"]}:{attempt}',
        }
    )
    return result


class MaterializedReplacementTest(unittest.TestCase):
    def write_attempt(self, root: Path, index: int, initial_record: dict, cap=False) -> None:
        if not cap:
            (root / f"game_{index}.csv").write_text("csv")
        (root / f"game_{index}.audit.json").write_text(
            json.dumps(
                {
                    "objectiveVersion": "terminal-turn-discount-v1",
                    "endReason": "move-limit" if cap else "terminal",
                    "initialStateRecord": initial_record,
                }
            )
        )

    def test_zero_caps_needs_no_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = [record(index) for index in range(1, 4)]
            for index, item in enumerate(expected, 1):
                self.write_attempt(root, index, item)
            progress = verify_materialized_progress(root, expected)
            self.assertEqual((progress.admitted, progress.replacements), (3, ()))

    def test_one_and_multiple_caps_replace_in_the_same_cell(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = [record(index) for index in range(1, 4)]
            self.write_attempt(root, 1, expected[0], cap=True)
            self.write_attempt(root, 2, expected[1], cap=True)
            self.write_attempt(root, 3, expected[2])
            progress = verify_materialized_progress(root, expected)
            self.assertEqual(
                [(item.source_game_index, item.replacement_attempt, item.game_index)
                 for item in progress.replacements],
                [(1, 1, 4), (2, 1, 5)],
            )
            self.write_attempt(root, 4, replacement(expected[0], 4, 1), cap=True)
            self.write_attempt(root, 5, replacement(expected[1], 5, 1))
            progress = verify_materialized_progress(root, expected)
            self.assertEqual(
                [(item.source_game_index, item.replacement_attempt, item.game_index)
                 for item in progress.replacements],
                [(1, 2, 6)],
            )
            self.write_attempt(root, 6, replacement(expected[0], 6, 2))
            done = verify_materialized_progress(root, expected)
            self.assertEqual((done.admitted, done.replacements), (3, ()))
            self.assertEqual(verify_materialized_progress(root, expected), done)

    def test_replacement_identity_cannot_collide(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = [record(1), record(2)]
            self.write_attempt(root, 1, expected[0], cap=True)
            self.write_attempt(root, 2, expected[1], cap=True)
            first = replacement(expected[0], 3, 1)
            second = replacement(expected[1], 4, 1)
            second["replacementIdentity"] = first["replacementIdentity"]
            self.write_attempt(root, 3, first)
            self.write_attempt(root, 4, second)
            with self.assertRaisesRegex(RuntimeError, "identity collides or is invalid"):
                verify_materialized_progress(root, expected)

    def test_non_cap_missing_csv_and_missing_audit_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = [record(1)]
            self.write_attempt(root, 1, expected[0])
            (root / "game_1.csv").unlink()
            with self.assertRaisesRegex(RuntimeError, "non-cap attempt is missing"):
                verify_materialized_progress(root, expected)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "game_1.csv").write_text("csv")
            with self.assertRaisesRegex(RuntimeError, "CSV lacks its audit"):
                verify_materialized_progress(root, [record(1)])

    def test_attempt_safety_ceiling_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = [record(1)]
            self.write_attempt(root, 1, expected[0], cap=True)
            for index in range(2, 6):
                self.write_attempt(root, index, replacement(expected[0], index, index - 1), cap=True)
            with self.assertRaisesRegex(RuntimeError, "attempt safety ceiling"):
                verify_materialized_progress(root, expected)


if __name__ == "__main__":
    unittest.main()
