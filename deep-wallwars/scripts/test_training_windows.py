import tempfile
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from training_windows import discover_universal_training_paths, expected_generation_ids


class TrainingWindowTest(unittest.TestCase):
    def test_continuation_boundaries(self):
        self.assertEqual(expected_generation_ids(117, 12), set(range(105, 117)))
        self.assertEqual(expected_generation_ids(126, 12), set(range(114, 126)))

    def test_mixed_continuation_after_legacy_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for generation in range(105, 116):
                for variant in ("standard", "classic", "animal-cycle"):
                    (root / f"generation_{generation}_{variant}_8x8").mkdir()
            (root / "generation_116_mixed").mkdir()
            paths = discover_universal_training_paths(directory, 117, 12)
            self.assertTrue(any(path.endswith("generation_116_mixed") for path in paths))

    def test_model_126_uses_legacy_114_115_and_mixed_116_through_125(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for generation in (114, 115):
                for variant in ("standard", "classic", "animal-cycle"):
                    (root / f"generation_{generation}_{variant}_8x8").mkdir()
            for generation in range(116, 126):
                (root / f"generation_{generation}_mixed").mkdir()
            paths = discover_universal_training_paths(directory, 126, 12)
            ids = {int(Path(path).name.split("_")[1]) for path in paths}
            self.assertEqual(ids, set(range(114, 126)))

    def test_rejects_missing_extra_family_and_mixed_legacy_collision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for generation in range(105, 117):
                (root / f"generation_{generation}_mixed").mkdir()
            (root / "generation_116_standard").mkdir()
            with self.assertRaisesRegex(RuntimeError, "both mixed and legacy"):
                discover_universal_training_paths(directory, 117, 12)
            (root / "generation_116_standard").rmdir()
            (root / "generation_110_mixed").rmdir()
            with self.assertRaisesRegex(RuntimeError, "missing"):
                discover_universal_training_paths(directory, 117, 12)
            (root / "generation_110_mixed").mkdir()
            (root / "generation_110_unknown").mkdir()
            with self.assertRaisesRegex(RuntimeError, "unexpected"):
                discover_universal_training_paths(directory, 117, 12)

    def test_rejects_directory_plus_archive_before_deduplication(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for generation in range(105, 117):
                (root / f"generation_{generation}_mixed").mkdir()
            (root / "generation_110_mixed.tar.zst").write_bytes(b"archive")
            with self.assertRaisesRegex(RuntimeError, "both directory and archive"):
                discover_universal_training_paths(directory, 117, 12)


if __name__ == "__main__":
    unittest.main()
