import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from materialized_resume import verify_materialized_prefix


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


class MaterializedResumeTest(unittest.TestCase):
    def write_game(self, root: Path, index: int, initial_record: dict) -> None:
        (root / f"game_{index}.csv").write_text("csv")
        (root / f"game_{index}.audit.json").write_text(
            json.dumps({"initialStateRecord": initial_record})
        )

    def test_accepts_only_a_matching_contiguous_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = [record(index) for index in range(1, 4)]
            self.write_game(root, 1, expected[0])
            self.write_game(root, 2, expected[1])
            self.assertEqual(verify_materialized_prefix(root, expected), 2)

    def test_changed_prefix_fails_for_content_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = [record(index) for index in range(1, 3)]
            changed = json.loads(json.dumps(expected[0]))
            changed["initialState"]["pawns"]["marker"] = 999
            self.write_game(root, 1, changed)
            with self.assertRaisesRegex(RuntimeError, "initialStateRecord does not match"):
                verify_materialized_prefix(root, expected)

    def test_overfull_prefix_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = [record(1)]
            self.write_game(root, 1, expected[0])
            self.write_game(root, 2, record(2))
            with self.assertRaisesRegex(RuntimeError, "larger than"):
                verify_materialized_prefix(root, expected)


if __name__ == "__main__":
    unittest.main()
