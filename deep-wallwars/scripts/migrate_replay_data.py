#!/usr/bin/env python3
"""Offline migration from the locked 9-plane replay format to 16 planes.

The source directory name is part of the old format's rules identity. This tool
accepts only directories containing ``_standard_`` or ``_classic_`` and requires
that identity to agree with ``--variant``. Runtime loaders do not decode the old
format.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile


FORMAT_NAME = "wallgame-replay-csv-16-plane-v1"
SOURCE_FORMAT_NAME = "wallgame-replay-csv-9-plane-v1"


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _file_record(root, path):
    data = path.read_bytes()
    return {
        "path": path.relative_to(root).as_posix(),
        "bytes": len(data),
        "sha256": _sha256(data),
    }


def _tree_hash(records):
    digest = hashlib.sha256()
    for record in records:
        digest.update(record["path"].encode())
        digest.update(b"\0")
        digest.update(record["sha256"].encode())
        digest.update(b"\0")
        digest.update(str(record["bytes"]).encode())
        digest.update(b"\n")
    return digest.hexdigest()


def _require_rules_identity(source, variant):
    marker = f"_{variant}_"
    if marker not in source.name:
        raise ValueError(
            f"source directory {source.name!r} does not carry unambiguous {variant!r} rules identity"
        )


def _convert_record(lines, source_path, record_index, variant, cells):
    if len(lines) != 4 or lines[3] != "":
        raise ValueError(f"{source_path}: record {record_index} is not a four-line replay record")

    state = lines[0].split(", ")
    if len(state) != 9 * cells:
        raise ValueError(
            f"{source_path}: record {record_index} has {len(state)} state values; expected {9 * cells}"
        )
    old_variant_plane = state[8 * cells : 9 * cells]
    expected_old_value = 1.0 if variant == "standard" else 0.0
    try:
        plane_matches = all(float(value) == expected_old_value for value in old_variant_plane)
    except ValueError as error:
        raise ValueError(f"{source_path}: record {record_index} plane 8 is not numeric") from error
    if not plane_matches:
        raise ValueError(
            f"{source_path}: record {record_index} plane 8 conflicts with {variant!r} rules identity"
        )

    new_state = state[: 8 * cells]
    for plane in range(8, 16):
        if plane == 8 and variant == "standard":
            new_state.extend(old_variant_plane)
        elif plane == 9 and variant == "classic":
            new_state.extend(["1"] * cells)
        else:
            new_state.extend(["0"] * cells)

    priors = lines[1].split(", ")
    old_move_channels = 8 if variant == "standard" else 4
    expected_priors = 2 * cells + old_move_channels
    if len(priors) != expected_priors:
        raise ValueError(
            f"{source_path}: record {record_index} has {len(priors)} priors; expected {expected_priors}"
        )
    if variant == "classic":
        priors.extend(["0"] * 4)

    values = lines[2].split(", ")
    if len(values) != 1:
        raise ValueError(f"{source_path}: record {record_index} must have one value label")

    return ", ".join(new_state) + "\n" + ", ".join(priors) + "\n" + lines[2] + "\n\n"


def _convert_file(source_path, output_path, variant, columns, rows):
    try:
        text = source_path.read_bytes().decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(f"{source_path}: replay file is not UTF-8") from error
    lines = text.splitlines()
    if not lines or len(lines) % 4:
        raise ValueError(f"{source_path}: replay file does not contain complete four-line records")

    converted = []
    for offset in range(0, len(lines), 4):
        converted.append(
            _convert_record(lines[offset : offset + 4], source_path, offset // 4, variant, columns * rows)
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes("".join(converted).encode("utf-8"))
    return len(converted)


def migrate_directory(source, output, variant, columns, rows):
    source = Path(source).resolve()
    output = Path(output).resolve()
    if variant not in {"standard", "classic"}:
        raise ValueError("old replay data can only identify 'standard' or 'classic'")
    if columns <= 0 or rows <= 0:
        raise ValueError("columns and rows must be positive")
    if not source.is_dir():
        raise ValueError(f"source directory does not exist: {source}")
    if output.exists():
        raise ValueError(f"output path already exists: {output}")
    _require_rules_identity(source, variant)

    source_paths = sorted(path for path in source.rglob("*.csv") if path.is_file())
    if not source_paths:
        raise ValueError(f"source directory has no CSV replay files: {source}")
    source_files = [_file_record(source, path) for path in source_paths]

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        total_records = 0
        for source_path in source_paths:
            relative = source_path.relative_to(source)
            total_records += _convert_file(
                source_path, temporary / relative, variant, columns, rows
            )

        source_files_after = [_file_record(source, path) for path in source_paths]
        if source_files_after != source_files:
            raise RuntimeError("source replay data changed during migration")

        output_paths = sorted(path for path in temporary.rglob("*.csv") if path.is_file())
        output_files = [_file_record(temporary, path) for path in output_paths]
        manifest = {
            "format": FORMAT_NAME,
            "source_format": SOURCE_FORMAT_NAME,
            "variant": variant,
            "columns": columns,
            "rows": rows,
            "state_planes": 16,
            "policy_move_channels": 8,
            "records": total_records,
            "source_tree_sha256": _tree_hash(source_files),
            "output_tree_sha256": _tree_hash(output_files),
            "source_files": source_files,
            "output_files": output_files,
            "mapping": {
                "planes_0_7": "byte-exact tokens from source planes 0-7",
                "plane_8": "source plane 8 for Standard; zero for Classic",
                "plane_9": "one for Classic; zero for Standard",
                "plane_10": "zero; Animal records must be generated directly",
                "planes_11_15": "zero",
                "classic_policy_channels_4_7": "zero padded offline",
            },
        }
        manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
        (temporary / "migration-manifest.json").write_bytes(manifest_bytes)
        os.rename(temporary, output)
        return manifest
    except BaseException:
        shutil.rmtree(temporary)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--variant", choices=("standard", "classic"), required=True)
    parser.add_argument("--columns", type=int, required=True)
    parser.add_argument("--rows", type=int, required=True)
    args = parser.parse_args()
    manifest = migrate_directory(args.source, args.output, args.variant, args.columns, args.rows)
    print(json.dumps(manifest, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
