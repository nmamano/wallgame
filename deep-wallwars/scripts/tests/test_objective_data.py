import json
import tempfile
from pathlib import Path

from objective_data import (
    OBJECTIVE_VERSION,
    _admitted_by_cell,
    _largest_remainder,
    generation_quotas,
)


def test_generation_quotas_are_exact_as_native_window_grows():
    assert generation_quotas([140]) == {140: 5000}
    assert generation_quotas(list(range(140, 144))) == {g: 5000 for g in range(140, 144)}
    assert generation_quotas(list(range(140, 145))) == {g: 4000 for g in range(140, 145)}
    assert generation_quotas(list(range(140, 146))) == {
        140: 3333, 141: 3333, 142: 3333, 143: 3333, 144: 3334, 145: 3334,
    }
    assert generation_quotas(list(range(140, 150))) == {g: 2000 for g in range(140, 150)}


def test_cell_quota_uses_integer_largest_remainder_with_stable_ties():
    counts = {(0,): 1667, (1,): 1667, (2,): 1666}
    assert _largest_remainder(counts, 2000) == {(0,): 667, (1,): 667, (2,): 666}


def _audit(objective_version: str, end_reason: str) -> dict:
    return {
        "objectiveVersion": objective_version,
        "endReason": end_reason,
        "initialStateRecord": {
            "variant": "standard",
            "startMode": "traditional",
            "dimensionMode": "low",
            "boardWidth": 5,
            "boardHeight": 5,
        },
    }


def test_capped_games_are_not_admitted():
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary)
        (path / "game_1.audit.json").write_text(
            json.dumps(_audit(OBJECTIVE_VERSION, "move-limit"))
        )
        assert _admitted_by_cell(path) == {}


def test_old_objective_labels_are_rejected_instead_of_relabeled():
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary)
        (path / "game_1.audit.json").write_text(
            json.dumps(_audit("legacy-winner-blend", "terminal"))
        )
        try:
            _admitted_by_cell(path)
        except ValueError as error:
            assert "objective mismatch" in str(error)
        else:
            raise AssertionError("old-objective audit was admitted")
