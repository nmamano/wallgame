# Phase 7 experiment records, August 2026

Recorded 2026-08-21 by Wall Game Worker 2.

## Why these files are here

These scripts ran on the 4090 desktop inside a SECOND working tree,
`~/nil/wallgame-phase7-feasibility` on desktop-053vvpl-1, which is being
collapsed into `~/nil/wallgame`. They produced 13 directories of games that
now live in `sources/`. When that tree goes, these scripts go with it, and the
settings behind those 13 experiments become unrecoverable.

That is not a hypothetical. The table in `../../README.md` records
`tf_full_2026-07-16` as permanently unrecoverable for exactly this reason:
"There is no script, no log, and no shell-history entry for it."

## These are records, not tools

None of the six `launch_*.sh` files was merged into `deep-wallwars/scripts/`.
Each hardcodes a run directory (`build-tests/phase7-feasibility-34e5f567`), an
experiment name with a DATE baked into it, and specific model generations, and
each refuses to write over an existing archive. Re-running one tomorrow would
either file today's games under an August date or stop. A tool takes those as
arguments; these state one experiment each. Read them, do not run them.

The reusable capability they exercised - `--archive`, `--experiment` and
`--setup random-start` - WAS merged, into
`deep-wallwars/scripts/benchmark_head_to_head.ts`.

## Where the settings for each of the 13 experiments stand

Settings are NOT yet written into `experiments.json`. That is deliberate: a
wrong manifest entry is worse than a missing one, because the Elo fit filters
on exact experiment name and then trusts the manifest for the settings. This is
where each one's evidence is, for whoever writes those entries.

**How this table was built, because the first version of it was wrong.** A row
says a file DEFINES an experiment only when that file assigns the name to a
variable (`something=<name>`). A file that merely CONTAINS the name - in a
`sha256sum` line, a comment, an output path - is not its author. Attributing by
eye conflates the two and put one experiment against the wrong runner. Re-derive
by assignment, not by grep hit, if you extend this table.

| Experiment (in `sources/`) | Defined by |
|---|---|
| `tf_model116_vs115_animal_1000_2026-08-20` | `launch_model116_resumed_evaluation.sh` (`animal_exp`) |
| `tf_model116_vs93_standard_1000_2026-08-20c` | `launch_model116_resumed_evaluation.sh` (`standard_exp`) |
| `tf_model116_vs93_1000_2026-08-19b` | `launch_model116_variant_evaluation.sh` |
| `tf_phase7_policy_standard_2026-08-20` | `launch_phase7_policy_curves_standard.sh` AND `../../../scripts/policy_elo_conditions.json` |
| `tf_phase7_policy_classic_2026-08-20` | `../../../scripts/policy_elo_conditions.json` AND the ops-private runner below |
| `tf_policy_elo_616bc2f2_phase7_boundary_2026-08-20` | `../../../scripts/policy_elo_conditions.json` |
| `tf_policy_elo_616bc2f2_phase7_d3d6_2026-08-20` | same |
| `tf_policy_elo_616bc2f2_phase7_d3d6_shortage1_2026-08-20` | same |
| `tf_policy_elo_616bc2f2_phase7_delta1_2026-08-20` | same |
| `tf_policy_elo_616bc2f2_phase7_random_40to64_2026-08-20` | same |
| `tf_policy_elo_616bc2f2_phase7_random_to40_2026-08-20` | same |
| `tf_model116_vs93_1000_2026-08-19a` | **NOTHING DEFINES IT** |
| `tf_policy_elo_616bc2f2_delta1_2026-08-20` | **NOTHING DEFINES IT** - and the directory is empty |

So 11 of the 13 have a settings source, and 8 of those are in
`deep-wallwars/scripts/policy_elo_conditions.json`, which was on main the whole
time. Only the GAMES were in the other tree. Exactly one non-empty experiment,
`tf_model116_vs93_1000_2026-08-19a`, has no settings source at all.

Three of the six runners here define none of the 13:
`launch_phase7_evaluation.sh`, `launch_phase7_feasibility.sh` and
`launch_phase7_from_model94.sh` drove the feasibility and training runs, not
these Elo experiments. Do not hunt for their experiment names in `sources/`.

### The Classic runner is real, and it is not in this directory

`launch-phase7-policy-curves-classic.sh` was written into `ops-private/`, not
into `deep-wallwars/scripts/`, which is why a scan of the scripts directory
missed it. ops-private is gitignored and stays that way, so the file is NOT
committed here. It was copied out of the phase7 tree into
`ops-private/phase7-runners-2026-08/` in the MAIN tree ON THE 4090
(`~/nil/wallgame` on desktop-053vvpl-1) so it survives the collapse. If you are
writing that experiment's manifest entry, read it there - and cross-check it
against `policy_elo_conditions.json`, which declares the same experiment. Two
independent sources agreeing is worth more than either alone; if they disagree,
that disagreement is the finding.

The lesson generalises: a runner may be in `ops-private` rather than in
`scripts/`, so "not in scripts/" is not "does not exist".

### The one with nothing found

Do not read "nothing found" as "no script existed". `..._2026-08-19a` and
`..._2026-08-19b` differ only by the trailing letter, and only the `b` form
appears in `launch_model116_variant_evaluation.sh` - which looks like one script
edited in place and run twice, leaving only the later version.

One fact does survive, and it is about ORDER, not settings. The `b` run's own
metrics snapshot,
`evaluation-model116-vs93-1000/metrics/source-status.txt` in the run directory,
is a `git status` capture that already lists
`?? elo_db/sources/tf_model116_vs93_1000_2026-08-19a/`. So `a` existed before
`b` ran. That is consistent with one script edited between two runs, and it is
the whole of the evidence.

It is NOT the settings. Write `null` rather than the sibling's value unless a
log confirms it: an inherited setting that is wrong is indistinguishable from a
measured one once it is in the manifest, and the fit trusts the manifest.

### The empty one

`tf_policy_elo_616bc2f2_delta1_2026-08-20` holds zero files. Git cannot track an
empty directory, so it will NOT survive a commit of `sources/`, and its absence
will look like it was never rescued. It is named here so that absence stays
explainable. It is also the only member of the `616bc2f2` family missing from
`policy_elo_conditions.json`, which is consistent with a run that produced
nothing.

## The three JSON files

- `phase7-evaluation-manifest.json` - the frozen evaluation settings
  (`baselineGeneration`, `candidateGenerations`, `engineSeed`,
  `randomStartSeedFormula`).
- `phase7-corrected-manifest.json` - the corrected-ownership rebuild, recording
  which commit and which tree the rules and the experiment support came from.
- `phase7-classic-10x9-acceptance.json` - TRAINING provenance, not Elo, and the
  mechanism that read it was NOT merged into main. It is kept because it records
  a decision Nil made on 2026-08-15, and it would otherwise be lost with the
  tree. Two warnings if anyone acts on it:
  1. The record's headline is a 10.354% seat gap against a 10.0% maximum. But it
     also records `redPositions: 0` for a 100-game bucket, and `audit_labels.py`
     scores a seat with no positions as a clean 0.0%. So that "gap" is one
     seat's rate against a seat the auditor never sampled, which is a different
     condition from the one the record's wording describes. Open question.
  2. Its `hashManifest`, `metrics/pre-correction-data.sha256`, covers 6000 files
     across 15 generation directories, NOT only the one bucket the record
     accepts (200 files). It is a whole-corpus manifest, so it cannot by itself
     establish that the accepted bucket specifically is unchanged.
