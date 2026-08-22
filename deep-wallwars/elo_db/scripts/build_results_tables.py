#!/usr/bin/env python3
"""Derive the tracked results tables from the local-only JSONL game archives.

Nil ruled on 2026-08-22 that the repository tracks a RESULTS TABLE per experiment -
the experiment reference, the two players, the winner, and the condition and start
fields - and not the raw games. The raw archives stay on the 4090 desktop under an
explicit ignore rule in `elo_db/.gitignore`; `experiments.json` records each one's
box, path, size and content hash.

This script is the generator for those tables. A tracked derived table with no
generator is the failure this database already records once: `tf_full_2026-07-16` is
permanently unrecoverable because "there is no script, no log, and no shell-history
entry for it".

Run it on the box that holds the archives (the 4090 desktop):

    python3 deep-wallwars/elo_db/scripts/build_results_tables.py

It reads `sources/<experiment>/*.jsonl` and writes `results/<experiment>.csv`.

It REPAIRS NOTHING. Every disagreement it can detect is a hard stop, because a
silently repaired row puts a wrong winner into evidence that later feeds a rating.
Two distinctions it keeps carefully:

* An EXCLUDED game is not a corrupt one. A game that ended with no legal move, or
  that logged a legality error, is real evidence that the fit must not score. It is
  written with `evidenceStatus=excluded`, an `exclusionReason`, and an EMPTY winner -
  never as `p1`, `p2` or `draw`. Its raw `result` and `outcome` frequently disagree
  in sign, which is exactly why a winners-only table would invent a wrong winner.
* `outcome` is candidate-relative (`ours`/`opp`) and `result` is seat-relative
  (`1-0`/`0-1`). Both are kept out of the table because both are derivable from
  `winner` plus `candidateIsP1`; instead every accepted row is CHECKED for agreement
  across all of them, so a disagreement stops the build rather than being stored.
"""
import csv
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCES = os.path.join(ROOT, "sources")
RESULTS = os.path.join(ROOT, "results")
CONDITIONS = os.path.join(os.path.dirname(ROOT), "scripts", "policy_elo_conditions.json")

# The column list and the schema name live with the gate that reads them, in
# ../../scripts/elo_results_tables.py, so the writer and the readers cannot drift.
sys.path.insert(0, os.path.join(os.path.dirname(ROOT), "scripts"))
from elo_results_tables import COLUMNS, SCHEMA  # noqa: E402

# Listed explicitly. A glob over sources/ would silently adopt whatever lands there
# next, and these tables are tracked evidence.
POLICY_ARCHIVES = [
    "tf_phase7_policy_classic_2026-08-20",
    "tf_phase7_policy_standard_2026-08-20",
    "tf_policy_elo_616bc2f2_phase7_boundary_2026-08-20",
    "tf_policy_elo_616bc2f2_phase7_d3d6_2026-08-20",
    "tf_policy_elo_616bc2f2_phase7_d3d6_shortage1_2026-08-20",
    "tf_policy_elo_616bc2f2_phase7_delta1_2026-08-20",
    "tf_policy_elo_616bc2f2_phase7_random_40to64_2026-08-20",
    "tf_policy_elo_616bc2f2_phase7_random_to40_2026-08-20",
]
STRENGTH_ARCHIVES = [
    "tf_model116_vs115_animal_1000_2026-08-20",
    "tf_model116_vs93_1000_2026-08-19a",
    "tf_model116_vs93_1000_2026-08-19b",
    "tf_model116_vs93_standard_1000_2026-08-20c",
]
ARCHIVES = sorted(POLICY_ARCHIVES + STRENGTH_ARCHIVES)


# The fields every row must carry. Their absence is corruption, not exclusion.
REQUIRED = (
    "exp",
    "variant",
    "setup",
    "board",
    "game",
    "engineSeed",
    "randomStartSeed",
    "whiteModel",
    "blackModel",
    "candidateModel",
    "baselineModel",
    "candidateIsP1",
    "result",
    "outcome",
    "legalityErrors",
)

GEN = re.compile(r"model_(\d+)")
PAIR = re.compile(r"_g(\d+)_vs_g(\d+)")
SETUP_TOKEN = {"fixed": "fixed", "random-start": "random"}
WINNER_OF_RESULT = {"1-0": "p1", "0-1": "p2", "1/2-1/2": "draw"}


class Corrupt(SystemExit):
    """A stop, not a warning. Every message names the row it stopped on."""


def condition_ids():
    with open(CONDITIONS, encoding="utf-8") as fh:
        config = json.load(fh)
    return {c["id"] for c in config["conditions"]}, config["archiveConditionAdapters"]


def player(path, where, field):
    m = GEN.search(os.path.basename(path or ""))
    if not m:
        raise Corrupt("%s: cannot read a generation out of %s=%r" % (where, field, path))
    return "tf:%d" % int(m.group(1))


def condition_from_filename(name, adapters):
    """Reproduce the snapshot builder's mapping: filename prefix -> conditionId."""
    base = os.path.basename(name).split("_g")[0]
    key = ("old" if "_" in base else "new") + ":" + base
    return adapters.get(key)


def classify(row):
    """The snapshot builder's own exclusion predicate, kept verbatim in meaning.

    Returns (evidenceStatus, exclusionReason).
    """
    outcome = row.get("outcome")
    legality = row.get("legalityErrors")
    if row.get("reason") == "no-legal-move":
        return "excluded", "no-legal-move"
    if legality != []:
        return "excluded", "legality-error"
    if outcome not in ("ours", "opp", "draw"):
        return "excluded", "invalid-outcome"
    return "accepted", ""


def rows_for(archive, known_conditions, adapters):
    src = os.path.join(SOURCES, archive)
    if not os.path.isdir(src):
        raise Corrupt("archive missing: %s" % src)
    is_policy = archive in POLICY_ARCHIVES
    rows = []
    seen = {}

    for name in sorted(os.listdir(src)):
        if not name.endswith(".jsonl"):
            continue
        with open(os.path.join(src, name), encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                where = "%s/%s:%d" % (archive, name, lineno)

                try:
                    row = json.loads(line)
                except ValueError as exc:
                    raise Corrupt("%s: malformed JSON (%s)" % (where, exc))
                if not isinstance(row, dict):
                    raise Corrupt("%s: row is %s, expected an object" % (where, type(row).__name__))

                missing = [f for f in REQUIRED if f not in row]
                if missing:
                    raise Corrupt("%s: missing required field(s) %s" % (where, ", ".join(missing)))
                if not isinstance(row["candidateIsP1"], bool):
                    raise Corrupt(
                        "%s: candidateIsP1 is %r, expected a boolean"
                        % (where, row["candidateIsP1"])
                    )
                if not isinstance(row["legalityErrors"], list):
                    raise Corrupt(
                        "%s: legalityErrors is %r, expected a list" % (where, row["legalityErrors"])
                    )
                if row["exp"] != archive:
                    raise Corrupt(
                        "%s: row claims exp=%r but sits under %r" % (where, row["exp"], archive)
                    )

                setup_token = SETUP_TOKEN.get(row["setup"])
                if setup_token is None:
                    raise Corrupt("%s: unknown setup %r" % (where, row["setup"]))
                condition_id = "%s-%s-%s" % (row["variant"], setup_token, row["board"])
                if condition_id not in known_conditions:
                    raise Corrupt(
                        "%s: %r is not a condition in policy_elo_conditions.json"
                        % (where, condition_id)
                    )

                # For the policy archives the snapshot builder derives the condition
                # from the FILENAME. If that disagrees with the row's own fields, the
                # rebuilt aggregate would be filed under the wrong condition.
                if is_policy:
                    from_name = condition_from_filename(name, adapters)
                    if from_name is None:
                        raise Corrupt("%s: filename maps to no condition adapter" % where)
                    if from_name != condition_id:
                        raise Corrupt(
                            "%s: filename says condition %r, row fields say %r"
                            % (where, from_name, condition_id)
                        )

                p1 = player(row["whiteModel"], where, "whiteModel")
                p2 = player(row["blackModel"], where, "blackModel")
                candidate = player(row["candidateModel"], where, "candidateModel")
                baseline = player(row["baselineModel"], where, "baselineModel")

                seat_candidate = p1 if row["candidateIsP1"] else p2
                seat_baseline = p2 if row["candidateIsP1"] else p1
                if seat_candidate != candidate or seat_baseline != baseline:
                    raise Corrupt(
                        "%s: candidateIsP1=%r puts candidate/baseline at %s/%s, but the "
                        "model fields say %s/%s"
                        % (where, row["candidateIsP1"], seat_candidate, seat_baseline,
                           candidate, baseline)
                    )

                status, reason = classify(row)

                if status == "accepted":
                    winner = WINNER_OF_RESULT.get(row["result"])
                    if winner is None:
                        raise Corrupt("%s: unknown result %r" % (where, row["result"]))
                    # result, outcome and the seat record must tell one story.
                    if winner == "draw":
                        derived_outcome = "draw"
                    else:
                        winner_is_p1 = winner == "p1"
                        derived_outcome = "ours" if winner_is_p1 == row["candidateIsP1"] else "opp"
                    if derived_outcome != row["outcome"]:
                        raise Corrupt(
                            "%s: result=%r with candidateIsP1=%r implies outcome=%r, but the "
                            "row records outcome=%r"
                            % (where, row["result"], row["candidateIsP1"], derived_outcome,
                               row["outcome"])
                        )
                else:
                    winner = ""

                identity = (
                    archive, name, condition_id, p1, p2, row["candidateIsP1"],
                    row["engineSeed"], row["randomStartSeed"], row["game"],
                )
                if identity in seen:
                    raise Corrupt(
                        "%s: duplicate row identity, first seen at line %d. Two rows with one "
                        "identity double-count a game even when they are byte-identical."
                        % (where, seen[identity])
                    )
                seen[identity] = lineno

                rows.append(
                    {
                        "exp": archive,
                        "sourceFile": name,
                        "conditionId": condition_id,
                        "variant": row["variant"],
                        "setup": row["setup"],
                        "board": row["board"],
                        "p1": p1,
                        "p2": p2,
                        "candidateIsP1": "true" if row["candidateIsP1"] else "false",
                        "winner": winner,
                        "evidenceStatus": status,
                        "exclusionReason": reason,
                        "engineSeed": row["engineSeed"],
                        "randomStartSeed": row["randomStartSeed"],
                        "game": row["game"],
                    }
                )

        # The builder keys edges off the filename pair. Confirm the rows agree with it,
        # so that deriving the edge endpoints from p1/p2 stays sound.
        pair = PAIR.search(name)
        if is_policy and pair:
            a = int(pair.group(1))
            for r in rows:
                if r["sourceFile"] != name:
                    continue
                cand = r["p1"] if r["candidateIsP1"] == "true" else r["p2"]
                if cand != "tf:%d" % a:
                    raise Corrupt(
                        "%s/%s: filename names candidate g%d, row names %s"
                        % (archive, name, a, cand)
                    )
    return rows


def main():
    known_conditions, adapters = condition_ids()
    os.makedirs(RESULTS, exist_ok=True)
    total = accepted = excluded = 0

    for archive in ARCHIVES:
        rows = rows_for(archive, known_conditions, adapters)
        if not rows:
            raise Corrupt("%s: no rows - refusing to write an empty table" % archive)
        out = os.path.join(RESULTS, archive + ".csv")
        with open(out, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=COLUMNS, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)
        n_exc = sum(1 for r in rows if r["evidenceStatus"] == "excluded")
        total += len(rows)
        excluded += n_exc
        accepted += len(rows) - n_exc
        print("%-56s %6d rows  %5d accepted  %2d excluded" % (
            archive[:56], len(rows), len(rows) - n_exc, n_exc))

    print("\nschema %s" % SCHEMA)
    print("wrote %d rows (%d accepted, %d excluded) across %d tables to %s"
          % (total, accepted, excluded, len(ARCHIVES), RESULTS))


if __name__ == "__main__":
    sys.exit(main())
