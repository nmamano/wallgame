import sys
import tempfile
import unittest
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))


class FakeTensor(list):
    def view(self, *_shape):
        return self

    def flatten(self):
        return self


sys.modules.setdefault("torch", types.SimpleNamespace(tensor=FakeTensor))

from data import parse_file


class InitialTensorLoaderTest(unittest.TestCase):
    def test_loader_uses_the_recorded_initial_tensor_without_reconstruction(self):
        columns, rows = 12, 10
        board = [0.0] * (16 * columns * rows)
        sampled_marker = 0.375
        board[3 * columns * rows + 17] = sampled_marker
        priors = [0.0] * (2 * columns * rows + 8)
        with tempfile.TemporaryDirectory() as directory:
            replay = Path(directory) / "game_1.csv"
            replay.write_text(
                ", ".join(map(str, board))
                + "\n"
                + ", ".join(map(str, priors))
                + "\n1.0\n\n"
            )
            loaded = parse_file(replay, 16, columns, rows, 8)
        self.assertEqual(len(loaded), 1)
        tensor = loaded[0][0]
        self.assertEqual(float(tensor.flatten()[3 * columns * rows + 17]), sampled_marker)
        self.assertEqual(float(tensor.flatten()[0]), 0.0)


if __name__ == "__main__":
    unittest.main()
