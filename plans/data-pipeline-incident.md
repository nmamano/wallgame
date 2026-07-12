# Incident: training-data corruption in deep-wallwars self-play (fixed 07a9e3c)

Date: 2026-07-12. Investigated by WallGamer with Game Reviewer as adversarial
pair; triggered by Nil rejecting pathological tournament results.

## Summary

Since the original engine import, every self-play training CSV carried a
seat-asymmetric defect: **blue decisions were labeled with real MCTS visit
distributions, red decisions mostly with fast-forwarded one-hot labels**
(70% of red records at 12x10, 21% at 8x8; 0% of blue records in both).
Every model ever trained in this ecosystem (5x5, both 8x8s, 12x10 universal,
and the paused transformer run) learned from this signal.

## Mechanism

`training_play_single` runs two MCTS trees (one searches red turns, one blue;
each fast-forwards the opponent's committed action). At game end it invoked
`opts.on_complete(mcts1, index)` AND `opts.on_complete(mcts2, index)`;
`TrainingDataPrinter` opens `game_<index>.csv` with a truncating `ofstream`,
so the second call overwrote the first. The surviving file was always
mcts2's (blue's) history, in which red's decisions are fast-forwarded nodes
whose "labels" are whatever visit counts blue's lookahead left behind - often
a single visited edge (one-hot). Smaller boards suffer less because the same
sample budget covers the opponent's replies more densely (21% vs 70%).
Attribution: the code is verbatim from the original deep-wallwars import
(`git show e560922:src/play.cpp`); present through all forks and eras.

Bonus defect in the same function: the blue-has-no-action branch logged
"Red player won" but returned `Winner::Blue`. (`evaluation_play_single` was
always correct - tournament results are unaffected by this one.)

## How it surfaced (evidence chain, in order)

1. A 3-way tournament (distilled transformer vs live_gen5 transformer vs
   old_resnet48) produced "blue wins 98%" in the transformer pairing.
   WallGamer initially rationalized this as a structural second-player
   advantage. **Nil rejected the rationalization** ("there is no second
   player advantage... we need checks and balances").
2. Instrumentation: games were real (median 69 plies); PGN moves are a
   hardcoded placeholder but results are real; simple-policy mirrors are
   balanced at both 8x8 and 12x10 (no structural seat advantage).
3. A false lead: "every CSV starts at 22 walls => openings missing from all
   training data". **Falsified by Game Reviewer**: 22 = the 12x10 board
   perimeter encoding in the wall planes (10 right-edge + 12 bottom-edge
   `is_blocked` flags), not placed walls. The first records ARE ply 0.
   (WallGamer's "incoherent value head" probe was also invalidated - it fed
   zero wall planes instead of the perimeter encoding.)
4. The real signature: one-hot label fraction split by player-to-move:
   12x10 data 70% red / 0% blue; oldest surviving 8x8 data 21% / 0%.
5. Twin-mirror matches (same model both sides, seat the only variable):
   blue won 97% of decisive games (8x8 classic 750k), 78% (model_27
   8x8 standard, deployed), 73% (model_48 12x10, deployed). Humans expect a
   FIRST-mover advantage per Nil, making the direction doubly anomalous.

## Fix (commit 07a9e3c, design by Game Reviewer)

- Each decision recorded from the tree that searched it, captured pre-commit
  into one chronological `std::vector<NodeInfo>`.
- `CompletionCallback` now fires exactly once per game with the records and
  the final board; printer writes once; unsampled terminal root dropped.
- `Winner::Red` returned when blue has no action.
- Regression tests (`test/play.cpp`): single callback invocation; first
  record is the initial board at `Turn{Red, First}` with zero interior
  walls; first label is a distribution (not one-hot); both seats present.
- Permanent audit gate `scripts/audit_labels.py`: one-hot rate by seat with
  thresholds. Post-fix audit on fresh games: red 0.1% / blue 0.0%, gap 0.1%.
- `training.py --game-columns/--game-rows` passthrough (curriculum training).

## Open question (pre-registered falsification test)

Does the fix remove the blue dominance in twin mirrors? After ~5 clean
curriculum generations, twin-mirror the new model:
- Asymmetry gone/greatly reduced => the corruption explains it.
- Blue still dominates => a real second-mover advantage at bot level exists
  (independent discovery; game-design implications; NOT explained by the bug;
  note the corruption direction favoring blue's labels makes bug-induced
  blue-skill plausible, but the 8x8-standard/12x10 gradient argued partly
  against corruption magnitude tracking the effect).

## Consequences to keep in mind

- All pre-fix data (old lineage 187GB + transformer gens 0-6) carries the
  defect; do not mix it into post-fix training windows without noting it.
- All historical model comparisons remain valid RELATIVELY (common-mode
  defect), including the blog post's conclusions.
- The deployed bots are seat-lopsided against near-equal opposition.
  Consider refreshing production models after the curriculum run matures.

## Lessons (now standing rules)

1. Checks and balances apply to EXPERIMENTS and REPORTS, not just code.
   Anomalous results get adversarial review before reaching Nil; always ask
   "what mundane bug produces exactly this data?" first.
2. Data-quality audit gates (label entropy by seat, per-file write counts)
   belong in the pipeline permanently, not in post-hoc investigations.
3. Boundary encodings (board perimeter in wall planes) must be documented -
   two independent analyses tripped over the same 22-wall red herring.
