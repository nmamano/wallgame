"""Verify that a directory of migrated checkpoints preserves each old player."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import torch

from migrate_universal_checkpoint import (
    AUDITED_ARCHITECTURE,
    COPY_CONTRACT,
    MANIFEST_KIND,
    MANIFEST_VERSION,
    require_audited_architecture,
    state_dict_sha256,
    verify_exact_migration,
)
from verify_generation_93_migration import ATOL, fixtures, model_outputs

BOUNDARY_GENERATION = 93
BOUNDARY_MANIFEST_SHA256 = "52c045c2407c1dcd1e95a6cfacc8f47890114e37ab225eaadbf64939a97e19d1"
BOUNDARY_PARITY_REPORT_SHA256 = "30449415ff4574c37fba4b4ba7dc50f27574b52492e212e8bc910eb852cb6eb2"
BOUNDARY_SOURCE_SHA256 = "6a9b26fa20458a6c6b569fa4c662c2516ca04a68c368e17591c134153902058f"
BOUNDARY_MIGRATED_SHA256 = "b0c6321a57cbcd3aee552e8c42e3c2b3279ac0fff4fc33a42d4d3d0f876f5a1c"
BOUNDARY_MANIFEST_KIND = "wallgame-generation-93-16-plane-migration"
BOUNDARY_REPORT_KIND = "wallgame-generation-93-cpu-parity"


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def output_checks(outputs):
    priors, values = outputs
    if not np.isfinite(priors).all() or not np.isfinite(values).all():
        raise ValueError("model output contains a non-finite value")
    if np.max(np.abs(priors.sum(axis=1) - 1.0)) > 1e-5:
        raise ValueError("policy probabilities do not sum to one")
    if np.min(priors) < 0 or np.max(priors) > 1:
        raise ValueError("policy probability is outside [0, 1]")
    if np.min(values) < -1 or np.max(values) > 1:
        raise ValueError("value output is outside [-1, 1]")


def require_equal(actual, expected, message):
    if actual != expected:
        raise ValueError(f"{message}: {actual!r} != {expected!r}")


def validate_migration_manifest(
    manifest, manifest_path, generation, source_path, migrated_path, source, migrated
):
    require_equal(manifest.get("kind"), MANIFEST_KIND, f"generation {generation} manifest kind mismatch")
    require_equal(manifest.get("version"), MANIFEST_VERSION, f"generation {generation} manifest version mismatch")
    require_equal(manifest.get("generation"), generation, f"generation {generation} manifest identity mismatch")
    require_equal(
        Path(manifest.get("source", "")).resolve(),
        source_path.resolve(),
        f"generation {generation} manifest source path mismatch",
    )
    require_equal(
        Path(manifest.get("output", "")).resolve(),
        migrated_path.resolve(),
        f"generation {generation} manifest output path mismatch",
    )
    require_equal(manifest_path.name, f"model_{generation}.migration.json", f"generation {generation} manifest filename mismatch")
    require_equal(manifest.get("source_sha256"), sha256(source_path), f"generation {generation} source hash mismatch")
    require_equal(manifest.get("output_sha256"), sha256(migrated_path), f"generation {generation} migrated hash mismatch")
    require_equal(
        manifest.get("source_state_sha256"),
        state_dict_sha256(source.state_dict()),
        f"generation {generation} source state hash mismatch",
    )
    require_equal(
        manifest.get("output_state_sha256"),
        state_dict_sha256(migrated.state_dict()),
        f"generation {generation} output state hash mismatch",
    )
    require_equal(
        manifest.get("source_config"),
        {**AUDITED_ARCHITECTURE, "channels": 9},
        f"generation {generation} source config mismatch",
    )
    require_equal(
        manifest.get("output_config"),
        {**AUDITED_ARCHITECTURE, "channels": 16},
        f"generation {generation} output config mismatch",
    )
    require_equal(manifest.get("contract"), COPY_CONTRACT, f"generation {generation} copy contract mismatch")


def validate_boundary(args):
    if args.start <= BOUNDARY_GENERATION <= args.end:
        raise ValueError("boundary generation 93 must be outside the migrated range")
    if sha256(args.boundary_manifest) != BOUNDARY_MANIFEST_SHA256:
        raise ValueError("boundary manifest is not the reviewed accepted artifact")
    if sha256(args.boundary_parity_report) != BOUNDARY_PARITY_REPORT_SHA256:
        raise ValueError("boundary parity report is not the reviewed accepted artifact")
    manifest = json.loads(args.boundary_manifest.read_text())
    report = json.loads(args.boundary_parity_report.read_text())
    require_equal(manifest.get("kind"), BOUNDARY_MANIFEST_KIND, "boundary manifest kind mismatch")
    require_equal(manifest.get("source_sha256"), BOUNDARY_SOURCE_SHA256, "boundary manifest source identity mismatch")
    require_equal(manifest.get("output_sha256"), BOUNDARY_MIGRATED_SHA256, "boundary manifest output identity mismatch")
    require_equal(manifest.get("config"), {**AUDITED_ARCHITECTURE, "channels": 16}, "boundary manifest config mismatch")
    require_equal(manifest.get("contract"), COPY_CONTRACT, "boundary manifest contract mismatch")
    require_equal(report.get("kind"), BOUNDARY_REPORT_KIND, "boundary parity report kind mismatch")
    require_equal(report.get("tolerance_max_abs"), ATOL, "boundary parity tolerance mismatch")
    require_equal(report.get("artifacts", {}).get("source_pt_sha256"), BOUNDARY_SOURCE_SHA256, "boundary report source identity mismatch")
    require_equal(report.get("artifacts", {}).get("migrated_pt_sha256"), BOUNDARY_MIGRATED_SHA256, "boundary report output identity mismatch")
    for name in ("pytorch_old_vs_migrated", "onnx_old_vs_migrated"):
        comparison = report.get("comparisons", {}).get(name, {})
        if any(comparison.get(field, float("inf")) > ATOL for field in ("priors_max_abs", "values_max_abs")):
            raise ValueError(f"boundary accepted parity exceeds tolerance: {name}")
    source_path = args.source_dir / f"model_{BOUNDARY_GENERATION}.pt"
    if sha256(source_path) != BOUNDARY_SOURCE_SHA256:
        raise ValueError("boundary source checkpoint is not the reviewed accepted artifact")
    if sha256(args.boundary_migrated) != BOUNDARY_MIGRATED_SHA256:
        raise ValueError("boundary migrated checkpoint is not the reviewed accepted artifact")
    source = torch.load(source_path, map_location="cpu", weights_only=False).eval()
    migrated = torch.load(args.boundary_migrated, map_location="cpu", weights_only=False).eval()
    require_audited_architecture(source, 9, "boundary source")
    require_audited_architecture(migrated, 16, "boundary migrated")
    require_equal(
        manifest.get("source_state_sha256"),
        state_dict_sha256(source.state_dict()),
        "boundary manifest source state mismatch",
    )
    require_equal(
        manifest.get("output_state_sha256"),
        state_dict_sha256(migrated.state_dict()),
        "boundary manifest output state mismatch",
    )
    verify_exact_migration(source, migrated)
    return source_path, source, migrated


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--migrated-dir", type=Path, required=True)
    parser.add_argument("--start", type=int, required=True)
    parser.add_argument("--end", type=int, required=True)
    parser.add_argument("--boundary-migrated", type=Path, required=True)
    parser.add_argument("--boundary-manifest", type=Path, required=True)
    parser.add_argument("--boundary-parity-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    if args.start < 1 or args.end < args.start:
        raise SystemExit("FATAL: invalid generation range")
    if args.output.exists():
        raise SystemExit(f"FATAL: refusing to overwrite {args.output}")

    rows = []
    for generation in range(args.start, args.end + 1):
        source_path = args.source_dir / f"model_{generation}.pt"
        migrated_path = args.migrated_dir / f"model_{generation}.pt"
        manifest_path = args.migrated_dir / f"model_{generation}.migration.json"
        if not source_path.is_file() or not migrated_path.is_file() or not manifest_path.is_file():
            raise ValueError(f"generation {generation} lacks a migration artifact")

        source = torch.load(source_path, map_location="cpu", weights_only=False).eval()
        migrated = torch.load(migrated_path, map_location="cpu", weights_only=False).eval()
        require_audited_architecture(source, 9, f"generation {generation} source")
        require_audited_architecture(migrated, 16, f"generation {generation} migrated")
        manifest = json.loads(manifest_path.read_text())
        validate_migration_manifest(
            manifest, manifest_path, generation, source_path, migrated_path, source, migrated
        )
        verify_exact_migration(source, migrated)
        old_states, new_states = fixtures(source.columns, source.rows)
        old_outputs = model_outputs(source, old_states)
        migrated_outputs = model_outputs(migrated, new_states)
        repeated_outputs = model_outputs(migrated, new_states)
        output_checks(old_outputs)
        output_checks(migrated_outputs)

        policy_diff = float(np.max(np.abs(old_outputs[0] - migrated_outputs[0])))
        value_diff = float(np.max(np.abs(old_outputs[1] - migrated_outputs[1])))
        if policy_diff > ATOL or value_diff > ATOL:
            raise ValueError(
                f"generation {generation} migration parity exceeds {ATOL}: "
                f"policy={policy_diff}, value={value_diff}"
            )
        deterministic = all(
            np.array_equal(first, second)
            for first, second in zip(migrated_outputs, repeated_outputs)
        )
        if not deterministic:
            raise ValueError(f"generation {generation} migrated output is not deterministic")
        rows.append(
            {
                "generation": generation,
                "sourceSha256": manifest["source_sha256"],
                "migratedSha256": manifest["output_sha256"],
                "policyMaxAbsDifference": policy_diff,
                "valueMaxAbsDifference": value_diff,
                "deterministic": True,
                "finite": True,
                "policyProbabilityRange": [
                    float(np.min(migrated_outputs[0])),
                    float(np.max(migrated_outputs[0])),
                ],
                "valueRange": [
                    float(np.min(migrated_outputs[1])),
                    float(np.max(migrated_outputs[1])),
                ],
            }
        )

    source_path, source, migrated = validate_boundary(args)
    generation = BOUNDARY_GENERATION
    migrated_path = args.boundary_migrated
    old_states, new_states = fixtures(source.columns, source.rows)
    old_outputs = model_outputs(source, old_states)
    migrated_outputs = model_outputs(migrated, new_states)
    repeated_outputs = model_outputs(migrated, new_states)
    output_checks(old_outputs)
    output_checks(migrated_outputs)
    policy_diff = float(np.max(np.abs(old_outputs[0] - migrated_outputs[0])))
    value_diff = float(np.max(np.abs(old_outputs[1] - migrated_outputs[1])))
    if policy_diff > ATOL or value_diff > ATOL:
        raise ValueError(
            f"boundary generation {generation} parity exceeds {ATOL}: "
            f"policy={policy_diff}, value={value_diff}"
        )
    if not all(
        np.array_equal(first, second)
        for first, second in zip(migrated_outputs, repeated_outputs)
    ):
        raise ValueError(
            f"boundary generation {generation} migrated output is not deterministic"
        )
    rows.append(
        {
            "generation": generation,
            "kind": "existing-boundary-oracle",
            "sourceSha256": sha256(source_path),
            "migratedSha256": sha256(migrated_path),
            "acceptedManifestSha256": BOUNDARY_MANIFEST_SHA256,
            "acceptedParityReportSha256": BOUNDARY_PARITY_REPORT_SHA256,
            "policyMaxAbsDifference": policy_diff,
            "valueMaxAbsDifference": value_diff,
            "deterministic": True,
            "finite": True,
        }
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "x") as destination:
        for row in rows:
            destination.write(json.dumps(row, separators=(",", ":")) + "\n")
    print(json.dumps({"models": len(rows), "start": args.start, "end": args.end}))


if __name__ == "__main__":
    main()
