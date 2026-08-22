#!/usr/bin/env python3
"""The one definition of the Elo results table, and the gate that reads it.

Three programs touch these tables - the generator that writes them
(`elo_db/scripts/build_results_tables.py`), the snapshot builder that rates from
them (`build_policy_elo_app_data.py`), and the verifier
(`verify_policy_elo_tables.py`). They share this module so that the column list,
the allowed values and the checks cannot drift apart between them.

`read_table` is FAIL-CLOSED and lives on the NORMAL rebuild path, not in an
optional side tool. A safety property that only holds when somebody remembers to
run a checker is not a safety property. Because the builder verifies each table
against the fingerprint recorded in `experiments.json`, a wrong winner cannot reach
a rebuilt snapshot unless the manifest is deliberately changed as well - and
changing it is visible in review, where `verify_policy_elo_tables.py --raw-sources`
is the independent check against the raw archives.
"""
import csv
import hashlib
import re
from pathlib import Path

SCHEMA = "wallgame-elo-results-table-v1"

# Resolved from this module's own location, so a copy of the tree checks itself
# rather than the original.
REPO_ROOT = Path(__file__).resolve().parents[2]
TABLE_DIR_RELATIVE = "deep-wallwars/elo_db/results"

COLUMNS = [
    "exp",
    "sourceFile",
    "conditionId",
    "variant",
    "setup",
    "board",
    "p1",
    "p2",
    "candidateIsP1",
    "winner",
    "evidenceStatus",
    "exclusionReason",
    "engineSeed",
    "randomStartSeed",
    "game",
]

BOOLEANS = {"true": True, "false": False}
EVIDENCE_STATUS = {"accepted", "excluded"}
ACCEPTED_WINNERS = {"p1", "p2", "draw"}
PLAYER = re.compile(r"^tf:(0|[1-9][0-9]*)$")


class TableError(ValueError):
    """A refusal to read a table. Never a warning, never a repair."""


def generation(identity):
    """`tf:116` -> 116. The caller has already checked the shape."""
    return int(identity.split(":")[1])


def canonical_path(experiment):
    """The one place an experiment's table may live, as the manifest must spell it."""
    return f"{TABLE_DIR_RELATIVE}/{experiment}.csv"


def read_table(path, experiment, record):
    """Validate one results table against its manifest record, then return its rows.

    `record` is the `results` object from that experiment's `experiments.json`
    entry. Every mismatch raises; nothing is coerced and nothing is skipped.
    """
    if record.get("schema") != SCHEMA:
        raise TableError(
            f"{experiment}: manifest records schema {record.get('schema')!r}, "
            f"this code reads {SCHEMA!r}"
        )

    # Provenance before content. A basename test would accept
    # `wrong/location/<experiment>.csv`, and then the builder reading its canonical
    # directory and the verifier following the manifest would validate DIFFERENT
    # files while both reported success. So the manifest must name the one canonical
    # path exactly, and the file about to be read must BE that file.
    expected = canonical_path(experiment)
    if record.get("path") != expected:
        raise TableError(
            f"{experiment}: manifest path is {record.get('path')!r}, expected exactly "
            f"{expected!r}"
        )
    target = (REPO_ROOT / expected).resolve()
    if Path(path).resolve() != target:
        raise TableError(
            f"{experiment}: asked to read {Path(path).resolve()}, but the manifest "
            f"names {target}. A table is only evidence where the manifest says it is"
        )

    if not path.exists():
        raise TableError(f"{experiment}: results table missing at {path}")

    raw = path.read_bytes()

    if len(raw) != record.get("bytes"):
        raise TableError(
            f"{experiment}: table is {len(raw)} bytes, manifest records {record.get('bytes')}"
        )
    digest = hashlib.sha256(raw).hexdigest()
    if digest != record.get("sha256"):
        raise TableError(
            f"{experiment}: table sha256 is {digest}, manifest records {record.get('sha256')}"
        )

    text = raw.decode("utf-8")
    reader = csv.reader(text.splitlines())
    try:
        header = next(reader)
    except StopIteration:
        raise TableError(f"{experiment}: table is empty")
    if header != COLUMNS:
        raise TableError(
            f"{experiment}: header is {header}, expected exactly {COLUMNS}"
        )

    rows = []
    for number, values in enumerate(reader, start=2):
        where = f"{experiment}:{number}"
        if len(values) != len(COLUMNS):
            raise TableError(
                f"{where}: {len(values)} fields, expected {len(COLUMNS)}"
            )
        row = dict(zip(COLUMNS, values))

        if row["exp"] != experiment:
            raise TableError(
                f"{where}: row names experiment {row['exp']!r}, table is {experiment!r}"
            )
        if row["candidateIsP1"] not in BOOLEANS:
            raise TableError(
                f"{where}: candidateIsP1 is {row['candidateIsP1']!r}, expected "
                f"'true' or 'false'"
            )
        if row["evidenceStatus"] not in EVIDENCE_STATUS:
            raise TableError(
                f"{where}: evidenceStatus is {row['evidenceStatus']!r}, expected "
                f"'accepted' or 'excluded'"
            )
        for field in ("p1", "p2"):
            if not PLAYER.match(row[field]):
                raise TableError(
                    f"{where}: {field} is {row[field]!r}, expected an identity like 'tf:116'"
                )

        if row["evidenceStatus"] == "accepted":
            if row["winner"] not in ACCEPTED_WINNERS:
                raise TableError(
                    f"{where}: an accepted row has winner {row['winner']!r}, expected "
                    f"'p1', 'p2' or 'draw'"
                )
            if row["exclusionReason"]:
                raise TableError(
                    f"{where}: an accepted row carries exclusionReason "
                    f"{row['exclusionReason']!r}"
                )
        else:
            if row["winner"]:
                raise TableError(
                    f"{where}: an excluded row carries winner {row['winner']!r}. An "
                    f"excluded game has no winner - its stored result and outcome "
                    f"often disagree in sign"
                )
            if not row["exclusionReason"]:
                raise TableError(f"{where}: an excluded row carries no exclusionReason")

        rows.append(row)

    if len(rows) != record.get("rows"):
        raise TableError(
            f"{experiment}: table holds {len(rows)} rows, manifest records {record.get('rows')}"
        )
    return rows


def results_record(experiments, experiment):
    """The `results` object for one experiment, or a refusal naming what is missing."""
    entry = experiments.get(experiment)
    if entry is None:
        raise TableError(f"{experiment}: not in experiments.json")
    record = entry.get("results")
    if not record:
        raise TableError(
            f"{experiment}: experiments.json entry has no `results` record, so its "
            f"table cannot be checked against anything"
        )
    return record
