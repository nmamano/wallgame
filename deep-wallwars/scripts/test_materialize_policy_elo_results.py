import json
import tempfile
import unittest
from pathlib import Path

import materialize_policy_elo_results as materialize


def fixture():
    pairing = {
        "conditionId": "standard-fixed-8x8",
        "variant": "standard",
        "setup": "fixed",
        "width": 8,
        "height": 8,
        "generationA": 1,
        "generationB": 2,
        "existingAcceptedGames": 0,
        "games": 2,
        "windowId": "w",
    }
    return {"experiment": "test", "pairings": [pairing]}, pairing


def raw_row(plan, pairing, game_index):
    identity = materialize.game_identity(plan["experiment"], pairing, game_index)
    p1 = 1 if game_index % 2 == 0 else 2
    p2 = 2 if game_index % 2 == 0 else 1
    return {
        "experiment": "test",
        "conditionId": pairing["conditionId"],
        "variant": "standard",
        "setup": "fixed",
        "boardWidth": 8,
        "boardHeight": 8,
        "gameId": identity,
        "gameIndex": game_index,
        "p1Generation": p1,
        "p2Generation": p2,
        "winner": "p1",
        "reason": "goal",
        "engineSeed": 10,
        "randomStartSeed": None,
        "failure": None,
        "accepted": True,
    }


class MaterializeTest(unittest.TestCase):
    def write_fixture(self, root, mutate=None):
        plan, pairing = fixture()
        raw = root / "w" / "attempt.jsonl"
        raw.parent.mkdir(parents=True)
        rows = [raw_row(plan, pairing, index) for index in range(2)]
        if mutate:
            mutate(rows)
        raw.write_text("".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows))
        return plan

    def test_exact_v1_table_and_fingerprints_are_deterministic(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.write_fixture(root)
            first = materialize.build_outputs(root, plan)
            second = materialize.build_outputs(root, plan)
            self.assertEqual(first, second)
            header = first[0].decode().splitlines()[0]
            self.assertEqual(header.split(","), materialize.COLUMNS)
            fingerprints = json.loads(first[1])
            self.assertEqual(fingerprints["rows"], 2)
            self.assertTrue(all(len(row["rawRecordSha256"]) == 64 for row in fingerprints["records"]))

    def test_missing_game_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.write_fixture(root, lambda rows: rows.pop())
            with self.assertRaisesRegex(materialize.MaterializeError, "lack 1 expected"):
                materialize.build_outputs(root, plan)

    def test_failed_game_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.write_fixture(root, lambda rows: rows[0].update(accepted=False))
            with self.assertRaisesRegex(materialize.MaterializeError, "failed or unaccepted"):
                materialize.build_outputs(root, plan)

    def test_duplicate_game_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.write_fixture(root, lambda rows: rows.append(dict(rows[0])))
            with self.assertRaisesRegex(materialize.MaterializeError, "duplicate raw"):
                materialize.build_outputs(root, plan)


if __name__ == "__main__":
    unittest.main()
