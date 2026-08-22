from copy import deepcopy
from types import SimpleNamespace

import pytest
import torch

from migrate_universal_checkpoint import (
    AUDITED_ARCHITECTURE,
    COPY_CONTRACT,
    MANIFEST_KIND,
    MANIFEST_VERSION,
    state_dict_sha256,
)
from model import WallgameTransformer
from verify_universal_checkpoint_batch import (
    sha256,
    validate_boundary,
    validate_migration_manifest,
)


@pytest.fixture
def manifest_case(tmp_path):
    generation = 17
    source_path = tmp_path / f"model_{generation}.pt"
    migrated_path = tmp_path / "migrated" / f"model_{generation}.pt"
    migrated_path.parent.mkdir()
    source = WallgameTransformer(5, 4, d_model=16, layers=1, heads=4, channels=9)
    migrated = WallgameTransformer(5, 4, d_model=16, layers=1, heads=4, channels=16)
    torch.save(source, source_path)
    torch.save(migrated, migrated_path)
    manifest_path = migrated_path.with_name(f"model_{generation}.migration.json")
    manifest = {
        "kind": MANIFEST_KIND,
        "version": MANIFEST_VERSION,
        "generation": generation,
        "source": str(source_path.resolve()),
        "output": str(migrated_path.resolve()),
        "source_sha256": sha256(source_path),
        "output_sha256": sha256(migrated_path),
        "source_state_sha256": state_dict_sha256(source.state_dict()),
        "output_state_sha256": state_dict_sha256(migrated.state_dict()),
        "source_config": {**AUDITED_ARCHITECTURE, "channels": 9},
        "output_config": {**AUDITED_ARCHITECTURE, "channels": 16},
        "contract": COPY_CONTRACT,
    }
    return manifest, manifest_path, generation, source_path, migrated_path, source, migrated


def validate(case, manifest):
    _, manifest_path, generation, source_path, migrated_path, source, migrated = case
    validate_migration_manifest(
        manifest, manifest_path, generation, source_path, migrated_path, source, migrated
    )


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (lambda row: row.update(source="/wrong/model_17.pt"), "source path mismatch"),
        (lambda row: row["source_config"].update(rows=9), "source config mismatch"),
        (
            lambda row: row["contract"].update(zero_initialized_planes=[9]),
            "copy contract mismatch",
        ),
        (lambda row: row.update(source_state_sha256="0" * 64), "source state hash mismatch"),
        (lambda row: row.update(output_state_sha256="0" * 64), "output state hash mismatch"),
    ],
)
def test_manifest_known_bad_controls_fail_for_intended_reason(manifest_case, mutation, message):
    manifest = deepcopy(manifest_case[0])
    mutation(manifest)
    with pytest.raises(ValueError, match=message):
        validate(manifest_case, manifest)


def test_unpinned_boundary_artifact_is_rejected_before_model_load(tmp_path):
    wrong_manifest = tmp_path / "wrong-manifest.json"
    wrong_report = tmp_path / "wrong-report.json"
    wrong_model = tmp_path / "wrong-model.pt"
    for path in (wrong_manifest, wrong_report, wrong_model):
        path.write_text("wrong")
    args = SimpleNamespace(
        start=1,
        end=92,
        boundary_manifest=wrong_manifest,
        boundary_parity_report=wrong_report,
        boundary_migrated=wrong_model,
        source_dir=tmp_path,
    )
    with pytest.raises(ValueError, match="boundary manifest is not the reviewed accepted artifact"):
        validate_boundary(args)
