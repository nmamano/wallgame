import sys
from pathlib import Path
from types import ModuleType

import pytest

import data


def _line(values):
    return ", ".join(str(value) for value in values) + "\n"


def _record(value, columns=2, rows=2):
    cells = columns * rows
    return _line([value] * (16 * cells)) + _line([0] * (2 * cells + 8)) + _line([value]) + "\n"


def _install_fastai_file_stub(monkeypatch):
    fastai = ModuleType("fastai")
    fastai_data = ModuleType("fastai.data")
    fastai_all = ModuleType("fastai.data.all")
    fastai_all.RandomSplitter = lambda: None
    fastai_all.get_files = lambda path: sorted(file for file in Path(path).iterdir() if file.is_file())
    fastai.data = fastai_data
    fastai_data.all = fastai_all
    monkeypatch.setitem(sys.modules, "fastai", fastai)
    monkeypatch.setitem(sys.modules, "fastai.data", fastai_data)
    monkeypatch.setitem(sys.modules, "fastai.data.all", fastai_all)


def _all_training(files):
    return range(len(files)), []


def test_dataset_discovery_ignores_sidecars_before_sampling(tmp_path, monkeypatch):
    _install_fastai_file_stub(monkeypatch)
    for game, value in ((1, 0.25), (2, 0.5), (3, 0.75)):
        (tmp_path / f"game_{game}.csv").write_text(_record(value))
        (tmp_path / f"game_{game}.audit.json").write_text('{"valid": true}\n')
    (tmp_path / "notes.txt").write_text("not replay data\n")

    sampled = []

    def select_expected(files, games):
        sampled.extend(file.name for file in files)
        assert games == 2
        return files[1:3]

    monkeypatch.setattr(data, "sample", select_expected)
    training, validation = data.get_datasets([tmp_path], 2, 16, 2, 2, 8, splitter=_all_training)

    assert sampled == ["game_1.csv", "game_2.csv", "game_3.csv"]
    assert [entry[1][1].item() for entry in training] == [0.5, 0.75]
    assert validation == []


def test_dataset_discovery_still_rejects_malformed_csv(tmp_path, monkeypatch):
    _install_fastai_file_stub(monkeypatch)
    (tmp_path / "game_1.csv").write_text("not, numeric, replay\n")
    (tmp_path / "game_1.audit.json").write_text('{"valid": true}\n')

    with pytest.raises(ValueError):
        data.get_datasets([tmp_path], 1, 16, 2, 2, 8, splitter=_all_training)
