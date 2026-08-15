import hashlib
import json
from pathlib import Path

import pytest

from migrate_replay_data import migrate_directory
from data import parse_file


def _line(values):
    return ", ".join(str(value) for value in values) + "\n"


def _old_record(columns, rows, variant):
    cells = columns * rows
    state = list(range(8 * cells))
    state.extend([1 if variant == "standard" else 0] * cells)
    move_priors = 8 if variant == "standard" else 4
    priors = [0.0] * (2 * cells + move_priors)
    priors[0] = 0.75
    priors[2 * cells] = 0.25
    return (_line(state) + _line(priors) + "0.125\n\n").encode()


@pytest.mark.parametrize("variant,active_plane", [("standard", 8), ("classic", 9)])
def test_migration_is_deterministic_and_keeps_sources_unchanged(tmp_path, variant, active_plane):
    columns, rows = 4, 4
    source = tmp_path / f"generation_92_{variant}_4x4"
    source.mkdir()
    original = _old_record(columns, rows, variant)
    (source / "game_1.csv").write_bytes(original)
    source_hash = hashlib.sha256(original).hexdigest()

    first = tmp_path / "first"
    second = tmp_path / "second"
    first_manifest = migrate_directory(source, first, variant, columns, rows)
    second_manifest = migrate_directory(source, second, variant, columns, rows)

    assert (source / "game_1.csv").read_bytes() == original
    assert hashlib.sha256(original).hexdigest() == source_hash
    assert (first / "game_1.csv").read_bytes() == (second / "game_1.csv").read_bytes()
    assert first_manifest == second_manifest

    lines = (first / "game_1.csv").read_text().splitlines()
    state = lines[0].split(", ")
    cells = columns * rows
    assert state[: 8 * cells] == _line(range(8 * cells)).strip().split(", ")
    for plane in range(8, 16):
        expected = "1" if plane == active_plane else "0"
        assert state[plane * cells : (plane + 1) * cells] == [expected] * cells

    priors = lines[1].split(", ")
    assert len(priors) == 2 * cells + 8
    if variant == "classic":
        assert priors[-4:] == ["0"] * 4

    on_disk = json.loads((first / "migration-manifest.json").read_text())
    assert on_disk == first_manifest
    assert on_disk["source_files"][0]["sha256"] == source_hash


def test_migration_rejects_classic_data_without_classic_identity(tmp_path):
    source = tmp_path / "generation_92_mixed_4x4"
    source.mkdir()
    (source / "game_1.csv").write_bytes(_old_record(4, 4, "classic"))

    with pytest.raises(ValueError, match="rules identity"):
        migrate_directory(source, tmp_path / "out", "classic", 4, 4)


def test_migration_rejects_plane_eight_that_conflicts_with_variant(tmp_path):
    source = tmp_path / "generation_92_classic_4x4"
    source.mkdir()
    (source / "game_1.csv").write_bytes(_old_record(4, 4, "standard"))

    with pytest.raises(ValueError, match="plane 8"):
        migrate_directory(source, tmp_path / "out", "classic", 4, 4)


def test_runtime_loader_accepts_only_converted_16_plane_records(tmp_path):
    source = tmp_path / "generation_92_standard_4x4"
    source.mkdir()
    old_file = source / "game_1.csv"
    old_file.write_bytes(_old_record(4, 4, "standard"))
    output = tmp_path / "converted"
    migrate_directory(source, output, "standard", 4, 4)

    with pytest.raises(ValueError, match="only the 16-plane format"):
        parse_file(old_file, 9, 4, 4, 8)
    parsed = parse_file(output / "game_1.csv", 16, 4, 4, 8)
    assert len(parsed) == 1
    assert tuple(parsed[0][0].shape) == (16, 4, 4)
    assert len(parsed[0][1][0]) == 2 * 4 * 4 + 8
