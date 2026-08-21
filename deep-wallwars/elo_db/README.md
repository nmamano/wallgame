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
  games.jsonl        one row per game - the single source of truth
  ratings_*.json     output of scripts/fit_elo.py
  sources/           verbatim copies of the raw inputs, never edited
  provenance/        copies of the scripts and logs that produced the sources
  scripts/           build.py, fit_elo.py
```

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

> **13 experiments are rescued but NOT in this database yet (2026-08-21).**
> Their games sit in the `deep-wallwars/elo_db/sources/` directory of the MAIN
> working tree ON THE 4090 (`~/nil/wallgame` on desktop-053vvpl-1), copied off
> the second tree that is being collapsed. They are untracked there and are NOT
> in this checkout, NOT in `experiments.json`, and therefore NOT in
> `games.jsonl` - so no fit reads them today. Their settings, and which two of
> them have no surviving runner, are recorded in
> `provenance/phase7-2026-08/README.md`. The table below describes only what is
> committed here.

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
4. Run `python3 scripts/build.py` to rebuild `games.jsonl`.

Never hand-edit `games.jsonl`. It is derived, and `build.py` rewrites it whole.

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
