#!/usr/bin/env python3

import asyncio
import importlib.util
import json
import os
import stat
import tempfile
import unittest
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


def load(name):
    path = Path(__file__).with_name(name + ".py")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


batch = load("policy_elo_batch")
planner = load("policy_elo_plan")


def pair(games=2):
    return {
        "conditionId": "classic-random-12x10", "variant": "classic",
        "setup": "random-start", "width": 12, "height": 10,
        "generationA": 110, "generationB": 113,
        "modelA": "/models/model_110.trt", "modelB": "/models/model_113.trt",
        "existingAcceptedGames": 0, "games": games,
    }


def plan(games=2):
    return {
        "experiment": "test-policy", "usedEngineSeeds": [],
        "engine": {"path": "/engine"}, "benchmark": {"path": "/benchmark"},
        "pairings": [pair(games)],
    }


def game(index=0, seed=1, outcome="ours", reason="capture", errors=None, candidate_is_p1=True):
    result = "1/2-1/2" if outcome == "draw" else (
        "1-0" if (candidate_is_p1 == (outcome == "ours")) else "0-1"
    )
    return {
        "exp": "test-policy", "variant": "classic", "setup": "random-start",
        "board": "12x10", "game": index, "engineSeed": seed,
        "randomStartSeed": seed * 1_000_003 + index, "candidateIsP1": candidate_is_p1,
        "candidateModel": "/models/model_110.trt", "baselineModel": "/models/model_113.trt",
        "outcome": outcome, "result": result, "reason": reason,
        "legalityErrors": [] if errors is None else errors, "moves": [],
    }


class ArchiveTest(unittest.TestCase):
    def test_refusal_is_quarantined_and_duplicate_is_stable(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = batch.Archive(Path(temp), "test-policy", plan())
            self.assertTrue(archive.append(pair(), game(), "attempt-1"))
            self.assertFalse(archive.append(pair(), game(), "attempt-1"))
            refusal = game(1, reason="no-legal-move", errors=["No legal move available"])
            archive.append(pair(), refusal, "attempt-1")
            self.assertEqual(archive.accepted_count(pair()), 1)
            excluded = json.loads(next(archive.quarantine.glob("*.jsonl")).read_text())
            self.assertEqual(excluded["excludeReason"], "engine-no-legal-move")

    def test_partial_writes_and_torn_archive_tail_recover(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = batch.Archive(root, "test-policy", plan())
            real_write = os.write

            def short_write(fd, payload):
                return real_write(fd, payload[:3])

            with mock.patch.object(batch.os, "write", side_effect=short_write):
                archive.append(pair(), game(), "attempt-1")
            accepted = next(archive.accepted.glob("*.jsonl"))
            with accepted.open("ab") as stream:
                stream.write(b'{"torn":')
            recovered = batch.Archive(root, "test-policy", plan())
            self.assertEqual(recovered.accepted_count(pair()), 1)
            self.assertTrue(accepted.read_bytes().endswith(b"\n"))
            self.assertEqual(len(list(recovered.torn.glob("*.torn"))), 1)

    def test_wrong_condition_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = batch.Archive(Path(temp), "test-policy", plan())
            wrong = game()
            wrong["variant"] = "standard"
            with self.assertRaisesRegex(ValueError, "wrong variant"):
                archive.append(pair(), wrong, "attempt-1")
            wrong_path = game()
            wrong_path["candidateModel"] = "/other/model_110.trt"
            with self.assertRaisesRegex(ValueError, "candidate model"):
                archive.append(pair(), wrong_path, "attempt-1")

    def test_attempt_metadata_rejects_mixed_seed_range_and_seats(self):
        metadata = {"engineSeed": 7, "submittedGames": 2}
        valid = game(0, 7)
        batch.validate_attempt_row(pair(), valid, metadata)
        for field, value, message in (
            ("engineSeed", 8, "engine seed"),
            ("game", 2, "outside submitted"),
            ("candidateIsP1", False, "seat alternation"),
            ("randomStartSeed", "bad", "integer seed"),
            ("randomStartSeed", 123, "does not match"),
        ):
            wrong = {**valid, field: value}
            with self.assertRaisesRegex(ValueError, message):
                batch.validate_attempt_row(pair(), wrong, metadata)


class ResumeTest(unittest.TestCase):
    def make_fake_bun(self, root: Path):
        path = root / "fake-bun"
        path.write_text("""#!/usr/bin/env python3
import json,sys
args=sys.argv[2:]
def value(flag): return args[args.index(flag)+1]
for game in range(int(value('--games'))):
  p1=game%2==0
  row={'exp':value('--experiment'),'variant':value('--variant'),'setup':value('--setup'),
    'board':value('--width')+'x'+value('--height'),'game':game,'engineSeed':int(value('--seed')),
    'randomStartSeed':int(value('--seed'))*1000003+game,'candidateIsP1':p1,
    'candidateModel':value('--ours'),'baselineModel':value('--opp'),'outcome':'ours',
    'result':'1-0' if p1 else '0-1','reason':'capture','legalityErrors':[],'moves':[]}
  with open(value('--archive'),'a') as out: out.write(json.dumps(row,separators=(',',':'))+'\\n')
""")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path

    def test_interrupted_and_quarantined_run_resumes_to_target(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            run_root, archive_root = root / "run", root / "archive"
            current_pair, current_plan = pair(games=3), plan(3)
            archive = batch.Archive(archive_root, "test-policy", current_plan)
            raw = (run_root / "raw" / f"{batch.pair_key(current_pair)}-attempt0001-seed1.jsonl").resolve()
            meta = raw.with_suffix(".meta.json")
            raw.parent.mkdir(parents=True)
            raw.write_text("\n".join((
                json.dumps(game(0, 1), separators=(",", ":")),
                json.dumps(game(0, 1), separators=(",", ":")),
                json.dumps(game(1, 1, outcome="opp", reason="no-legal-move", errors=["refusal"], candidate_is_p1=False), separators=(",", ":")),
            )) + "\n{torn")
            batch.atomic_json(meta, {
                "schema": "wallgame-policy-elo-journal-v1",
                "experiment": "test-policy", "attemptId": "attempt-1",
                "engineSeed": 1, "submittedGames": 2,
                "pair": current_pair, "rawPath": str(raw),
            })
            recovered = batch.recover_journals(run_root, archive, current_plan)
            self.assertEqual(recovered, 2)
            self.assertEqual(archive.accepted_count(current_pair), 1)
            fake = self.make_fake_bun(root)
            opt = SimpleNamespace(bun=fake, run_root=run_root, archive_root=archive_root)
            asyncio.run(batch.run_pair(current_pair, current_plan, opt, archive, asyncio.Semaphore(1)))
            self.assertEqual(archive.accepted_count(current_pair), 3)
            self.assertEqual(len(archive.records), 4)
            self.assertEqual(len(list((run_root / "raw").glob("*.meta.json"))), 2)
            self.assertEqual(len(archive.engine_seeds), 2)

    def test_parse_failure_terminates_child_and_engine_grandchild(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            pid_file = root / "child.pid"
            grandchild_file = root / "grandchild.pid"
            fake = root / "bad-bun"
            fake.write_text(f"""#!/usr/bin/env python3
import os,subprocess,sys,time
args=sys.argv[2:]
def value(flag): return args[args.index(flag)+1]
open({str(pid_file)!r},'w').write(str(os.getpid()))
grandchild=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])
open({str(grandchild_file)!r},'w').write(str(grandchild.pid))
open(value('--archive'),'w').write('{{bad\\n')
time.sleep(30)
""")
            fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
            archive = batch.Archive(root / "archive", "test-policy", plan())
            opt = SimpleNamespace(bun=fake, run_root=root / "run")
            with self.assertRaises(Exception):
                asyncio.run(batch.run_attempt(pair(), plan(), opt, archive, 1, 2))
            pids = [int(pid_file.read_text()), int(grandchild_file.read_text())]

            def running(pid):
                stat_path = Path(f"/proc/{pid}/stat")
                return stat_path.exists() and stat_path.read_text().split()[2] != "Z"

            for _ in range(20):
                if not any(running(pid) for pid in pids):
                    break
                time.sleep(0.05)
            self.assertFalse(any(running(pid) for pid in pids))

    def test_frozen_input_hash_drift_stops_before_launch(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            paths = {}
            for name in ("engine", "benchmark", "config", "loadability", "model", "bun"):
                path = root / name
                path.write_bytes(name.encode())
                paths[name] = path
            frozen = {
                "engine": {"path": str(paths["engine"]), "sha256": batch.sha256(paths["engine"])},
                "benchmark": {"path": str(paths["benchmark"]), "sha256": batch.sha256(paths["benchmark"])},
                "config": {"path": str(paths["config"]), "sha256": batch.sha256(paths["config"])},
                "loadabilityMap": {"path": str(paths["loadability"]), "sha256": batch.sha256(paths["loadability"])},
                "models": {"1": {"path": str(paths["model"]), "sha256": batch.sha256(paths["model"])}},
            }
            batch.verify_frozen_inputs(frozen, paths["bun"])
            paths["model"].write_bytes(b"drift")
            with self.assertRaisesRegex(ValueError, "frozen input drift"):
                batch.verify_frozen_inputs(frozen, paths["bun"])


class PlannerTest(unittest.TestCase):
    def test_components_expose_disconnected_generation(self):
        self.assertEqual(planner.components([1, 2, 3], {(1, 2)}), [[1, 2], [3]])

    def test_supported_boundary_never_pairs_against_unsupported_model(self):
        self.assertEqual(
            planner.desired_pairings(list(range(93, 117)), [1, 3, 6]),
            {
                planner.edge(gen, gen-delta)
                for gen in range(93, 117) for delta in (1, 3, 6)
                if gen-delta >= 93
            },
        )
        self.assertNotIn((92, 93), planner.desired_pairings([93, 94], [1, 3, 6]))

    def test_duplicate_generation_requires_explicit_resolution(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            base, extension = root / "base", root / "extension"
            base.mkdir(); extension.mkdir()
            (base / "model_93.trt").write_bytes(b"old")
            (extension / "model_93.trt").write_bytes(b"new")
            with self.assertRaisesRegex(ValueError, "different artifacts"):
                planner.inventory(base, extension)
            models, duplicates = planner.inventory(base, extension, True, "phase7 contract")
            self.assertEqual(models[93]["path"], (extension / "model_93.trt").resolve())
            self.assertEqual(duplicates[0]["reason"], "phase7 contract")

    def test_loadability_map_fails_on_duplicate_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "map.jsonl"
            path.write_text('{"generation":1,"loadability":"supported"}\n' * 2)
            with self.assertRaisesRegex(ValueError, "duplicate loadability"):
                planner.loadability(path)

    def test_loadability_rejects_stale_model_and_engine_hashes(self):
        models = {93: {"sha256": "model-new"}}
        valid = {93: {
            "generation": 93, "loadability": "supported",
            "modelSha256": "model-new", "engineSha256": "engine-new",
            "inputContract": "16-plane-universal",
        }}
        self.assertEqual(planner.validate_loadability(valid, models, "engine-new"), ([93], []))
        stale_model = {93: {**valid[93], "modelSha256": "model-old"}}
        with self.assertRaisesRegex(ValueError, "model hash is stale"):
            planner.validate_loadability(stale_model, models, "engine-new")
        with self.assertRaisesRegex(ValueError, "engine hash is stale"):
            planner.validate_loadability(valid, models, "engine-old")

    def test_existing_source_keeps_39_clean_and_excludes_one_bad(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "sources" / "source"
            source.mkdir(parents=True)
            rows = []
            for index in range(40):
                rows.append({
                    "variant": "classic", "setup": "random-start", "board": "12x10",
                    "candidateModel": "model_2.trt", "baselineModel": "model_1.trt",
                    "engineSeed": index, "outcome": "ours", "legalityErrors": [],
                    "reason": "no-legal-move" if index == 39 else "capture",
                })
            (source / "pair_g2_vs_g1.jsonl").write_text("\n".join(json.dumps(row) for row in rows) + "\n")
            config = {
                "archiveExperiments": ["source"],
                "archiveConditionAdapters": {"new:pair": "condition"},
                "conditions": [{
                "id": "condition", "variant": "classic", "setup": "random-start",
                "width": 12, "height": 10,
            }]}
            counts, seeds = planner.accepted_existing(
                config, root / "missing.jsonl", root / "sources", root / "archive",
            )
            self.assertEqual(counts["condition"][(1, 2)], 39)
            self.assertEqual(len(seeds), 40)

    def test_plan_hashes_inputs_and_exposes_incompatible_artifact(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            base, extension = root / "base", root / "extension"
            base.mkdir(); extension.mkdir()
            (base / "model_1.trt").write_bytes(b"one")
            (extension / "model_2.trt").write_bytes(b"two")
            (extension / "model_3.trt").write_bytes(b"three")
            engine, benchmark = root / "engine", root / "benchmark"
            engine.write_bytes(b"engine"); benchmark.write_bytes(b"benchmark")
            config = root / "conditions.json"
            config.write_text(json.dumps({
                "pairingDeltas": [1], "archiveExperiments": [],
                "archiveConditionAdapters": {},
                "conditions": [{
                    "id": "classic-fixed-8x8", "variant": "classic", "setup": "fixed",
                    "width": 8, "height": 8, "gamesPerPair": 2,
                }],
            }))
            loadmap = root / "loadability.jsonl"
            engine_sha = planner.sha256(engine)
            load_rows = [
                {"generation": gen, "loadability": status,
                 "modelSha256": planner.sha256(path), "engineSha256": engine_sha,
                 "inputContract": contract}
                for gen, path, status, contract in (
                    (1, base / "model_1.trt", "supported", "16-plane-universal"),
                    (2, extension / "model_2.trt", "supported", "16-plane-universal"),
                    (3, extension / "model_3.trt", "neither-supported-contract", "9-plane-old"),
                )
            ]
            loadmap.write_text("\n".join(json.dumps(row) for row in load_rows) + "\n")
            output = root / "plan.json"
            argv = [
                "policy_elo_plan.py", "--config", str(config), "--base-models", str(base),
                "--extension-models", str(extension), "--legacy-games", str(root / "legacy"),
                "--existing-sources", str(root / "sources"), "--policy-archive", str(root / "archive"),
                "--output", str(output), "--engine", str(engine), "--benchmark", str(benchmark),
                "--loadability-map", str(loadmap), "--experiment", "test-plan",
            ]
            with mock.patch.object(sys, "argv", argv):
                planner.main()
            built = json.loads(output.read_text())
            self.assertEqual(built["summary"], {"pairings": 1, "games": 2})
            self.assertEqual(built["pairings"][0]["generationA"], 1)
            self.assertEqual(built["pairings"][0]["generationB"], 2)
            self.assertEqual(built["config"]["sha256"], planner.sha256(config))
            self.assertEqual(built["loadabilityMap"]["sha256"], planner.sha256(loadmap))
            self.assertEqual(built["conditions"][0]["unavailableArtifacts"], [
                {"generation": 3, "reason": "neither-supported-contract"},
            ])


if __name__ == "__main__":
    unittest.main()
