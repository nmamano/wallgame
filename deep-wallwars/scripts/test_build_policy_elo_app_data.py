#!/usr/bin/env python3
"""Focused tests for the policy Elo app snapshot builder."""

import importlib.util
import base64
import gzip
import json
import math
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("build_policy_elo_app_data.py")
SPEC = importlib.util.spec_from_file_location("policy_elo_app_data", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
BATCH_PATH = Path(__file__).with_name("policy_elo_batch.py")
BATCH_SPEC = importlib.util.spec_from_file_location("policy_elo_batch_for_app_test", BATCH_PATH)
BATCH = importlib.util.module_from_spec(BATCH_SPEC)
BATCH_SPEC.loader.exec_module(BATCH)


def edge(a, b, wins_a=1, wins_b=1, draws=0):
    clean = wins_a + wins_b + draws
    return {
        "condition": "test", "a": a, "b": b,
        "winsA": wins_a, "winsB": wins_b, "draws": draws,
        "clean": clean, "excluded": 0, "sources": {},
    }


class PolicyEloDataTest(unittest.TestCase):
    def test_rule_boundary_preserves_old_points_and_shifts_only_new_scale(self):
        previous = {
            "schema": "wallgame-policy-elo-app-v2",
            "conditions": [{"id": "test", "components": [{"ratings": [
                {"generation": 139, "elo": 80.0, "games": 12},
                {"generation": 140, "elo": 100.0, "games": 12},
            ]}]}],
        }
        current = {
            "schema": "wallgame-policy-elo-app-v2",
            "conditions": [{"id": "test", "components": [{"ratings": [
                {"generation": 139, "elo": 70.0, "games": 24},
                {"generation": 140, "elo": 90.0, "games": 24},
                {"generation": 150, "elo": 130.0, "games": 12},
            ]}]}],
        }
        MODULE.preserve_existing_ratings(current, previous, 140)
        self.assertEqual(current["conditions"][0]["components"][0]["ratings"], [
            {"generation": 139, "elo": 80.0, "games": 12},
            {"generation": 140, "elo": 100.0, "games": 12},
            {"generation": 150, "elo": 140.0, "games": 12},
        ])

    def test_incremental_plan_uses_clean_archive_and_normalizes_edge_direction(self):
        config = {
            "artifactCoverage": [{"start": 93, "end": 94, "status": "available"}],
            "pairingDeltas": [1],
            "conditions": [{"id": "condition", "gamesPerPair": 2}],
        }
        by_condition = {"condition": [{"a": 94, "b": 93, "clean": 2}]}
        plan = MODULE.incremental_plan(config, by_condition)
        self.assertEqual(plan["summary"], {"pairings": 0, "acceptedGamesNeeded": 0})

    def test_components_keep_unsupported_gap_disconnected(self):
        groups = MODULE.components([
            edge(1, 2), edge(2, 3), edge(93, 94), edge(94, 95),
        ])
        self.assertEqual(groups, [[1, 2, 3], [93, 94, 95]])

    def test_fit_is_finite_and_normalized_to_zero(self):
        ratings = MODULE.fit_component([
            edge(93, 94, 1, 3), edge(94, 95, 1, 3),
        ], [93, 94, 95])
        values = [point["elo"] for point in ratings]
        self.assertEqual(min(values), 0)
        self.assertTrue(all(math.isfinite(value) for value in values))
        self.assertGreater(values[-1], values[0])

    def test_fit_matches_independent_anchored_reference(self):
        # Reference values solve the three anchored likelihood score equations
        # with one unit-anchor draw per player. The former per-iteration
        # geometric rescale returns 215.902 and 265.502, so it fails this test.
        ratings = MODULE.fit_component([
            edge(1, 2, 7, 1), edge(2, 3, 2, 6), edge(1, 3, 1, 3),
        ], [1, 2, 3])
        self.assertEqual(
            [point["elo"] for point in ratings],
            [215.832, 0.0, 265.391],
        )

    def test_merge_preserves_counts_and_provenance(self):
        first = edge(93, 94, 2, 0)
        first["sources"] = {"one": {"clean": 2, "excluded": 0, "rawFiles": ["one.jsonl"]}}
        second = edge(93, 94, 0, 2)
        second["sources"] = {"two": {"clean": 2, "excluded": 0, "rawFiles": ["two.jsonl"]}}
        [merged] = MODULE.merge_edges([first, second])
        self.assertEqual(merged["clean"], 4)
        self.assertEqual(merged["winsA"], 2)
        self.assertEqual(merged["winsB"], 2)
        self.assertEqual(merged["sources"]["one"], {"clean": 2, "excluded": 0, "rawFiles": ["one.jsonl"]})
        self.assertEqual(merged["sources"]["two"], {"clean": 2, "excluded": 0, "rawFiles": ["two.jsonl"]})

    def test_remote_scanner_fails_closed_per_row(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            experiment = root / "experiment"
            experiment.mkdir()
            rows = [
                {"outcome": "ours", "reason": "completed", "legalityErrors": []},
                {"outcome": "draw", "reason": "completed", "legalityErrors": []},
                {"outcome": "opp", "reason": "no-legal-move", "legalityErrors": []},
                {"outcome": "opp", "reason": "completed", "legalityErrors": ["bad"]},
                {"outcome": "unknown", "reason": "completed", "legalityErrors": []},
            ]
            path = experiment / "classic-fixed-8x8_g94_vs_g93.jsonl"
            path.write_text("\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n{bad\n")
            result = subprocess.run([
                "python3", "-c", MODULE.REMOTE_AGGREGATOR, str(root),
                json.dumps(["experiment"]),
                json.dumps({"new:classic-fixed-8x8": "test"}),
            ], check=True, text=True, capture_output=True)
            [scanned] = json.loads(gzip.decompress(base64.b64decode(result.stdout.strip())))
            self.assertEqual(scanned["clean"], 2)
            self.assertEqual(scanned["excluded"], 4)
            self.assertEqual(scanned["winsA"], 1)
            self.assertEqual(scanned["draws"], 1)

    def test_build_excludes_disconnected_legacy_component_from_rated_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            conditions = root / "conditions.json"
            conditions.write_text(json.dumps({
                "artifactCoverage": [
                    {"start": 0, "end": 0, "status": "missing", "label": "missing"},
                    {"start": 1, "end": 92, "status": "legacy", "label": "legacy"},
                    {"start": 93, "end": 94, "status": "available", "label": "rated"},
                ],
                "pairingDeltas": [1],
                "resultRuleBoundaries": [{"generation": 94, "label": "CURRENT RULES"}],
                "variantLabels": {"classic": "Classic"},
                "conditions": [{
                "id": "classic-fixed-8x8", "label": "Classic 8x8",
                "variant": "classic", "setup": "fixed", "width": 8, "height": 8, "gamesPerPair": 2,
            }]}))
            legacy = root / "games.jsonl"
            legacy_rows = [
                {"exp": "rr72_policy_2026-08-01", "board": "8x8", "variant": "classic",
                 "white": {"arch": "tf", "gen": 1}, "black": {"arch": "tf", "gen": 2},
                 "result": result}
                for result in ("1-0", "0-1")
            ]
            legacy.write_text("\n".join(json.dumps(row) for row in legacy_rows) + "\n")
            remote = [{
                "condition": "classic-fixed-8x8", "a": 93, "b": 94,
                "winsA": 1, "winsB": 1, "draws": 0, "clean": 2, "excluded": 0,
                "sources": {"phase7": {"clean": 2, "excluded": 0, "rawFiles": ["pair.jsonl"]}},
            }]
            opt = SimpleNamespace(conditions=conditions, legacy_games=legacy, policy_archive=root / "archive")
            with mock.patch.object(MODULE, "remote_edges", return_value=remote):
                built = MODULE.build(opt)
            [condition] = built["conditions"]
            self.assertEqual([c["generations"] for c in condition["components"]], [[93, 94]])
            self.assertEqual(condition["evidenceGenerations"], [93, 94])
            self.assertEqual(sum(c["cleanGames"] for c in condition["components"]), 2)
            self.assertEqual(built["ratingScope"]["unratedEvidenceGenerations"], [1, 2])
            self.assertEqual(built["ratingScope"]["unratedEvidenceCleanGames"], 2)
            self.assertEqual(
                built["resultRuleBoundaries"],
                [{"generation": 94, "label": "CURRENT RULES"}],
            )

    def test_build_keeps_all_edges_whose_endpoints_are_supported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            conditions = root / "conditions.json"
            conditions.write_text(json.dumps({
                "artifactCoverage": [
                    {"start": 1, "end": 94, "status": "available", "label": "rated"},
                ],
                "pairingDeltas": [1],
                "variantLabels": {"classic": "Classic"},
                "conditions": [{
                    "id": "classic-fixed-8x8", "label": "Classic 8x8",
                    "variant": "classic", "setup": "fixed", "width": 8, "height": 8,
                    "gamesPerPair": 2,
                }],
            }))
            legacy = root / "games.jsonl"
            legacy.write_text("\n".join(json.dumps({
                "exp": "rr72_policy_2026-08-01", "board": "8x8", "variant": "classic",
                "white": {"arch": "tf", "gen": 1}, "black": {"arch": "tf", "gen": 2},
                "result": result,
            }) for result in ("1-0", "0-1")) + "\n")
            remote = [{
                "condition": "classic-fixed-8x8", "a": 93, "b": 94,
                "winsA": 1, "winsB": 1, "draws": 0, "clean": 2, "excluded": 0,
                "sources": {"phase7": {"clean": 2, "excluded": 0, "rawFiles": ["pair.jsonl"]}},
            }]
            opt = SimpleNamespace(conditions=conditions, legacy_games=legacy, policy_archive=root / "archive")
            with mock.patch.object(MODULE, "remote_edges", return_value=remote):
                built = MODULE.build(opt)
            [condition] = built["conditions"]
            self.assertEqual([c["generations"] for c in condition["components"]], [[1, 2], [93, 94]])
            self.assertEqual(sum(c["cleanGames"] for c in condition["components"]), 4)

    def test_build_reads_real_runner_v2_archive_end_to_end(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "conditions.json"
            config.write_text(json.dumps({
                "artifactCoverage": [
                    {"start": 0, "end": 0, "status": "missing", "label": "missing"},
                    {"start": 93, "end": 94, "status": "available", "label": "rated"},
                ],
                "pairingDeltas": [1],
                "variantLabels": {"classic": "Classic"},
                "conditions": [{
                    "id": "classic-fixed-8x8", "label": "Classic 8x8", "color": "#fff",
                    "variant": "classic", "setup": "fixed", "width": 8, "height": 8, "gamesPerPair": 2,
                }],
            }))
            legacy = root / "legacy.jsonl"
            legacy.write_text("")
            current_pair = {
                "conditionId": "classic-fixed-8x8", "variant": "classic", "setup": "fixed",
                "width": 8, "height": 8, "generationA": 93, "generationB": 94,
                "modelA": "/models/model_93.trt", "modelB": "/models/model_94.trt",
                "existingAcceptedGames": 0, "games": 2,
            }
            plan = {
                "experiment": "canonical-test", "usedEngineSeeds": [],
                "engine": {"path": "/engine"}, "benchmark": {"path": "/benchmark"},
                "pairings": [current_pair],
            }
            archive_root = root / "archive"
            archive = BATCH.Archive(archive_root, "canonical-test", plan)
            game = {
                "exp": "canonical-test", "variant": "classic", "setup": "fixed", "board": "8x8",
                "game": 0, "engineSeed": 7, "randomStartSeed": 7000, "candidateIsP1": True,
                "candidateModel": "/models/model_93.trt", "baselineModel": "/models/model_94.trt",
                "outcome": "ours", "result": "1-0", "reason": "capture",
                "legalityErrors": [], "moves": [],
            }
            archive.append(current_pair, game, "attempt-1")
            opt = SimpleNamespace(
                conditions=config, legacy_games=legacy, policy_archive=archive_root,
            )
            with mock.patch.object(MODULE, "remote_edges", return_value=[]):
                built = MODULE.build(opt)
            [component] = built["conditions"][0]["components"]
            self.assertEqual(component["cleanGames"], 1)
            self.assertEqual(component["generations"], [93, 94])
            provenance = component["sources"]["canonical-test"]
            self.assertEqual((provenance["clean"], provenance["excluded"]), (1, 0))
            self.assertIn("#", provenance["rawFiles"][0])
            duplicate_raw = [{
                "condition": "classic-fixed-8x8", "a": 93, "b": 94,
                "winsA": 1, "winsB": 0, "draws": 0, "clean": 1, "excluded": 0,
                "sources": {"canonical-test": {
                    "clean": 1, "excluded": 0, "rawFiles": ["raw.jsonl"],
                }},
            }]
            with mock.patch.object(MODULE, "remote_edges", return_value=duplicate_raw):
                with self.assertRaisesRegex(ValueError, "raw and canonical"):
                    MODULE.build(opt)

    def test_legacy_reader_rejects_unknown_and_legality_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "games.jsonl"
            base = {
                "exp": "rr72_policy_2026-08-01", "board": "8x8", "variant": "classic",
                "white": {"arch": "tf", "gen": 1}, "black": {"arch": "tf", "gen": 2},
            }
            rows = [
                {**base, "result": "1-0"},
                {**base, "result": "0-1"},
                {**base, "result": "unknown"},
                {**base, "result": "1-0", "reason": "no-legal-move"},
                {**base, "result": "1-0", "legalityErrors": ["bad"]},
            ]
            path.write_text("\n".join(json.dumps(row) for row in rows) + "\n{bad\n")
            [scanned] = MODULE.legacy_edges(path)
            self.assertEqual(scanned["clean"], 2)
            self.assertEqual(scanned["excluded"], 3)
            self.assertEqual((scanned["winsA"], scanned["winsB"]), (1, 1))

    def test_excluded_only_edge_does_not_invent_rating_component(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "conditions.json"
            config.write_text(json.dumps({
                "artifactCoverage": [{"start": 1, "end": 2, "status": "available", "label": "rated"}],
                "pairingDeltas": [1],
                "variantLabels": {"classic": "Classic"},
                "conditions": [{
                    "id": "classic-fixed-8x8", "label": "Classic 8x8", "color": "#fff",
                    "variant": "classic", "setup": "fixed", "width": 8, "height": 8, "gamesPerPair": 2,
                }],
            }))
            legacy = root / "legacy.jsonl"; legacy.write_text("")
            excluded = [{
                "condition": "classic-fixed-8x8", "a": 1, "b": 2,
                "winsA": 0, "winsB": 0, "draws": 0, "clean": 0, "excluded": 1,
                "sources": {"failed": {"clean": 0, "excluded": 1, "rawFiles": ["bad.jsonl"]}},
            }]
            opt = SimpleNamespace(conditions=config, legacy_games=legacy, policy_archive=root / "archive")
            with mock.patch.object(MODULE, "remote_edges", return_value=excluded):
                built = MODULE.build(opt)
            [condition] = built["conditions"]
            self.assertEqual(condition["components"], [])
            self.assertEqual(condition["evidenceGenerations"], [])
            self.assertEqual(condition["unconnectedExcludedGames"], 1)
            self.assertEqual(condition["unconnectedSources"]["failed"]["excluded"], 1)
            self.assertEqual(
                built["incrementalPlan"]["summary"],
                {"pairings": 1, "acceptedGamesNeeded": 2},
            )


if __name__ == "__main__":
    unittest.main()
