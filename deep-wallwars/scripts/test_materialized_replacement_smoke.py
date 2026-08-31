import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from materialized_resume import (
    load_expected_batch,
    verify_materialized_progress,
    write_replacement_requests,
)


class MaterializedReplacementSmokeTest(unittest.TestCase):
    def test_forced_cap_is_replaced_end_to_end(self):
        generator = Path(__file__).with_name("generate_training_initial_states.ts")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            initial = root / "initial.jsonl"
            subprocess.run(
                [
                    "bun", str(generator), "--seed", "730257", "--games", "2",
                    "--start-game", "1", "--output", str(initial),
                ],
                check=True,
            )
            expected = load_expected_batch(initial, 2)
            (root / "game_1.audit.json").write_text(
                json.dumps(
                    {
                        "objectiveVersion": "terminal-turn-discount-v1",
                        "endReason": "move-limit",
                        "initialStateRecord": expected[0],
                    }
                )
            )
            (root / "game_2.csv").write_text("accepted")
            (root / "game_2.audit.json").write_text(
                json.dumps(
                    {
                        "objectiveVersion": "terminal-turn-discount-v1",
                        "endReason": "terminal",
                        "initialStateRecord": expected[1],
                    }
                )
            )
            progress = verify_materialized_progress(root, expected)
            requests = root / "requests.jsonl"
            replacement_states = root / "replacements.jsonl"
            write_replacement_requests(requests, expected, progress.replacements)
            subprocess.run(
                [
                    "bun", str(generator), "--seed", "730257",
                    "--replacement-requests", str(requests),
                    "--output", str(replacement_states),
                ],
                check=True,
            )
            replacement = json.loads(replacement_states.read_text())
            self.assertEqual(replacement["replacementIdentity"], "1:1")
            self.assertEqual(replacement["gameIndex"], 3)
            self.assertEqual(
                (
                    replacement["variant"], replacement["startMode"],
                    replacement["dimensionMode"], replacement["boardWidth"],
                    replacement["boardHeight"],
                ),
                (
                    expected[0]["variant"], expected[0]["startMode"],
                    expected[0]["dimensionMode"], expected[0]["boardWidth"],
                    expected[0]["boardHeight"],
                ),
            )
            (root / "game_3.csv").write_text("replacement accepted")
            (root / "game_3.audit.json").write_text(
                json.dumps(
                    {
                        "objectiveVersion": "terminal-turn-discount-v1",
                        "endReason": "terminal",
                        "initialStateRecord": replacement,
                    }
                )
            )
            done = verify_materialized_progress(root, expected)
            self.assertEqual((done.admitted, done.replacements), (2, ()))


if __name__ == "__main__":
    unittest.main()
