import torch

from migrate_universal_checkpoint import migrate_model, verify_exact_migration
from model import WallgameTransformer


def test_migration_copies_old_stem_and_every_later_tensor_exactly():
    torch.manual_seed(17)
    source = WallgameTransformer(
        5, 4, d_model=16, layers=1, heads=4, channels=9
    )
    migrated, config = migrate_model(source)
    verify_exact_migration(source, migrated)

    assert config["channels"] == 16
    assert migrated.stem.weight.shape == (16, 16, 1, 1)
    assert torch.equal(migrated.stem.weight[:, :9], source.stem.weight)
    assert torch.count_nonzero(migrated.stem.weight[:, 9:]).item() == 0
    assert torch.equal(migrated.stem.bias, source.stem.bias)


def test_migration_preserves_old_outputs_for_standard_and_classic_inputs():
    torch.manual_seed(19)
    source = WallgameTransformer(
        5, 4, d_model=16, layers=1, heads=4, channels=9
    ).eval()
    migrated, _ = migrate_model(source)
    migrated.eval()
    source.log_output = False
    migrated.log_output = False

    old = torch.randn(2, 9, 5, 4)
    old[0, 8].zero_()
    old[1, 8].fill_(1.0)
    new = torch.zeros(2, 16, 5, 4)
    new[:, :8] = old[:, :8]
    new[0, 9].fill_(1.0)
    new[1, 8].fill_(1.0)

    with torch.inference_mode():
        old_outputs = source(old)
        new_outputs = migrated(new)
    for old_output, new_output in zip(old_outputs, new_outputs):
        assert torch.allclose(old_output, new_output, rtol=0, atol=2e-6)
