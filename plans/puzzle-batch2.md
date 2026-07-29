# Puzzle batch 2 — Nil's follow-ups of 2026-07-29 (second batch)

Re-read this file at the start of every iteration. Conversations compact; this file
does not. Companions: `info/puzzle-platform.md` (model, environment — THE doc to read
first), `plans/puzzle-loop-4.md` (loop 4 and the S-BATCH1 section), and loops 1-3 in
`plans/puzzle-polish-loop.md`, `plans/puzzle-feature-loop.md`, `plans/puzzle-bugs-loop.md`.

Nil gave five items after playing puzzle 39 and finding it unsolvable. They are
independent and run as three slices.

## The five items

1. **Puzzle 39 is unsolvable — what went wrong in generation?** Answered by
   measurement, then fixed by a new gate. Slice S-EVAL.
2. **Landing page:** remove the Campaign and Study Board cards, leaving a row of two
   under "Single-player Fun". Slice S-FOLD.
3. **Remove the solo-campaign endpoint** and fold campaign levels under the Puzzles
   tab as the first of three sections, on the same server-side tracking as the rest.
   Slice S-FOLD.
4. **Rename the production bot** "Transformer Bot (experimental)" -> "Superhuman Bot".
   Slice S-BOTS.
5. **Add "Easy Bot"**, not official, same engine as the Superhuman bot with a single
   sample per move. Slice S-BOTS.

## Nil's decisions (do not re-ask)

Carried and still binding: website copy never exposes internal mechanics; puzzle games
are unrated and ELO paths are untouched; retirement stays manual; reviewer is Project
Reviewer 1 (`agent-1780864878869-eq7t`) with a plan gate and a diff gate per slice and
commit only on sign-off; push and deploy autonomously per slice; login-required
verification is walked through with Nil.

New for this batch (2026-07-29):

1. **Retire puzzles 17, 19, 28, 32, 34 and 39.** Nil: _"puzzles must be decisively
   winning"_ — the four near-even ones go too, not just the two lost ones.
2. **Add that as a gate in the puzzle generator.** This narrows the standing
   "no automated quality gating" rail: Nil's model says solving a puzzle means winning
   it, so a position the mover cannot win is not a puzzle. It is a precondition of the
   model, not a judgement of taste. Nothing else about the rail changes — no
   wrong-move detection, no correctness checks, no automated retirement.
3. **The campaign keeps its play URL.** `/solo-campaign` redirects to `/puzzles`
   rather than 404ing anyone's bookmark; levels still play at `/solo-campaign/$id`.
4. **Keep the "more coming soon" note** at the end of the campaign section. Nil knows
   the section is sparse (two levels).
5. On the campaign checkmark bug (board `cfc6135a`), Nil: _"i haven't seen that bug for
   puzzles, so if you copy/adopt the same mechanism, it should be fixed, no? But i can
   tell you if i see it again in the wild."_ — adopt the puzzle mechanism, do not
   invent a bespoke fix, and let him report a recurrence. See the caveat in S-FOLD.

## Process, gates, rails

Unchanged from loop 4 — see `plans/puzzle-loop-4.md`. Gates: `bun run build`;
`bun x tsc --noEmit -p tsconfig.json` (exit 2 expected, only minimax-engine CMake
noise); `bun x tsc --noEmit -p frontend/tsconfig.test.json`; `bun x eslint .`;
`bun x prettier --check .`; `bun test tests/game/`; `bun test tests/integration/bot-6*
bot-7* bot-8*`; `cd frontend && bun test src/`. Run prettier and eslint FROM THE REPO
ROOT — the Bash tool's working directory persists between calls, and running them from
`frontend/` silently uses a different `.prettierignore` and reports failures that do
not exist.

---

## S-EVAL — the decisively-winning gate, and six retirements

### What went wrong in generation

Nothing broke. The generator never asked who was winning.

Generation guarantees exactly one thing: both attack races are 3-6 steps through the
walls at the start. The two race lengths are drawn INDEPENDENTLY, and even a close race
can be decided by a defender spending actions on walls, which nothing models. The one
rule that consulted the engine (the distance-delta rule, section H of the feature doc)
only asks whether the best first move is a boring two-step walk.

The engine's `evaluate_response` has always returned `evaluation` — a number in
[-1, +1] from P1's perspective — alongside `bestMove`. **The filter script read
`bestMove` and discarded `evaluation`.** The number that would have caught this was in
the response all along.

Measured 2026-07-29 over all 39 live puzzles at their starting positions (PuzzleBot's
exact binary, model and settings, offline throwaway process on the desktop,
sequential). Win probability for the human at move one:

| Puzzle | 19  | 39  | 32  | 28  | 34  | 17  | the other 33 |
| ------ | --- | --- | --- | --- | --- | --- | ------------ |
| human  | 0%  | 5%  | 49% | 56% | 64% | 80% | 86-100%      |

Race asymmetry does not predict it: puzzle 39 is a mild 4-vs-3 race and sits at 5%,
while another 6-vs-3 puzzle is 91% for the human.

Sign-convention check, worth keeping because the sign is the whole trap: if the
perspective were inverted the data would claim 37 of 39 puzzles are hopeless, which
contradicts Nil having solved and praised many of them.

### The gate

`MIN_MOVER_EVALUATION = 0.65` in `shared/domain/custom-setup-verdicts.ts`. The engine
contract promises only a number in [-1, +1] and says nothing about calibration, so this
is a threshold on that number, NOT a win probability — the current UI maps 0.65 to a
displayed 82.5%.

The value is the MIDPOINT of Nil's observed curation boundary: he retired a puzzle the
engine scored ~0.592 for the mover and kept one at ~0.715. The first version of this
gate used 0.7, which hugged the kept edge — and the ambiguity audit below then measured
that kept puzzle at 0.691, 0.715 and 0.757 on three independent evaluations, i.e. 0.7
turned ordinary engine noise into an arbitrary classification. The midpoint keeps both
of Nil's anchors on their own side of the line by more than the noise: the retired one
reads 0.592 and 0.612, the kept one never drops below 0.691.

Shape (all of it from the reviewer's plan gate):

- The raw P1-perspective `evaluation` is what gets stored — that is the protocol fact.
  `moverEvaluation(evaluation, mover)` is the ONE place the sign is flipped.
- `keepByDelta` and `keepByEvaluation` stay separate; `keepVerdict` is the sole
  conjunction.
- `isValidEvaluation` range-checks at every boundary, because a TypeScript field does
  not validate imported JSON.
- **`applyCandidateVerdicts` takes nothing on trust.** It replays the recorded
  `bestMove` with production rules and requires the recorded distances to reproduce
  exactly, then RECOMPUTES `keep`; the file's own `keep` is an audit checksum and
  disagreement throws. Previously a structurally valid file with fabricated distances
  was accepted by every caller except one test, and a rule change with a stale artifact
  would have silently honoured the old decisions.
- An empty recorded move is rejected. `"---"` is VALID notation for a pass, so it
  replays to zero distance change and would reproduce any delta-0 record exactly. The
  engine never answers a live position with a pass. (Found by a test of mine that
  asserted the wrong thing and failed for the right reason.)
- Seed rows carry the evaluation into `source` (`savedPuzzleSourceSchema`), OPTIONAL so
  the 41 rows seeded before today still parse. They are deliberately not backfilled;
  their provenance is the committed artifact of the day they were seeded.

### Artifact regeneration: the keep flips

Regenerated with `bun scripts/filter-puzzle-candidates.ts` (48 sequential evaluations,
throwaway engine process on the desktop, serving engine untouched). 48 verdicts, **36
kept**, 12 rejected — was 41 kept. The run prints an old-vs-new audit and flags any
candidate within `NEAR_THRESHOLD` of the threshold.

Seven keep flips, all accounted for:

| candidate        | old -> new     | live puzzle  | why                           |
| ---------------- | -------------- | ------------ | ----------------------------- |
| synthetic-6x6-21 | keep -> reject | Puzzle 17    | mover eval 0.592              |
| synthetic-6x6-23 | keep -> reject | Puzzle 19    | mover eval -0.999             |
| synthetic-6x6-35 | keep -> reject | Puzzle 28    | mover eval 0.154              |
| synthetic-6x6-41 | keep -> reject | Puzzle 32    | mover eval -0.069             |
| synthetic-6x6-43 | keep -> reject | Puzzle 34    | mover eval 0.261              |
| synthetic-6x6-48 | keep -> reject | Puzzle 39    | mover eval -0.900             |
| synthetic-6x6-26 | reject -> keep | never seeded | NOT the new rule — the engine |

returned a different best move this run (`Cd4` delta -2 -> `Cd3.>c4` delta -1), so it
now passes the DISTANCE rule |

**The rule, applied blind to all 48 candidates, rejects exactly the six live puzzles
Nil named and no other live puzzle.** That is an independent confirmation of both the
threshold and the sign convention: the six were chosen by Nil from play and from the
census, and the gate reproduces that set without being told it.

Two candidates (`-01`, `-07`) are kept by the artifact but retired in production — Nil
retired them at S-COPY as too easy. The artifact classifying them as keep is expected
and harmless; production retirement is a separate, manual, DB-level fact.

### The ambiguity audit, and what it found (reviewer blocker at the diff gate)

`NEAR_THRESHOLD` is **0.15**, sized from measured noise rather than intuition. One
position read 0.691, 0.715 and 0.757 on three independent evaluations, so the band must
be comfortably wider than that spread AND wide enough that a candidate at the top of it
is still flagged — at 0.1 a 0.757 reading sits 0.107 from the threshold and would go
unexamined. The original 0.03 flagged nothing at all and would not have performed the
audit its own comment promised.

**The policy this encodes.** A SINGLE recorded evaluation decides the committed
artifact; the wide band exists to force HUMAN REVIEW of noisy boundary cases; a flagged
candidate is not rejected, and a rerun never rewrites the artifact; and production
curation remains Nil's authority regardless of what the artifact says. Averaging several
evaluations per candidate would reduce the noise properly, but it changes the artifact
schema and belongs in its own gated slice, not here.

At 0.15 the artifact flags four candidates. Each was re-evaluated in a FRESH ENGINE
PROCESS — not merely a fresh game session, because the engine holds an MCTS evaluation
cache for the life of a process, so an in-process repeat would be correlated with the
first reading and would not be independent evidence:

| candidate        | live puzzle | census | artifact | fresh rerun | vs 0.65      |
| ---------------- | ----------- | ------ | -------- | ----------- | ------------ |
| synthetic-6x6-21 | Puzzle 17   | 0.595  | 0.592    | 0.612       | below on all |
| synthetic-6x6-36 | Puzzle 29   | 0.715  | 0.757    | 0.691       | above on all |
| synthetic-6x6-09 | Puzzle 6    | 0.780  | 0.771    | 0.796       | above on all |
| synthetic-6x6-10 | Puzzle 7    | 0.788  | 0.789    | 0.771       | above on all |

Every one of the four is now classified the same way by every independent reading it
has. That is what moving the threshold to the midpoint bought: at 0.7, Puzzle 29
straddled (0.691 against 0.757) and its classification depended on which run you
preferred.

Honest margin note: Puzzle 17 sits 0.038 below the line on its closest reading, about
one noise-width. Both of its readings fall below, and it is one of the six Nil
explicitly asked to retire, so nothing hangs on the margin — but a future candidate
landing there deserves the same scrutiny.

**What the audit found that matters beyond the numbers: Puzzles 6 and 7 are the two Nil
rated EXCELLENT.** The lowest-scoring survivors in the batch are his two favourites plus
Puzzle 29. That inverts an assumption this project has been running on:

> the feature doc says "generation is cheap, so false negatives are free"

True for a blind sample. NOT true near this threshold, because the positions just above
it are demonstrably the most interesting ones — a puzzle where you are winning but not
overwhelmingly is a better puzzle than one where you are winning 99-1. So any future
stability rule must not be "the minimum reading must pass": that would preferentially
discard the best puzzles.

VERIFIED when the threshold moved from 0.7 to 0.65, and stated explicitly because the
artifact was NOT regenerated for it: zero candidates have a mover evaluation in
[0.65, 0.70), so no classification changes; zero stored keep flags disagree with the
0.65 rule; the kept count stays 36; and the gate still rejects exactly Nil's six live
targets. The fail-closed loader throws on any keep disagreement, so the test suite is a
second, independent check of the same claim.

Cross-run reproducibility (census vs filter run, different scripts and sessions):
-48 measured -0.906 then -0.900; -23 -0.999 then -0.999; -41 -0.022 then -0.069; -43
0.284 then 0.261; -35 0.117 then 0.154. Same conclusions both times.

### Retirement (production data, after diff sign-off and deploy)

ONE invocation with all six CURRENT names — names shift as survivors renumber, so six
sequential runs would resolve later names against an already-changed numbering:

```
fly ssh console -a wallgame -C "bun scripts/retire-puzzles.ts 'Puzzle 17' 'Puzzle 19' \
  'Puzzle 28' 'Puzzle 32' 'Puzzle 34' 'Puzzle 39'"
```

39 enabled puzzles become 33, renumbered contiguously 1..33. Completions and votes are
keyed by row id and stay attached to their rows.

`retire-puzzles.ts` now proves EXACT SETS in its read-back rather than counts: the id
set is unchanged, the newly-disabled set equals the requested targets exactly, the
surviving enabled set equals the preflight enabled set minus targets, rows already
disabled stay disabled with their historical names, and no row's fingerprint, sortIndex
or config moved. A write that disabled the right NUMBER of wrong rows passes a count
check; it does not pass this.

### Status

- [ ] S-EVAL — awaiting diff gate.

---

## S-FOLD — landing page, and the campaign under /puzzles (items 2 and 3)

Not started. Notes gathered while planning:

- Landing page (`frontend/src/routes/index.tsx`): "Single-player Fun" is a
  `grid-cols-2` of four cards; removing Campaign and Study Board leaves Puzzles and
  Play vs AI as one row. Neither removed destination is in the nav bar.
- `/puzzles` (`frontend/src/routes/puzzles.index.tsx`) currently renders two sections
  ("Handcrafted Puzzles", "Puzzles") through one local `PuzzleCard`. The campaign
  becomes a third section, FIRST, keeping the "more coming soon" card at its end.
- There are only TWO campaign levels (`shared/domain/solo-campaign-levels.ts`).
- **Campaign completion is ALREADY server-side** — S-CAMP shipped
  `campaign_level_completions` on 2026-07-29, and `use-campaign-progress.ts` is
  deliberately shaped like `use-puzzle-progress.ts`. So "apply the same server-side
  tracking" is already true, and the honest caveat for Nil is that folding the UI
  cannot by itself fix the checkmark bug: the scripted-puzzle write has the IDENTICAL
  shape, so if the race is real it exists there too and he has simply not hit it.
  What the fold can legitimately buy is ONE progress read for the whole page (the
  S-BATCH1 route loader warms it) and one invalidation.
- The campaign end popup (`solo-campaign-end-popup.tsx`) links to `/solo-campaign`;
  that button must follow the redirect decision.

## S-BOTS — rename, and Easy Bot (items 4 and 5)

Not started. Measured before planning, because the obvious config would not have
worked:

- **`--samples 1` is impossible.** The engine answers "No legal move available" below
  roughly 100 samples: measured FAIL at 1, 2, 3, 4, 8, 16, 32, 64, 96 and OK at 112,
  128, 256, 1000. Controls: the identical message succeeds at 1000, and
  `--parallel_samples` is not the variable (1000/parallel=1 works, 32/parallel=32
  fails). Not board-size-driven either — 112 works on both 5x5 and 12x10.
- Mechanism: `bgs_session.cpp` reports a move only once MCTS has expanded a COMPLETE
  two-action turn (`peek_best_move`); below that there is no such node. There is no
  policy-only flag in the engine.
- So Easy Bot runs at `--samples 128` (Nil informed, 2026-07-29): the search barely
  gets past expanding the root, so the policy prior dominates — as close to "policy
  head, no tree search" as this engine allows. ~220ms per move.
- `official: false` in the client config makes the client withhold the official token
  for that bot (`official-custom-bot-client/src/index.ts`), and the server then excludes
  it from custom-setup (puzzle) variants and from eval-bar duty. Both correct for free.
- The rename is config-only: `built_in_bots.display_name` is re-upserted on attach,
  keyed by bot id, so past games and the bot's rating follow the rename.
- Levers if 128 still plays too strong: an older checkpoint
  (`tf_curriculum_model_63.trt` is on the desktop) or `--model simple`. Not fewer
  samples.
