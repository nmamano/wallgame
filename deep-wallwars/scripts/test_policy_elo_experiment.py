import json
import hashlib
import copy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from policy_elo_experiment import load_experiment
from complete_policy_elo_evidence import materialize
from launch_policy_elo import run_with_final, write_runner_final


SCRIPTS = Path(__file__).resolve().parent


def plan(name="arbitrary_policy_run"):
    pairings = [
        {"conditionId": "a", "generationA": 7, "generationB": 9, "games": 3},
        {"conditionId": "b", "generationA": 9, "generationB": 12, "games": 5},
    ]
    return {
        "schema": "wallgame-policy-elo-plan-v1", "experiment": name,
        "settings": {"samples": 1, "rootNoiseFactor": 0, "moveSelection": "policy-argmax", "seatAlternation": True},
        "engine": {"path": "/engine", "sha256": "abc"},
        "config": {"path": "/runs/arbitrary/config.json"},
        "pairings": pairings, "summary": {"pairings": 2, "games": 8},
    }


class PolicyEloExperimentTest(unittest.TestCase):
    def archive_fixture(self, root):
        archive = root / "archive"
        (archive / "accepted").mkdir(parents=True)
        value = plan()
        pairing = value["pairings"][0]
        pairing.update({"modelA": str(root / "model_7.trt"), "modelB": str(root / "model_9.trt")})
        value["pairings"] = [pairing]
        value["summary"] = {"pairings": 1, "games": 3}
        game = {
            "whiteModel": pairing["modelA"], "blackModel": pairing["modelB"],
            "candidateIsP1": True, "result": "1-0", "variant": "classic",
            "setup": "random-start", "board": "8x8", "engineSeed": 1,
            "randomStartSeed": 2, "game": 0, "exp": value["experiment"],
            "legalityErrors": [], "reason": "goal", "outcome": "ours",
        }
        wrapper = {
            "schema": "wallgame-policy-elo-game-v2", "experiment": value["experiment"],
            "status": "accepted", "excludeReason": None, "samples": 1,
            "rootNoiseFactor": 0, "moveSelection": "policy-argmax", "gameId": "game-1",
            "generationA": 7, "generationB": 9, "conditionId": "a", "game": game,
        }
        self.refresh_fingerprint(wrapper)
        return archive, value, wrapper

    @staticmethod
    def refresh_fingerprint(wrapper):
        wrapper["gameFingerprint"] = hashlib.sha256(
            json.dumps(wrapper["game"], sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()

    def test_derives_arbitrary_counts_and_generation_ladder(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "plan.json"
            path.write_text(json.dumps(plan()))
            _, experiment = load_experiment(path, Path(temporary) / "deep-wallwars")
            self.assertEqual((experiment.pairings, experiment.games), (2, 8))
            self.assertEqual(experiment.generations, (7, 9, 12))

    def test_registrar_refuses_duplicate_name(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan_path, registry = root / "plan.json", root / "experiments.json"
            plan_path.write_text(json.dumps(plan()))
            registry.write_text("{}\n")
            command = [sys.executable, str(SCRIPTS / "register_experiment.py"), "--plan", str(plan_path), "--registry", str(registry)]
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
            duplicate = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(duplicate.returncode, 0)
            self.assertIn("refusing duplicate", duplicate.stderr)

    def test_completion_materializes_plan_models(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, value, wrapper = self.archive_fixture(root)
            (archive / "accepted" / "a.jsonl").write_text(json.dumps(wrapper) + "\n")
            table, fingerprints = materialize(archive, value)
            self.assertIn(b"tf:7,tf:9", table)
            self.assertIn(b'"gameId": "game-1"', fingerprints)

    def assert_invalid_game(self, mutate, message):
        with tempfile.TemporaryDirectory() as temporary:
            archive, value, wrapper = self.archive_fixture(Path(temporary))
            wrapper = copy.deepcopy(wrapper)
            mutate(wrapper["game"])
            self.refresh_fingerprint(wrapper)
            (archive / "accepted" / "a.jsonl").write_text(json.dumps(wrapper) + "\n")
            with self.assertRaisesRegex(ValueError, message):
                materialize(archive, value)

    def test_completion_rejects_wrong_game_experiment(self):
        self.assert_invalid_game(lambda game: game.update(exp="wrong"), "wrong experiment")

    def test_completion_rejects_legality_errors(self):
        self.assert_invalid_game(lambda game: game.update(legalityErrors=["bad"]), "legality errors")

    def test_completion_rejects_no_legal_move(self):
        self.assert_invalid_game(lambda game: game.update(reason="no-legal-move"), "excluded or invalid outcome")

    def test_completion_rejects_invalid_outcome(self):
        self.assert_invalid_game(lambda game: game.update(outcome="invalid"), "excluded or invalid outcome")

    def test_completion_rejects_result_outcome_disagreement(self):
        self.assert_invalid_game(lambda game: game.update(outcome="opp"), "result and outcome differ")

    def test_runner_final_records_failure_and_hash_mismatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            engine, final = root / "engine", root / "runner.final"
            engine.write_bytes(b"engine")
            expected = hashlib.sha256(b"engine").hexdigest()
            self.assertEqual(write_runner_final(final, 0, engine, expected), 0)
            self.assertIn("status=0", final.read_text())
            self.assertEqual(write_runner_final(final, 130, engine, expected), 130)
            self.assertIn("originalStatus=130", final.read_text())
            self.assertEqual(write_runner_final(final, 0, engine, "wrong"), 97)
            self.assertIn("status=97", final.read_text())
            with self.assertRaises(KeyboardInterrupt):
                run_with_final([], final, engine, expected, runner=lambda _: (_ for _ in ()).throw(KeyboardInterrupt()))
            interrupted = final.read_text()
            self.assertIn("status=1", interrupted)
            self.assertIn("originalStatus=1", interrupted)

    def test_recorded_completion_refuses_without_changes(self):
        repo = SCRIPTS.parents[1]
        provenance = repo / "deep-wallwars/elo_db/provenance/tf_policy_elo_random_start_continuation_g127_g140_2026-08-26"
        plan_path = provenance / "plan.json"
        protected = [
            repo / "deep-wallwars/elo_db/experiments.json",
            repo / "deep-wallwars/elo_db/results/tf_policy_elo_random_start_continuation_g127_g140_2026-08-26.csv",
            provenance / "raw-fingerprints.json", provenance / "archive-tree-files.json",
            provenance / "completion-summary.json",
        ]
        before = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in protected}
        status_before = subprocess.run(["git", "status", "--porcelain=v1"], cwd=repo, capture_output=True, text=True).stdout
        result = subprocess.run([sys.executable, str(SCRIPTS / "complete_policy_elo_evidence.py"), "--plan", str(plan_path)], cwd=repo, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("refusing to change non-planned experiment", result.stderr)
        self.assertEqual(before, {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in protected})
        status_after = subprocess.run(["git", "status", "--porcelain=v1"], cwd=repo, capture_output=True, text=True).stdout
        self.assertEqual(status_before, status_after)


if __name__ == "__main__":
    unittest.main()
