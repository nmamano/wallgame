# Puzzle polish loop (loop 3) — standing orders + slice handoffs

Re-read this file at the start of every iteration. Conversations compact; this file
does not. Companions: `info/puzzle-platform.md` (model, environment - THE doc to read
first), `plans/puzzle-feature-loop.md` (loop 2's record), `plans/puzzle-bugs-loop.md`
(loop 1's record). Scope source: Nil's 2026-07-26 playtest of the shipped /puzzles
page.

## North star

The puzzle experience stops feeling rough at the edges: copy leaks nothing internal,
the pool is curated, "P1 moves first" is restored as a universal axiom (fixing
takeback gating and seat clarity in one stroke), move history works in puzzles, and
the two puzzle sections look and act like one product.

## Nil's decisions already made (do not re-ask)

- Website copy must NEVER expose internal mechanics (filter rules, pipelines). Durable
  rule, saved to boss memory. Describe what the user gets, not how it is made.
- Curation verdict on the 41: pool is good overall — all winnable, non-trivial.
  Retire Generated Puzzle 1 and 6 (too easy) via `enabled=false` (the column exists
  for exactly this). Rated good: 2, 3, 10, 11. Excellent: 8, 9.
- **P1 moves first is a universal axiom** (Nil, verbatim intent): the old codebase
  assumption was correct and generalizing away from it was the mistake. For puzzles
  where the human is P2, the BOT makes a real first move (an actual ply-0 move in the
  game history), so: takeback parity is correct again without frontend special-casing,
  move history makes sense, and you can SEE you are P2 (a bot move is already on the
  board) — which also answers "does the one-move rule apply to me".
- G3 (completion tracking) and G4 (likes/dislikes) are DEFERRED to loop 4.
- GH issue nmamano/wallgame#1 stays open as-is (long-form writeup linked from board
  task 8f1cf7e3). Bugs are tracked on the isomux task board, not GH.
- PuzzleBot graceful losing (equal-eval tie-breaking) is engine-side C++ = Nil's
  territory: filed as board task b4c2b191, linked from info/puzzle-platform.md §I.
  NOT in this loop.
- Reviewer: Project Reviewer 1 (`agent-1780864878869-eq7t`), plan-gate + diff-gate per
  slice, commit only on sign-off. No other agents. Gate messages must be
  SELF-CONTAINED (their session may be cleared between gates).
- Autonomy: push + deploy to production autonomously per slice; bot restarts anytime
  (no gap needed since S-CX); login-required verification = walk Nil through it.

## Process per slice

plan → Reviewer plan-gate → implement → always-run gates → Reviewer diff-gate →
sign-off → ONE focused commit (tick the checkbox in it) → push → deploy / restart as
the slice requires → production verification → author the next slice's pickup (with a
"what the previous slice taught" block). Production verification is post-commit; if it
fails, fix forward before the next slice. While waiting on the reviewer, end the turn
with a ~20-25 min fallback wakeup via isomux scheduled self-message; the reply is the
real wake signal.

## Gates per slice

- `bun run build` — 0 TS errors; server/shared changes ALSO need
  `bun x tsc --noEmit -p tsconfig.json` (ignore minimax-engine CMake-artifact noise).
- `bun x eslint .` — clean.
- prettier on touched files only; `bun x prettier --check .` must stay clean
  (pinned 3.8.3).
- NOT gates: `bun run ci` (cannot pass on auntie).
- Production evidence: fresh curl reads of prod APIs, desktop bot log
  (`~/logs/bot-client-transformer.log`), DB reads/writes via
  `~/.fly/bin/fly ssh console -a wallgame` (base64-encode a bun script, run inside
  the machine), preview-url screenshots as artifacts only. Probe harness from loops
  1-2 (POST /api/bots/play + drive the game websocket with a bun script) is proven —
  reuse it; probe games 0 moves where possible and resign them.

## Standing rails (prohibitions)

- NEVER `pkill -f` / `killall` on any box; exact PIDs only.
- NEVER scp SOURCE to the desktop; source moves by git (test DATA files are fine).
- NEVER deploy anything but a clean `git archive` of a committed sha:
  `rm -rf /tmp/wg-deploy && mkdir -p /tmp/wg-deploy && git archive <sha> | tar -x -C /tmp/wg-deploy && cd /tmp/wg-deploy && ~/.fly/bin/fly deploy --remote-only`
- NEVER restart `wallgame-dev-5174` while Nil is mid-game; own dev on port 5175.
- NEVER add wrong-move detection, correctness checks, or automated puzzle-quality
  gating. Nil is the filter.
- ELO paths untouched.
- No migrations expected this loop; if one becomes necessary: additive-only, review
  the generated SQL pre-deploy, seeding never in release_command.
- Prod data changes only when Nil explicitly ordered them (retiring 1 and 6 is
  ordered); anything ambiguous about production data → ask Nil.
- Batch engine evaluation ONLY via the sequential offline ssh driver
  (`scripts/filter-puzzle-candidates.ts`); NEVER point batch tooling at the serving
  engine (parked concurrency defect, task 8f1cf7e3).
- Bot restart recipe: kill tmux `bot-client` on the desktop, start
  `bash ~/run_transformer_bot.sh` in tmux, verify BOTH the attach log line AND
  `/api/bots?variant=custom-setup-standard` lists dw-puzzle. No gap needed.
- NEVER weaken a gate to pass; fix in-slice or park the decision for Nil.
- Stop conditions: 3 consecutive gate failures on one slice → stop and summarize; any
  ambiguity about production data → ask Nil (he is reachable).

## Slice plan

- [x] S-COPY — copy + curation: (1) remove the /puzzles Generated-section subtitle
      that exposes filter mechanics (`frontend/src/routes/puzzles.index.tsx` ~227);
      replace with user-facing copy or nothing. (2) Retire Generated Puzzle 1 and 6:
      prod `UPDATE saved_puzzles SET enabled=false` for those two rows (verify the
      displayName↔row mapping inside the fly machine before writing; GET /api/puzzles
      already filters `enabled=true`; the seeder is fingerprint-idempotent so a rerun
      cannot re-enable them — verify that claim in-slice). No migration.
      DONE `3636107`, deployed + prod-verified: retire script reported exactly
      41 total / 41 enabled pre-write and retired exactly the two ordered rows;
      GET /api/puzzles now 39 rows (names 1 and 6 absent, list spans 2..41);
      page screenshot clean with the new subtitle; 0-move launch probe on
      Generated Puzzle 2 (game 6eNB47kJ) played and resigned normally.
- [x] S-P1 — restore the P1-moves-first axiom: puzzles where the human is P2 begin
      with the bot's first move applied as a REAL move in the game history (ply 0).
      OPEN DESIGN QUESTION for the plan gate (and Nil): synthetic positions have no
      real game history to take the bot's move from. Candidate designs:
      (a) wall-backout lead-in — pre-position = the vetted position minus two of its
      neutral walls; the stored lead-in move places those two walls; the human then
      faces EXACTLY the curated position (preserves Nil's curation byte-for-byte,
      deterministic, no engine involvement);
      (b) regenerate P2 puzzles from a sampled pre-position + engine best move
      (invalidates curation of existing P2 puzzles);
      (c) live engine first move at game start (non-deterministic, also invalidates
      curation). Lean: (a), pending Nil's veto.
      Ships with: loop 2's S-E checkbox ticked (takeback parity becomes correct with
      NO frontend change — `hasTakebackHistory`'s hard-coded parity is right once P1
      truly moves first); docs updated (the "human always moves first" model fact in
      info/puzzle-platform.md and the bot-log ply-0 interpretation both change).
- [ ] S-MH — move history doesn't work when playing a puzzle (Nil, unspecified).
      REPRODUCE FIRST — ideally reproduce BEFORE S-P1 lands so we know whether S-P1
      fixes it (suspect: history cursor / buildHistoryState with authored
      custom-setup state). Then fix whatever remains.
      SYMPTOM (Nil, 2026-07-26): NO moves appear at all in the history panel —
      seen in Puzzle 3; Puzzle 4 shows moves fine. Nil suspects the same
      P2-moves-first root as takeback (cannot derive parity from the puzzle
      NAME: sortIndex renumbers the 41 survivors, so check each puzzle's
      authored turn from /api/puzzles). Plausible mechanism: the paired
      move-table memo in use-game-page-controller.ts (~2240-2285) pairing
      movers by parity. Recheck empirically AFTER S-P1 ships.
      Recon 2026-07-26 (pre-repro, code read only): buildHistoryState
      (frontend/src/lib/history-utils.ts) derives the initial mover from the
      authored config (`new GameState(config, 0)`) and the historyNav gating in
      use-game-page-controller.ts (~2287) has no variant/puzzle conditions — no
      smoking gun by reading. Symptom description needed from Nil (buttons
      disabled? wrong position rendered? cursor stuck?); empirical browser repro
      required. If cursor -1 shows a STANDARD start position instead of the
      authored one, the config reaching buildHistoryState is the place to look.
- [ ] S-UI — one product, two sections: make scripted vs generated cards consistent
      ("Solve" vs "Try" buttons etc.); scripted cards show BOTH difficulty and rating
      — keep one (lean: difficulty; settle at plan gate). Re-check item 8 (is it
      clear whether you are P1 or P2 in-game) AFTER S-P1 — Nil expects S-P1 largely
      answers it; fold a small indicator in here only if still unclear.

## SLICE S-P1 AMENDED DESIGN (reviewer plan-gate amendments + Nil's lead-in

## heuristic, 2026-07-26 — design APPROVED by Nil, plumbing per reviewer)

NIL'S LEAD-IN HEURISTIC (2026-07-26, replaces wall-backout as primary — he
rejected wall placements as "equally noticeable"; fabricated pawn walks must
look PLAUSIBLE, hence greedy-advance/flee shapes). All distances are true path
length through the curated position's walls (BFS); walls are identical in the
pre-position for cases 1-2. Curated cells: bot cat C, bot mouse M, human cat
hC, human mouse hM.

1. CAT ADVANCE: find a cell X with dist(X, C) = 2 and dist(X, hM) =
   dist(C, hM) + 2. Pre-position: bot cat at X. Lead-in: double cat move
   X→C — a strict 2-step greedy advance toward the human mouse.
2. Else MOUSE FLEE: find a cell Y with dist(Y, M) = 2 and dist(Y, hC) =
   dist(M, hC) − 2. Pre-position: bot mouse at Y. Lead-in: double mouse move
   Y→M — a 2-step flee from the human cat.
3. Else WALL FALLBACK: lead-in places 2 of the premade walls (canonical
   last-two; pre-position = curated minus those walls). Nil: "nonsensical but
   not game breaking, we can accept this."
   CENSUS RESULT (2026-07-26, read-only, reviewer-required): ZERO fallbacks —
   the 41 rows split 22 P1 / 19 P2, and all 19 P2 rows admit a pawn lead-in
   (11 cat-advance, 8 mouse-flee). DECISION: implement tiers 1-2 only and FAIL
   CLOSED when neither applies (reviewer amendment 2). Wall fallback is NOT
   implemented; if a future batch needs it, note (a) reviewer finding: walls
   placed BY A MOVE are stamped with the mover's playerId and render colored
   (applyMove converts neutral walls to owned — "structurally ownerless" is
   false for placed walls), and (b) Nil explicitly accepts that visual
   difference ("wall colors won't be neutral — non-issue to me", 2026-07-26),
   so tier 3 may be added then without re-litigating, but never by silently
   neutralizing walls post-apply (breaks history-replay consistency).
   Reviewer implementation clarifications: a double pawn move is ONE Move
   action with the target cell (applyMove charges Manhattan distance 2 and
   picks a legal intermediate internally) — require Manhattan==2 AND
   Grid.distance==2; lexicographic X/Y tie-break; no intermediate stored.
   Replay assertion: status=playing, history length 1, turn=P2, serialized
   pawns/walls (incl. ownership) equal the curated target. Population records
   per-row heuristic choice for auditability.
   Implementation notes: deterministic tie-break when multiple X/Y qualify
   (lexicographic smallest); X/Y must not collide with any other pawn cell;
   assert via the pure replay that pre-position + lead-in reproduces the curated
   config EXACTLY and triggers no terminal state. ONE-MOVE RULE CHECK (done): it
   is a draw-compensation rule at capture time (game-state.ts ~588-603), NOT a
   first-turn action limit — a double-action ply 0 is legal.

Reviewer approved stored-explicit `lead_in` column but required these amendments
(they caught two real gaps: POST /api/bots/play has no server-side puzzle
identity — puzzleId/name are client-local handshake metadata only — and Retry
calls playVsBot with gameState.config, which after backout would be the
PRE-position, silently degrading Retry):

1. SERVER-AUTHORITATIVE PUZZLE LAUNCH: discriminated request shape on
   /api/bots/play — a puzzle launch sends `puzzleId` (NO config/hostIsPlayer1);
   the route fetches the ENABLED saved_puzzles row, validates via the DB
   contract, derives config + seat + leadIn from the row. Ordinary bot-game
   requests keep today's shape.
2. RETRY BY PUZZLE ID: Retry must call the same puzzleId launch variant, never
   reconstruct from gameState.config. Client-local handshake puzzleId can carry
   it; verify it survives snapshot/handshake replacement paths.
3. LEAD-IN APPLICATION: on a P2 saved puzzle the server reconstructs the
   pre-position, creates the session with bot=P1, applies leadIn through the
   NORMAL action path before the human gets playable state. Postconditions:
   history length 1, turn=P2, board/pawns byte-equivalent to curated config,
   replayable authored initial config. P1 puzzles: history 0, turn=P1.
4. FAIL-CLOSED INVARIANT at the server boundary: P2 row with lead_in=null
   REFUSES launch (no silent human-first fallback); P1 row must have
   lead_in=null. Enforced during the migration→population rollout gap too.

Population script: shared strict Move/lead-in Zod schema (no unchecked JSONB);
validate all rows pre-write; populate EVERY stored P2 row including disabled
ones; assert exact selected set + P1 rows stay null; one transaction; read back
all. Canonical last-two-walls choice valid only after a pure replay assertion
passes for every row (>=2 walls, lead-in = exactly those 2 wall actions, mover
is P1, reconstructed result matches curated config incl. turn/actionsTaken
normalization).

Tests beyond the pure replay test: route/service-level saved-puzzle launch test
(authoritative lookup, P2 seat, real history[0], exact curated position,
rejection on missing/invalid leadIn); Retry regression (sends puzzleId,
recreates pre-position + ply-0 history); P1 launch regression; ordinary
bot-game regression. Ops: review migration SQL pre-deploy; run population
immediately after deploy/migrate (fail-closed makes the gap safe). Prod
verification adds RETRY of a P2 puzzle to launch/takeback checks.

## SLICE S-COPY PICKUP (authored at loop-3 setup)

- Baseline: c59667d (docs-only ahead of prod bacc0ce; this slice's deploy carries
  both).
- Goal: the two curation/copy orders above, exactly. Nothing else rides along.
- Subtitle today (puzzles.index.tsx ~225-228): "Positions whose best first move is
  simply walking at the target are filtered out; nothing else is vetted." Gone per
  the durable copy rule. Replacement is the slice's call — short, user-facing, or
  nothing.
- Retirement mechanics: bun script run inside the fly machine (base64 pattern from
  S-G1's seeder verification); read the two rows back after the UPDATE; then curl
  GET /api/puzzles from outside and confirm 39 rows, names 1 and 6 absent, page
  renders 39 cards (screenshot).
- Check nothing depends on contiguous sort indices or the count 41 (rg for "41",
  sortIndex assumptions).
- Verification: prod API + page screenshot; a launch of a surviving puzzle still
  plays.
