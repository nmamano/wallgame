"""Migrate one universal transformer checkpoint from 9 to 16 input planes.

The source checkpoint is read-only. The migrated stem copies channels 0-8 and
sets channels 9-15 to zero. Every other parameter and buffer is copied exactly.
"""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import torch

from model import MODEL_INPUT_CHANNELS, WallgameTransformer

OLD_INPUT_CHANNELS = 9
MODEL_FILE = re.compile(r"model_(\d+)\.pt$")
MANIFEST_KIND = "wallgame-universal-checkpoint-16-plane-migration"
MANIFEST_VERSION = 1
COPY_CONTRACT = {
    "copied_source_planes": list(range(9)),
    "zero_initialized_planes": list(range(9, 16)),
    "later_state": "byte-identical tensors",
}
AUDITED_ARCHITECTURE = {
    "columns": 12,
    "rows": 10,
    "d_model": 256,
    "layers": 10,
    "heads": 8,
    "stem": "pointwise",
    "move_channels": 8,
}


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def state_dict_sha256(state):
    digest = hashlib.sha256()
    for name in sorted(state):
        tensor = state[name].detach().cpu().contiguous()
        digest.update(name.encode())
        digest.update(str(tensor.dtype).encode())
        digest.update(json.dumps(list(tensor.shape)).encode())
        digest.update(tensor.numpy().tobytes())
    return digest.hexdigest()


def transformer_config(model, expected_channels):
    if type(model) is not WallgameTransformer:
        raise ValueError(f"expected WallgameTransformer, found {type(model).__name__}")
    if not isinstance(model.stem, torch.nn.Conv2d) or model.stem.kernel_size != (1, 1):
        raise ValueError("checkpoint migration requires the pointwise Conv2d stem")
    if model.stem.in_channels != expected_channels:
        raise ValueError(
            f"expected {expected_channels} channels, found {model.stem.in_channels}"
        )
    layers = 0 if model.encoder is None else len(model.encoder.layers)
    if layers == 0:
        raise ValueError("checkpoint unexpectedly has no encoder layers")
    heads = {layer.self_attn.num_heads for layer in model.encoder.layers}
    dimensions = {layer.self_attn.embed_dim for layer in model.encoder.layers}
    if (
        len(heads) != 1
        or len(dimensions) != 1
        or dimensions != {model.stem.out_channels}
    ):
        raise ValueError("checkpoint encoder layers do not share one architecture")
    return {
        "columns": model.columns,
        "rows": model.rows,
        "d_model": model.stem.out_channels,
        "layers": layers,
        "heads": heads.pop(),
        "stem": "pointwise",
        "move_channels": model.move_channels,
        "channels": model.stem.in_channels,
    }


def require_audited_architecture(model, channels, label):
    actual = transformer_config(model, channels)
    expected = {**AUDITED_ARCHITECTURE, "channels": channels}
    if actual != expected:
        raise ValueError(f"{label} audited architecture mismatch: {actual} != {expected}")
    return actual


def migrate_model(source_model, enforce_audited_contract=True):
    source_config = transformer_config(source_model, OLD_INPUT_CHANNELS)
    if enforce_audited_contract:
        require_audited_architecture(source_model, OLD_INPUT_CHANNELS, "source")
    output_config = {**source_config, "channels": MODEL_INPUT_CHANNELS}
    migrated = WallgameTransformer(**output_config)
    source_state = source_model.state_dict()
    migrated_state = migrated.state_dict()

    if set(source_state) != set(migrated_state):
        raise ValueError("source and migrated state dictionaries have different keys")

    for name, source_tensor in source_state.items():
        if name == "stem.weight":
            target = torch.zeros_like(migrated_state[name])
            target[:, :OLD_INPUT_CHANNELS] = source_tensor
            migrated_state[name] = target
            continue
        if source_tensor.shape != migrated_state[name].shape:
            raise ValueError(
                f"unexpected shape change for {name}: {tuple(source_tensor.shape)} -> "
                f"{tuple(migrated_state[name].shape)}"
            )
        migrated_state[name] = source_tensor.clone()

    migrated.load_state_dict(migrated_state, strict=True)
    migrated.log_output = source_model.log_output
    if enforce_audited_contract:
        require_audited_architecture(migrated, MODEL_INPUT_CHANNELS, "migrated")
    return migrated, source_config, output_config


def verify_exact_migration(source_model, migrated_model):
    source = source_model.state_dict()
    migrated = migrated_model.state_dict()
    if set(source) != set(migrated):
        raise ValueError("source and migrated state dictionaries have different keys")
    if not torch.equal(migrated["stem.weight"][:, :OLD_INPUT_CHANNELS], source["stem.weight"]):
        raise ValueError("stem channels 0-8 were not copied exactly")
    if torch.count_nonzero(migrated["stem.weight"][:, OLD_INPUT_CHANNELS:]).item() != 0:
        raise ValueError("new stem channels are not all zero")
    for name, source_tensor in source.items():
        if name != "stem.weight" and not torch.equal(migrated[name], source_tensor):
            raise ValueError(f"parameter or buffer changed during migration: {name}")


def generation_from_paths(source, output, manifest_path):
    generation_match = MODEL_FILE.fullmatch(source.name)
    if generation_match is None:
        raise ValueError("source filename must be model_<generation>.pt")
    generation = int(generation_match.group(1))
    if output.name != f"model_{generation}.pt":
        raise ValueError("output filename generation must match the source generation")
    if manifest_path.name != f"model_{generation}.migration.json":
        raise ValueError("manifest filename generation must match the source generation")
    return generation


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()

    source = Path(args.source).resolve()
    output = Path(args.output).resolve()
    manifest_path = Path(args.manifest).resolve()
    if source == output:
        sys.exit("FATAL: source and output must be different files")
    try:
        generation = generation_from_paths(source, output, manifest_path)
    except ValueError as error:
        sys.exit(f"FATAL: {error}")
    if output.exists() or manifest_path.exists():
        sys.exit("FATAL: refusing to overwrite an existing migration artifact")

    source_model = torch.load(source, map_location="cpu", weights_only=False)
    source_model.eval()
    migrated, source_config, output_config = migrate_model(source_model)
    migrated.eval()
    verify_exact_migration(source_model, migrated)

    output.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(migrated, output)
    reloaded = torch.load(output, map_location="cpu", weights_only=False)
    verify_exact_migration(source_model, reloaded)

    manifest = {
        "kind": MANIFEST_KIND,
        "version": MANIFEST_VERSION,
        "generation": generation,
        "source": str(source),
        "source_sha256": file_sha256(source),
        "output": str(output),
        "output_sha256": file_sha256(output),
        "source_state_sha256": state_dict_sha256(source_model.state_dict()),
        "output_state_sha256": state_dict_sha256(reloaded.state_dict()),
        "source_config": source_config,
        "output_config": output_config,
        "contract": COPY_CONTRACT,
        "torch_version": torch.__version__,
    }
    with open(manifest_path, "x") as destination:
        json.dump(manifest, destination, indent=2, sort_keys=True)
        destination.write("\n")
    print(json.dumps(manifest, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
