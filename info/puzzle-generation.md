# Automatic Puzzle Generation

Living design doc for automatically generating Wall Game puzzles from engine games,
using the Deep-WallWars engine as the oracle. Companion to the blog draft
`nilmamano.com/blog/puzzle-gen.mdx` (which is the public-facing narrative; this file
is the engineering source of truth).

Status: **RESUMED 2026-07-25** (Nil). Parked 2026-07-24 for an unrelated bug-fix
session; picked back up. The pipeline is built and validated; the first detection run
is the next step and has not been executed yet. See "Parked state" at the bottom for
the exact resume command. Last updated 2026-07-25.

## Goal

A puzzle is a prepared position where the player must find the best move (or move
sequence), which should be hard to find and decisively better than the alternatives.
We want to generate these automatically instead of hand-authoring them.

## Why now: the oracle is the gate

Puzzle generation is fundamentally a **distillation** problem: we compress the engine's
expensive deep search into a cheap stored artifact that a human then re-derives. The
quality ceiling of the puzzle is set entirely by the teacher engine.

Everything in the pipeline depends on trusting the engine's evaluations:
- **Eval-jump detection** (a leap from ~0 to ~0.8 signals a found tactic) is only
  meaningful if the eval is stable; a weak engine's "jump" is just search noise.
- **Solution density** (how many actions are within delta of best) needs Q-values sharp
  enough to separate great from merely good.
- **Threshold validation** at solve time needs evals stable enough that a cushion band
  cleanly separates solved from failed.

All three need a sharp, low-variance evaluator. The transformer model (model_73+) is that
evaluator, and it is **strongest on 8x8**, which is also where games are shortest and long
searches are cheapest. **8x8 (classic + standard) is the beachhead.**

## Architecture (5 stages)

```
1. Candidate source   engine self-play games (unlimited) + later real human games
2. Deep analysis      long MCTS (100k-1M visits) -> eval trajectory + per-action Q
3. Filtering          eval jump + solution density + difficulty + forcing lines
4. Storage            puzzle record (position, principal line, per-step thresholds)
5. Solve validation   LIVE short MCTS per step, threshold bands (engine online)
```

### Stage-by-stage: what exists vs. what to build

| Stage | Status | Notes |
|---|---|---|
| 1. Candidate source | exists | `frontend/src/lib/engine-game-import.ts` parses engine self-play and replays to every position; DB `game_details.moves` holds human games. |
| 2. Deep analysis | small gap | `MCTS::sample(N)`, `root_value()`, `root_info().edges[]` (per-action Q + visits), two-action turns all exist in `deep-wallwars/src/mcts.*`. Missing: eval-vs-visits **trajectory** capture and a **batch-analyze CLI**. |
| 3. Filtering | build | Pure analysis over stage-2 output. No engine changes. |
| 4. Storage | half exists | `Puzzle` domain type (`shared/domain/puzzles.ts`) is already rich (board, pawns, walls, `moves[][]`). DB `puzzles` table is metadata-only (id/title/author/rating) and the 10 live puzzles are hardcoded. Needs schema migration + writer. |
| 5. Solve validation | build | Live engine, see below. |

## Key decisions

### D1. Multi-move puzzles require a live engine at solve time
Chess puzzles are multi-move, and the interesting Wall Game tactics (chimneys/chutes,
chase-and-close) are inherently multi-turn. You **cannot** precompute and store the whole
solution tree: the opponent's replies branch, and the user's own off-book-but-still-winning
moves lead to positions never enumerated. So solving must run a **live short MCTS per step**
and validate against a threshold band.

What survives from the "precompute" idea (narrowed): the **per-step threshold band** is what
absorbs the equivalence classes (accepts "any of these 7 tunnel walls" without enumerating
them), and it works at *every* step. We may cache **turn 1's** acceptance set (it is just
`root_info()` from generation) for instant feedback on the most-played first move; everything
deeper falls back to live search.

Solver shape:
- Store: initial position, side to move, solution length, a **principal line** (intended
  user turns + intended opponent replies), per-step success/fail thresholds.
- User plays a turn -> short MCTS on the resulting position -> accept if eval >= step
  success threshold, reject if <= fail threshold.
- Opponent reply: use the stored line if the user stayed on-book; if the user deviated to a
  different winning move, run a short live search for the reply.
- Repeat to the win threshold.

### D2. Prefer forcing lines at generation time
Filter candidates toward positions where the opponent's replies along the line are
**forcing** (a single clearly-best reply; low density for the opponent too). Forcing lines
keep the solve-time tree narrow and make cleaner, well-defined puzzles. This is why most
Lichess puzzles are forcing sequences. Ties puzzle quality and tractability together.

### D3. Puzzle solving is a SEPARATE feature from replay viewing
Do **not** mix the two. (The old dev-only `frontend/src/routes/replay-viewer.tsx` was
DELETED 2026-07-25: it was never committed, its route was missing from the generated
route tree so it broke `tsc`, and its parsing logic - the valuable part - lives on in
the committed `frontend/src/lib/engine-game-import.ts`.) Puzzle solving builds on the
existing puzzle UI (`use-puzzle-game.ts`,
`puzzles.$id.tsx`), extended with a live-engine validation mode. The internal
candidate-review/curation tool (try a candidate, reveal the engine's line, thumbs up/down)
belongs with the puzzle-solving feature and reuses its components, not the replay viewer.

### D4. Bootstrap candidates from engine self-play, not human games
wallgame.io is new; high-quality human games are scarce. Engine self-play from the current
strongest model is an unlimited supply of tactically rich positions and doubles as its own
analyzer. Add human-game scanning later for the "human missed the tactic" signal (which is a
good obviousness proxy but not required to start).

### D5. Use the current strongest model for the spike, not stale samples
The checked-in `frontend/public/replays/gen40_*_8x8.json` files are only leftover demo input
for the replay viewer; gen40 is not our strongest. Generate **fresh self-play from
model_73/77** (current strongest) as both the game source and the analyzer, since puzzle
quality tracks oracle quality on both ends.

### D6. Solve-time engine hosting: GPU-bound (ANSWERED 2026-07-24)
Puzzle solving is a hard dependency on a live engine. **Nil: CPU engines are not strong
enough**, so the puzzle solve-endpoint is GPU-bound - it must run on the 4090 desktop, not
the GPU-less Helsinki box. Every puzzle attempt routes to the desktop engine. (This also
means puzzles cannot be validated/played while the desktop GPU is unavailable.)

## Difficulty metric

> **SUPERSEDED by Phase 0b** (see the difficulty-metric caveat below). The N_jump idea
> below does NOT work for a superhuman oracle - decisive tactics settle in <200 visits, so
> there is no jump to time. Kept here for context; the revised plan measures difficulty
> human/policy-relatively, not by engine search time.

Original idea: `difficulty = N_jump / N_max`, where `N_jump` is the visit count at which the
eval jumps to winning during the deep search. Longer to find = less obvious = harder.
Mapping onto the existing 1350-1850 puzzle ELO scale is a calibration problem deferred to
real player solve-data (the blog's teased follow-up).

## Phasing (tracer bullets, de-risk first)

- **Phase 0a (no GPU):** batch-analyze CLI + eval-trajectory logging in `deep-wallwars`.
  Writable while p6 training runs. Emits per position: eval trajectory, per-action Q +
  visits, solution density.
- **Phase 0b (short GPU burst):** generate fresh model_73/77 self-play on 8x8, run the
  analyzer, answer two empirical questions at once: (a) do eval-jumps find real tactics?
  (b) is a short 8x8 search CPU-fast-enough to serve puzzles (D6)?
- **Phase 1:** puzzle-solve mode + live short-search endpoint, so candidates are playable
  (built on the puzzle UI, not the replay viewer). Curation layer on top.
- **Phase 2+:** candidate extraction at scale, filtering (incl. forcing-line filter),
  storage (DB migration + writer), rating/feedback loop.

## Phase 0b results (first spike, 2026-07-24)

Setup: `deep_ww --analyze`, model_78 (strongest), 8x8 embedded in the 12x10 frame,
30k visits/position, ~40 positions/variant, classic + standard, strong-vs-strong
self-play. 79 positions total. Analyzed with `scripts/analyze_puzzle_spike.py`.

**Metrics validated:**
- **Solution density works.** It cleanly separates *sharp* positions (density 0.01-0.05,
  one clearly-best move among 60-116 legal actions) from *loose* won-endgames
  (density 0.86-1.00, e.g. classic moves 26-38 where |Q|~0.9 and dozens of moves all
  preserve the win). The loose positions are correctly non-puzzles.
- **Eval trajectory + N_jump captured.** Difficulty = N_jump/N_max ranged 0.07-0.53.

**Key finding: strong-vs-strong self-play rarely produces winning-shot jumps.**
Swing avg 0.094, max 0.362. Zero positions cleared the candidate bar
(swing>=0.30 AND |final|>=0.50 AND density<=0.12). Positions were either
already-decided from the opening (|Q|~0.7, monotonic conversion, no jump) or genuinely
balanced. The largest swings (standard moves 22-27) are the *trailing* side finding
defensive resources and equalizing toward 0 - not a decisive tactic. This confirms D4's
caveat with data: **the oracle is validated; the position SOURCE is the lever.** A
"looks equal -> hidden win" puzzle needs a position where a mistake is available, which
two near-perfect players almost never create.

Nuance: mild sharpenings do appear even in strong play (e.g. classic move 23:
0.71->0.84 over 12k visits, density 0.02 - a real unique-best-move tactic, just below
the swing threshold), so thresholds will need tuning per position-source.

**Next (Phase 1): decouple position-source from oracle.** Always analyze with the strong
deep search, but draw positions from imperfect play. Two concrete paths:
1. Extend `--analyze` to read an EXTERNAL game file (connects to engine-game-import) so
   we can scan real human games or weaker-engine games - the Lichess approach.
2. Manufacture tactical positions by playing one side with a shallow search / weaker
   model, while the analysis oracle stays strong. The blunders create the "hidden win"
   moments the detector is built to catch.

## Phase 0b tactical results (weak-player source, 2026-07-24)

Acted on the position-source lesson. Extended `--analyze`: an optional weaker `--model2`
plays the game while `--model1` stays the strong deep oracle (`--analyze_play_samples`
for the play budget; `--analyze_asymmetric` to play Red=strong / Blue=weak). Broadened
the candidate filter to `swing>=0.30 AND density<=0.12 AND N_jump>=6000` - covering both
winning-shots and defensive saves (the final eval sets the *theme*, not whether it's a
puzzle).

Ran weak player model_34 (both sides) + oracle model_78, 8x8, classic + standard.

| Position source | Candidates / positions | Max swing |
|---|---|---|
| Weak player (model_34) + strong oracle | **14 / 80 (17.5%)** | 0.580 |
| Strong self-play (model_78 both) | 3 / 79 (3.8%) | 0.362 |

**The detector works.** Weak play surfaced ~4.6x more puzzle-worthy positions - real
non-obvious tactics (e.g. classic mv6: swing 0.58, N_jump 22k, density 0.01 - a unique
save that takes deep search to find). Position-source is confirmed as the lever.

**But all 14 are save/sharpen, zero winning-shots** - structurally, because model_34
plays *both* sides: when one side blunders, the other (equally weak) can't convert, so
the eval equalizes toward 0 rather than spiking to a win. All candidates were classic;
the standard weak game went one-sidedly decisive early (obvious, low-swing). To generate
*winning-shot* puzzles, play asymmetrically (strong punishes weak) - hence
`--analyze_asymmetric`, being probed next.

## Phase 0b asymmetric results + the difficulty-metric caveat (2026-07-24)

Ran `--analyze_asymmetric` (Red = strong model_78, Blue = weak model_34) to hunt
winning-shots. Result: **2 / 72 candidates, still 0 winning-shots** - FEWER than symmetric
weak play (14/80).

Why: strong-vs-weak makes games one-sided (Red winning from the start, eval high and
stable, no jumps - like strong self-play). Blunders don't create hidden-win moments
because Red was always winning.

**The key caveat this exposed:** the decisive positions that DO exist show ~zero swing at
2000-visit granularity (early_q approximately equals final_q). model_78 finds the crushing
move almost immediately - its policy prior already points at it - so N_jump is tiny.
**Eval-jump / N_jump measures difficulty-FOR-THE-ENGINE. A superhuman engine finds
human-hard tactics instantly, so there is no jump.** N_jump is the wrong difficulty signal
for *human* puzzles. **Confirmed** by a fine-grained trajectory run (chunk=200): every
decisive position (|final_q|>0.6) already reads within ~0.05 of its final eval at just
**200 visits** (e.g. move 12: +0.82 at 200 visits vs +0.824 final; move 8: +0.77 vs
+0.775). The oracle sees the outcome almost immediately - there is no 0->decisive jump to
measure.

**Revised methodology:**
- Use the engine as an **oracle** for what is TRUE - is the best move decisively winning?
  is it unique? These are the eval + solution-density signals, which are robust and
  validated. Density is the workhorse.
- Measure **difficulty human/policy-relatively**, not by engine search time. Options:
  the policy-prior of the best move (low prior = even the NN nearly overlooked it), the
  gap between the raw NN value/policy and the deep-search result, or the blog's own better
  heuristic - "the human in the source game didn't find it" (needs real games).
- **Best position source (revised):** games between two players of SIMILAR, imperfect
  strength (real human games, or two equal mid-gen engines) - balanced enough to look
  quiet, imperfect enough that hidden tactics exist and get missed. This is exactly the
  Lichess model, and it is where Phase 1 should point.

## Phase 1: real human games ingested (wallwars.net export, 2026-07-24)

Acted on the revised methodology's "best position source": real games between
similar-strength imperfect humans. wallwars.net (the predecessor site, fly app
`wallwars-backend`, MongoDB Atlas) is that source.

**Export.** The `games` collection has **422 games** (all classic - wallwars has
no mouse variant). Each doc stores `boardSettings.dims` (a DOUBLED internal grid:
cells at even/even, walls at even/odd or odd/even), `startPos`/`goalPos` (grid
coords), `creatorStarts`, `playerNames`, `ratings` (~1300-1560 Elo), `winner`,
`finishReason`, `finalDists`, and `moveHistory[].actions` (1-2 numeric `[gr,gc]`
per turn). Helsinki is not Atlas-allowlisted, so the export runs INSIDE the fly
machine and is pulled out via `fly ssh sftp get` (the PTY drops bytes on large
streaming stdout - write to a file, sftp it). Raw + converted JSONL live at
`~/nil/wallwars_games/{games_raw,games_converted}.jsonl`.

**Conversion** (`deep-wallwars/scripts/convert_wallwars_games.ts`): numeric grid
coord -> wallgame `Action` (even/even = cat destination; even/odd = vertical wall
right of cell; odd/even = horizontal wall below cell -> wallgame `[r+1,c]`), then
serialized to engine standard notation and replayed through `importEngineGame`.
Two generalizations were needed in `engine-game-import.ts`: an optional
`firstPlayer` param (wallwars games can start with either side per `creatorStarts`;
engine self-play is always Red-first), which sets `GameState.turn`. A 2-cell cat
move stored as just its destination maps to ONE `{type:'cat'}` action -
`game-state.ts` accepts the double-step and finds the mid-square itself.

**Result: 394 of 422 games are true wallgame-classic geometry** (cats top corners,
homes at opposite bottom corners) and ALL 394 replay cleanly AND match the DB's
independently-recorded `finalDists` exactly (0 mismatches) - a strong correctness
check on the format reverse-engineering. The other 28 are wallwars custom setups
(20 race-to-center with a shared central goal, plus custom cat starts) that fixed
wallgame.io classic can't express; the converter gates them out via
`classicGeometry`. Sizes of the 394: 10x12=135, 8x10=93, 5x6=31, 6x8=25, 8x8=19,
6x6=14, 7x7=12, 5x5=10, tail of smaller boards. ~thousands of start-of-turn
positions across them. No rated/public filter (matchmaking flags, not quality).

**Next:** extend `deep_ww --analyze` to INGEST an external game file (the converted
notation + real board size) instead of self-playing, analyze each start-of-turn
position with the strong oracle (model_78+) -> density + best-move policy-prior,
then filter. Build/run on the 4090 desktop.

## Phase 1 first detection run (8x8 human games, 2026-07-25)

Ran the external-game ingest over the 8x8 bucket: 19 wallwars.net human games,
570 start-of-turn positions, oracle model_83, 10k visits/position. 95.7 min wall
clock = **~6 positions/min** on the 4090. Zero parse/replay errors.

**Duplicates are real and worth avoiding: 61 of 570 positions (10.7%) were repeats**
of a position already analyzed. These players reused openings, so the same board
recurs across games (one position appeared identically in 3 games). That is 10.7% of
GPU time spent producing duplicate records - and duplicates would have become
duplicate puzzles. Now deduped inside the engine BEFORE the search (see the
`--analyze_game_file` dedup), so the saving is compute, not just output rows.

**The density-as-a-FRACTION threshold was wrong, and this run exposed it.** With
`density <= 0.12` on boards exposing ~100 legal actions, the bar still admits ~12
equally-good moves. It passed 21 positions, but only 9 had a genuinely unique best
move and **7 were already-won blowouts** (|q| >= 0.9 with a ~0 gap to the
second-best move) - exactly the "loose won endgame" non-puzzle that Phase 0b
identified at density 0.86-1.00. They slipped through only because a fraction looks
small on a large action space. Fractions do not transfer across board sizes either,
which matters because 10x12 exposes even more actions.

Fix (in `scripts/filter_puzzle_candidates.py`, which supersedes the candidate bar in
`analyze_puzzle_spike.py`): gate on the **absolute count** of near-best actions
(<= 3) and the **Q gap to the second-best move** (>= 0.15), alongside best-move
prior < 0.20 and |root_q| >= 0.30.

**Result: 5 candidates from 509 distinct positions (~1.0%)** - 3 winning-shot,
2 save, median gap 0.275, every one with exactly ONE move within 0.05 of best:

| game | mv | side | root_q | prior | gap | legal | best | theme |
|---|---|---|---|---|---|---|---|---|
| efe0 | 9 | blue | +0.52 | **0.001** | **1.11** | 107 | `>f8` | winning-shot |
| 2133 | 8 | blue | +0.56 | 0.017 | 0.82 | 93 | `^g7` | winning-shot |
| efe1 | 8 | blue | -0.41 | 0.023 | 0.22 | 100 | `^e6` | save |
| 4fa5 | 9 | blue | +0.49 | 0.096 | 0.18 | 102 | `Cat:Down` | winning-shot |
| efe1 | 6 | blue | -0.66 | 0.115 | 0.27 | 106 | `Cat:Left` | save |

The top row is the archetype the whole pipeline was built to find: one move out of
107 wins, the gap to the next-best is over a full unit of eval, and the network's raw
policy gave that move a **1-in-1000** prior - deep search finds it, pattern
recognition nearly misses it. That is the human-relative difficulty signal working,
and it is exactly what N_jump could not provide.

**Both themes appear**, which no engine-only source produced: Phase 0b weak-vs-weak
play yielded 14 candidates and ZERO winning shots (a weak opponent cannot convert),
and strong-vs-weak yielded 2. Real games between similar, imperfect humans give both.

**Scope for the full corpus:** 14,021 positions at ~6/min is ~39 GPU-hours, minus
~10% for dedup. At ~1% yield that projects to roughly **130 candidates** - a real
puzzle set. The 8x8 bucket is only 570 of those positions; 10x12 (5929) and 8x10
(3825) are where the volume is.

## Open questions

1. **D6 CPU latency** on 8x8 short search - decides solve-time hosting. (Phase 0b)
2. Difficulty -> ELO calibration - needs player solve data. (deferred)
3. Which variants first beyond 8x8 classic/standard, and how freestyle (fixed 12x10) fits.
4. Human-game scanning + "human missed the tactic" signal - when to add.

## Key files

Engine: `deep-wallwars/src/mcts.{hpp,cpp}` (search, `root_value`, `root_info`),
`deep-wallwars/src/gamestate.hpp` (`Board`, `Turn`),
`deep-wallwars/src/engine_adapter.cpp` (JSON position -> Board, move notation),
`deep-wallwars/src/main.cpp` (CLI dispatch).
Puzzle app: `shared/domain/puzzles.ts` (rich `Puzzle` type + 10 hardcoded),
`shared/domain/puzzle-notation.ts`, `server/db/schema/puzzles.ts` (minimal),
`server/routes/puzzles.ts`, `frontend/src/hooks/use-puzzle-game.ts`,
`frontend/src/routes/puzzles.$id.tsx`.
Game data: `server/db/game-queries.ts` (`queryPastGames`, `buildReplayGameFromRow`),
`server/db/schema/game-details.ts` (`moves` JSONB, standard notation).

## Parked state (2026-07-24) - how to resume

Nil paused this arc after the ingest was built and validated but BEFORE the first
detection run. Nothing is half-finished: every piece below is committed and tested.

**Done and committed (local only, NOT pushed - the arc's no-push rule still holds):**
- `6f05b76` - wallwars.net export + converter. 394 classic games converted and
  validated (clean replay + exact `finalDists` agreement, 0 mismatches).
- `49af224` - `deep_ww --analyze --analyze_game_file`: external-game ingest.
  Built on the 4090 desktop in `deep-wallwars/build-puzzle/` and smoke-tested with
  model_79 (a 10x12 Red-first game and a padded 8x8 Blue-first game both replay
  correctly; cat positions match the classic embedding offsets exactly).

**Data on disk:**
- Helsinki: `~/nil/wallwars_games/games_raw.jsonl` (422 raw), `games_converted.jsonl`
  (394 converted, with `firstPlayer` + standard-notation `moves`).
- Desktop: `~/puzzle_data/games_converted.jsonl` (394). Deliberately NOT in `/tmp` -
  the first copy was lost to a WSL reboot.

**How the desktop gets engine source (rule, 2026-07-25): via git, never scp.**
The engine source used to be scp'd to the desktop because its `origin` pointed at a
stale local mirror that could not deliver commits. That mirror hack is gone (the
desktop tracks GitHub directly), so the workflow is: commit on Helsinki -> push ->
`git pull` on the desktop. As of 2026-07-25 the desktop has **zero local source
edits** (verified: the three formerly-scp'd files are byte-identical to their
committed versions), so there is nothing for a `git pull`/`checkout` to clobber -
which is what makes this safe rather than just tidy. If you ever need a source change
on the desktop, commit and push it; do not scp.

**The exact next step (never run):** the first detection run on the free 4090.
Scope it to the 8x8 bucket first (19 games / 570 positions - the strongest-oracle
regime), measure real throughput, then decide how wide to go:

```
# filter the 8x8 subset from ~/puzzle_data/games_converted.jsonl, then in a tmux
# (so it survives session release):
cd ~/nil/wallgame/deep-wallwars/build-puzzle
./deep_ww --analyze --analyze_game_file ~/puzzle_data/games_8x8.jsonl \
  --model1 ../models_12x10_tf_curriculum/model_80.trt \
  --columns 12 --rows 10 --analyze_samples 10000 --analyze_chunk 2000 \
  --analyze_moves 60 --analyze_output /tmp/puzzle_8x8.jsonl
```

Then filter candidates with `scripts/analyze_puzzle_spike.py`: density <= ~0.12
(unique best move) AND low best-move policy prior (non-obvious) AND decisive eval.
Classify win/save. After that comes storage (schema migration + writer) and wiring
into the existing puzzle UI (NOT the replay viewer, per D3).

**Scale note:** 14,021 start-of-turn positions across the 394 games (10x12=5929,
8x10=3825, 6x8=870, 8x8=570, 5x6=546, ...). A deep pass over everything is a
multi-day GPU job, so the first run must be scoped and throughput measured before
committing to a full sweep.

**Do NOT** stop training to run this without Nil's go-ahead - the GPU is training's
by default.
