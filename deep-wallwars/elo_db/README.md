# Elo game database

One place for every game ever played to measure model strength, so that each
new measurement builds on the previous ones instead of starting from scratch.

Before this folder existed the games lived in four disconnected piles whose
settings were recorded nowhere except in the scripts that happened to produce
them. A PGN line was the entire record:

```
[White "model_36.trt"][Black "model_24.trt"][Result "1-0"] 1. c4 Nf6
```

No sample count, no board size, no date. The variant was encoded only in which
directory the file sat in. That is fine for one experiment and impossible to
extend to a second architecture.

## Layout

```
elo_db/
  README.md          this file
  experiments.json   one entry per experiment: settings, date, script, notes
  games.jsonl        one row per game, for the experiments build.py can read
  ratings_*.json     output of scripts/fit_elo.py
  results/           one results table per archive-only experiment (tracked)
  sources/           verbatim copies of the raw inputs, never edited
  policy_archive/    the canonical archive of the g117-g126 policy run
  provenance/        copies of the scripts and logs that produced the sources
  scripts/           build.py, fit_elo.py, build_results_tables.py
```

## Two ingestion paths

There are now two kinds of experiment in here, and they reach a rating differently.

**Legacy PGN experiments.** Their entry lists glob patterns in `sources`, and
`scripts/build.py` parses those files into `games.jsonl`, which `fit_elo.py` then
reads. For these, `games.jsonl` is the single row-per-game record.

**Archive-only JSONL experiments.** These were produced by
`benchmark_head_to_head.ts` and the policy Elo runners, in a JSONL format `build.py`
does not parse. Their entry carries `"sources": []` - honestly, because `build.py`
should parse nothing for them - and a `results` pointer to a tracked table under
`results/`. The policy snapshot builder,
`../scripts/build_policy_elo_app_data.py`, reads those tables.

So `games.jsonl` is **not** a record of every game in this database. It is the
derived record for the first kind only. The `results/` tables are the tracked record
for the second kind. Ask which kind an experiment is before quoting a total.

## The data model

Settings belong to an **experiment**, not to a game and not to a player. Within
any single matchup both sides always used the same settings; what varies is the
settings *between* experiments. So each game row names its experiment, and
`experiments.json` holds the sample count, board size, engine flags and script.

A game row:

```json
{"exp":"tf_pergen_2026-07-17","variant":"classic","board":"8x8",
 "white":{"arch":"tf","gen":36},"black":{"arch":"tf","gen":24},
 "result":"1-0","source":"ext_classic/pair_24_36.pgn"}
```

Player identity in the fit is `arch:generation@samples`. Sample count is part of
the identity because search depth is strength: the same weights at 400 and at
800 samples are two different opponents, and averaging them produces a number
that describes neither.

## Provenance of what is currently in here

> **The 13 rescued phase 7 experiments were registered on 2026-08-22.** Twelve of
> them are in `experiments.json` with their settings, their measured structure and
> a tracked results table under `results/`. The thirteenth,
> `tf_policy_elo_616bc2f2_delta1_2026-08-20`, held zero files and was removed; it
> is named in `provenance/phase7-2026-08/README.md` so its absence stays
> explainable.
>
> Their raw games are NOT in this repository. Nil ruled on 2026-08-22 that tracked
> evidence is a results table - the experiment reference, the two players, the
> winner, and the condition and start fields - and not the raw games. The raw
> JSONL stays on the 4090 desktop (`~/nil/wallgame` on desktop-053vvpl-1), ignored
> by `.gitignore`, with each archive's box, path, size, file count, parsed rows and
> content hash recorded under `localRawArchive` in `experiments.json`.
>
> The table below describes only the legacy PGN experiments.

| Experiment | Games | Settings known? |
|---|---|---|
| `tf_full_2026-07-16` | 3,120 | **No.** Sample count unrecoverable, see below |
| `tf_pergen_2026-07-17` | 14,680 | Yes, verified |
| `tf_vs_sitebot_2026-07` | aggregates | Yes, recorded in the source file |

`tf_pergen_2026-07-17` settings are trustworthy: the runner was diffed against
its own `.orig` backup and the only differences are file paths and which python
interpreter runs the plot. The match settings never moved.

`tf_full_2026-07-16` predates that runner. There is no script, no log, and no
shell-history entry for it, and the PGN itself records nothing. Its sample count
is stored as `null` rather than assumed, because assuming 400 would silently
turn a guess into data.

## Known problems

1. **RESOLVED 2026-08-01: the July 16 games were pooled without anyone
   recording whether that was valid.** The old `plot_elo_full.py` keyed players
   by `.trt` filename alone, so `model_10.trt` from July 16 and `model_10.trt`
   from the later ladder became one player no matter what settings each was
   measured under. That merge turns out to have been legitimate - `elo_run.sh`
   on auntie used `-samples 400` on the same 8x8 board and 12x10 frame - but
   nothing in the artifacts said so, and nothing would have complained if it had
   not been. Recording the settings is what makes it checkable: when samples
   were marked `null`, the two groups showed up as disconnected components; once
   set to 400, they merged into a single 74-player pool automatically.

   Still not proven: that the `.trt` engines built 2026-07-14 hold the same
   weights as later generations of the same number. TensorRT engines are not
   reproducible across builds, so no hash comparison exists. The support for it
   is that the curriculum is one continuous run with consistent numbering.

2. **The old plot pinned the reference bot to a fixed Elo** (926 classic, 336
   standard) to make the axis look absolute. Those numbers no longer mean
   anything, and `fit_elo.py` does not reproduce that. It normalises the weakest
   player to 0 and says so in the output.

3. **The ResNet arm has no games yet.** Until cross-architecture matches are
   played, the two arms form disconnected components of the game graph and their
   ratings are not comparable at any price. `fit_elo.py` detects this and refuses
   to pretend otherwise.

## Adding a new experiment

1. Drop the raw output under `sources/<something>/`.
2. Add an entry to `experiments.json` with the settings and the script that
   produced it. If a setting is genuinely unknown, write `null`, not a guess.
3. Copy the script itself into `provenance/`.
4. For a PGN experiment, list its glob patterns in `sources` and run
   `python3 scripts/build.py` to rebuild `games.jsonl`.
5. For a JSONL experiment `build.py` cannot parse, write `"sources": []`, add the
   archive to `scripts/build_results_tables.py`, run it to produce
   `results/<experiment>.csv`, and record that table under `results` in the entry
   with its row count, byte count and sha256.

Every entry needs a `sources` key, even an empty one. `build.py` requires it, and
that is deliberate: a missing key is then a real error about a real experiment
rather than something a default quietly swallows.

Never hand-edit `games.jsonl` or anything in `results/`. Both are derived, and
their generators rewrite them whole.

`scripts/verify_policy_elo_tables.py` checks the tracked tables against the
fingerprints in `experiments.json` and against the shipped policy snapshot, from a
plain checkout. Pass `--raw-sources` on the box that holds the raw archives to add a
per-edge win/loss/draw comparison, which the shipped snapshot cannot support because
it stores no per-edge counts.

## Naming across architectures

Legacy files are bare `model_N.trt`, with the architecture implied by the
experiment. Both arms use that same name, so future runs should copy engines in
as `tf_model_N.trt` and `rn_model_N.trt`. `build.py` understands both forms:
prefixed names win, and bare ones fall back to the experiment's `arch`.

## Reading a result

```
python3 scripts/build.py
python3 scripts/fit_elo.py --variant classic
python3 scripts/fit_elo.py --variant standard --exp tf_pergen_2026-07-17
```
