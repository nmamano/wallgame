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
            with self.assertRaisesRegex(materialize.MaterializeError, "lacks exact recovered"):
                materialize.build_outputs(root, plan)

    def write_recovered_failure(self, root, mismatch=False):
        plan, pairing = fixture()
        accepted = [raw_row(plan, pairing, index) for index in range(2)]
        failed = dict(accepted[0], accepted=False, failure="illegal")
        failed_line = json.dumps(failed, separators=(",", ":")) + "\n"
        raw = root / "w" / "old.jsonl"
        raw.parent.mkdir(parents=True)
        raw.write_text(failed_line)
        (root / "w" / "resume.jsonl").write_text(
            "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in accepted)
        )
        digest = materialize.hashlib.sha256(failed_line[:-1].encode()).hexdigest()
        recovered = root / "w" / "failures" / "recovered" / f"{failed['gameId']}.{digest}.json"
        recovered.parent.mkdir(parents=True)
        recovered.write_text(failed_line if not mismatch else failed_line.replace("illegal", "other"))
        return plan

    def test_exact_recovered_failure_plus_accepted_replacement_succeeds(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.write_recovered_failure(root)
            table, fingerprints = materialize.build_outputs(root, plan)
            self.assertEqual(table.count(b"\n") - 1, 2)
            self.assertEqual(json.loads(fingerprints)["rows"], 2)

    def test_missing_recovered_failure_copy_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.write_recovered_failure(root)
            recovered = next((root / "w" / "failures" / "recovered").iterdir())
            recovered.unlink()
            with self.assertRaisesRegex(materialize.MaterializeError, "lacks exact recovered"):
                materialize.build_outputs(root, plan)

    def test_mismatched_recovered_failure_copy_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.write_recovered_failure(root, mismatch=True)
            with self.assertRaisesRegex(materialize.MaterializeError, "differs from root row"):
                materialize.build_outputs(root, plan)

    def test_duplicate_game_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.write_fixture(root, lambda rows: rows.append(dict(rows[0])))
            with self.assertRaisesRegex(materialize.MaterializeError, "duplicate raw"):
                materialize.build_outputs(root, plan)


if __name__ == "__main__":
    unittest.main()
