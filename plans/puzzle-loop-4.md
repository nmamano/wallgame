# Puzzle loop 4 — standing orders + slice handoffs

Re-read this file at the start of every iteration. Conversations compact; this file
does not. Companions: `info/puzzle-platform.md` (model, environment — THE doc to read
first), `plans/puzzle-polish-loop.md` (loop 3's record), `plans/puzzle-feature-loop.md`
(loop 2), `plans/puzzle-bugs-loop.md` (loop 1). Scope source: doc §G items 3 and 4,
deferred out of loops 2 and 3, plus Nil's answers of 2026-07-28.

## North star

The puzzle platform learns who solved what and what people think of each puzzle:
completion is tracked server-side (server-verified for generated puzzles, so a client
cannot claim a solve it did not earn), scripted puzzles join the same server-side
progress model instead of browser-local storage, and logged-in players who have beaten
a puzzle can like or dislike it, with the list sortable so the most liked come first.

## Nil's decisions already made (do not re-ask)

Carried from loops 1-3 (still binding):

- Website copy must NEVER expose internal mechanics. Describe what the user gets.
- Nil is the filter: no wrong-move detection, no correctness checks, no automated
  puzzle-quality gating. Retiring puzzles stays manual via `scripts/retire-puzzles.ts`.
- Puzzle games are unrated; ELO paths untouched.
- Reviewer: Project Reviewer 1 (`agent-1780864878869-eq7t`), plan-gate + diff-gate per
  slice, commit only on sign-off. Gate messages must be SELF-CONTAINED (their session
  may be cleared between gates). No other agents.
- Autonomy: push + deploy to production autonomously per slice; login-required
  verification = walk Nil through it (there is no test account).

New for loop 4 (Nil, 2026-07-28):

1. **Scripted puzzles go server-side too.** The 10 scripted puzzles stop relying on
   browser-local storage; their completion is stored on the server like the generated
   ones, so all 49 cards behave identically across devices. Their completion stays
   client-asserted (the solo campaign already works this way and a guided walkthrough
   has nothing worth forging); generated-puzzle completion is server-verified.
2. **Anonymous completions are recorded for usage data**, but anonymous visitors see no
   completion markers in the UI (they get an invitation to log in). Generated-puzzle
   anonymous solves come free from the persisted game record; scripted ones need an
   unauthenticated write, which is therefore validated against the known scripted set.
3. **Sorting:** numeric order stays the default; a sort control offers "Most liked",
   ranked by likes minus dislikes with puzzle number as the tiebreak.
4. **Voting is earned and captured fresh:** only a player who has BEATEN a puzzle may
   vote on it, and the capture point is the game page right after the win notification,
   while the puzzle is fresh in mind. Not a permanently open control on every card.
5. **No backfill of past completions** — not the generated wins already in the games
   table, and not the existing browser-local scripted completions. This ships as a new
   feature that starts counting from its deploy. (Backfilling generated wins would mean
   restoring position-matching, which doc §G says to delete rather than extend.)
6. **Votes cover the generated puzzles only.** Nil: no preference, whatever is easier —
   and generated-only is both easier and the meaningful scope. Votes exist to curate the
   fluid generated pool; the scripted 10 are a fixed ordered tutorial set, they are not
   rows in `saved_puzzles`, and Nil's capture point (the game page after the win
   notification) does not exist for them — they finish on their own solved card.
7. **A vote can be changed later from a solved puzzle's card**, as well as being
   captured post-win. The post-win panel is where a vote is first asked for; the card
   shows the vote you gave and lets you flip it (his original spec called votes
   changeable).

## Process per slice

plan → Reviewer plan-gate → implement → always-run gates → Reviewer diff-gate →
sign-off → ONE focused commit (tick the checkbox in it) → push → deploy → production
verification → author the next slice's pickup (with a "what the previous slice taught"
block). Production verification is post-commit; if it fails, fix forward before the
next slice. While waiting on the reviewer, end the turn with a ~25 min fallback wakeup
via isomux scheduled self-message; the reply is the real wake signal.

## Gates per slice

- `bun run build` — 0 TS errors; server/shared changes ALSO need
  `bun x tsc --noEmit -p tsconfig.json` (ignore minimax-engine CMake-artifact noise).
- `bun x eslint .` — clean.
- `bun x prettier --check .` stays clean (pinned 3.8.3).
- Tests: `bun test tests/game/` plus the DB-less integration tests
  (`tests/integration/bot-6*`, `bot-7*`, `bot-8*`) run on auntie. Frontend bun tests
  type-check via `bun x tsc --noEmit -p frontend/tsconfig.test.json`.
- NOT gates: `bun run ci` (cannot pass on auntie — tests shell to wsl.exe, integration
  needs Docker).
- Production evidence: fresh curl reads of prod APIs, desktop bot log
  (`~/logs/bot-client-transformer.log`), DB reads/writes via
  `~/.fly/bin/fly ssh console -a wallgame` (base64-encode a bun script, run it inside
  the machine), preview-url screenshots as artifacts only. Probe harness from loops 1-3
  (POST /api/bots/play + drive the game websocket with a bun script) is proven — reuse
  it.

## Standing rails (prohibitions)

- NEVER `pkill -f` / `killall` on any box; exact PIDs only.
- NEVER scp SOURCE to the desktop; source moves by git (test DATA files are fine).
- NEVER deploy anything but a clean `git archive` of a committed sha:
  `rm -rf /tmp/wg-deploy && mkdir -p /tmp/wg-deploy && git archive <sha> | tar -x -C /tmp/wg-deploy && cd /tmp/wg-deploy && ~/.fly/bin/fly deploy --remote-only`
- After ANY bot restart or deploy-adjacent change: a full ROUND-TRIP probe (launch a
  puzzle by puzzleId, survive >5s, play a move, bot REPLIES, resign). Attach log lines,
  `/api/bots` listings and 0-move probes are all blind to a dead engine.
- If `desktop-053vvpl-1` is unreachable while `desktop-053vvpl` (Windows) is up, WSL
  stopped: recovery one-liner in `info/puzzle-platform.md` §2.
- Batch engine evaluation ONLY via the sequential offline ssh driver; never bulk-pump
  the serving engine (board task 8f1cf7e3 — it segfaulted twice).
- NEVER restart `wallgame-dev-5174` while Nil is mid-game; own dev on port 5175.
- ELO paths untouched; puzzle games stay unrated.
- NEVER add wrong-move detection, correctness checks, or automated quality gating.
- Migrations: ADDITIVE ONLY. Review the generated SQL (`bun x drizzle-kit generate`)
  before deploy; migrations auto-run via fly `release_command`. Seeding and data
  backfills are MANUAL in-machine scripts, fail-closed with exact-set preflights and
  read-back assertions (`scripts/populate-puzzle-leadins.ts`, `renumber-puzzles.ts`,
  `retire-puzzles.ts` are the proven pattern).
- NEVER weaken a gate to pass; fix in-slice or park the decision for Nil.
- Bugs go on the ISOMUX TASK BOARD, not GitHub issues.
- Stop conditions: 3 consecutive gate failures on one slice → stop and summarize; any
  ambiguity about production data → ask Nil.

## Architecture decision for the loop (gate it, then hold it)

Two kinds of completion with two different trust models, stored separately rather than
merged into one table, so no fact is written twice:

- **Generated puzzles — derived, server-verified.** `games.puzzle_id` (S-ID) plus the
  existing `game_players` outcome ranks already say "this user won this puzzle". No
  completion row is written; the read is a join. Anonymous solves are the same rows
  with `user_id` NULL, which is the usage data Nil asked for, for free.
  CAUTION (reviewer, S-ID plan gate): a solve is a DECISIVE win — the human's row at
  rank 1 AND the opponent's row at rank 2. Rank 1 alone counts draws as solves,
  because `buildOutcomeRank` gives both players rank 1 when there is no winner.
- **Scripted puzzles — stored, client-asserted.** A small table mirroring
  `campaign_progress`, with a NULLABLE user id so anonymous completions accumulate as
  usage events while logged-in ones stay one row per user+puzzle (partial unique index
  where user_id is not null).

Proven substrate (measured in prod 2026-07-28, read-only): 120 finished
`custom-setup-standard` games are persisted, 38 with a logged-in human, 26 of those won
by the human. The persistence path (`persistCompletedGame`) already records exactly
what completion tracking needs — only the puzzle's identity is missing from it.

## Slice plan

- [x] **S-ID — puzzle identity on the game record.** Additive `puzzle_id` column on
      `games` (nullable, FK `saved_puzzles.id`), threaded from the server-authoritative
      puzzle launch through the game session into `persistCompletedGame`. No
      user-visible change; this is the groundwork doc §G explicitly deferred to G3.
      DONE `b784ddb`, deployed + prod-verified 2026-07-28: migration 0018 ran via
      release_command (column `text`/nullable, FK `games_puzzle_id_saved_puzzles_id_fk`
      with no-action delete, both read back from information_schema/pg_constraint);
      ROUND-TRIP probe green (puzzle game `fBlMITUq` on Generated Puzzle 1 — survived
      BGS init, human move accepted, BOT REPLIED, resigned) and its row reads back
      `puzzle_id = uN9TKDUp0T`, joining to "Generated Puzzle 1"; control ordinary bot
      game `EqX78gw7` driven to the SAME counted persistence threshold (both players
      moved, then resigned) and its row EXISTS with `puzzle_id` NULL — so the NULL is
      evidence, not a missing row.
- [x] **S-G3 — completion tracking.** Auth-gated progress read merging the derived
      generated-puzzle wins and the stored scripted completions; scripted completion
      moves off localStorage; solved markers on /puzzles for logged-in users and a
      log-in invitation for anonymous ones; anonymous completions recorded for usage.
      DONE `1820993`, deployed + prod-verified 2026-07-28: migration 0019 ran via
      release_command (scripted_puzzle_completions with NULLABLE user_id, the named
      UNIQUE constraint, and `game_players_user_outcome_idx` all read back from the
      catalogs); ROUND-TRIP probe green (game `iavSz5Y2`, bot replied); anonymous
      surface verified live — GET /progress 401, a bogus scripted id 400 "Unknown
      puzzle", a valid one 200 and the row lands with user_id NULL (one telemetry
      row from verification).
      THE RULE PROVED ON REAL DATA: over puzzle-variant games the naive rank-1 rule
      credits 71 rows and the shipped decisive rule credits 57 — a difference of
      exactly the 14 draw rows (7 drawn games x 2), so the draw bug was real and is
      excluded. Scoped to games with a puzzle_id both rules currently return 0,
      because puzzle_id only started being written at S-ID's deploy and no
      logged-in player has won one since; that is the no-backfill decision working
      as intended, not an empty query.
      EXPLAIN ANALYZE in production: the planner picks
      `game_players_user_outcome_idx` (Index Cond user_id AND outcome_rank) and
      reaches the opponent row through the existing primary key, exactly the
      design the reviewer specified; 0.49ms over 4183 games / 8366 player rows.
      Known and accepted: `games` is seq-scanned for `puzzle_id IS NOT NULL`
      (4183 rows, trivial today). If puzzle games ever grow large, a partial index
      on puzzle_id is the answer — deliberately not added now.
      STILL OPEN: Nil's authenticated walkthrough (no test account exists) — solve
      one generated and one scripted puzzle, confirm both markers appear and
      survive a reload.

      BINDING REQUIREMENTS FOR S-G3 (Project Reviewer 1, S-ID plan gate — do not
      relitigate):
      1. **A solve is a DECISIVE win, not rank 1.** `buildOutcomeRank` in
         `server/games/persistence.ts` assigns rank 1 to BOTH players when `winner`
         is absent, so "the human's row is rank 1" counts every DRAW as a solve.
         Require decisive evidence: the human's row is rank 1 AND the opponent's row
         for the same game is rank 2. Ship a draw regression test.
      2. **Index:** verify query planning for the games ⋈ game_players join; add an
         index beginning with `game_players.user_id` if the existing
         `(game_id, player_order)` primary key proves insufficient (the join can then
         reach `games` by its own primary key).
      3. **The persistence carve-out means "counted decisive puzzle wins", not every
         UI finish:** a game with `moveCount < 2` is globally treated as aborted and
         never persisted. Current generated positions have 3-6 move attack distances,
         so no legitimate one-ply puzzle exists today — but preserve an invariant or
         regression if future curation could introduce one.

- [x] **S-CAMP — the solo campaign joins the completion model** (board task
      `98a0e022`; Nil ordered it BEFORE S-G4). Campaign levels run entirely in
      the browser against a local AI, so completion is CLIENT-ASSERTED like
      the scripted puzzles and can never be server-verified — that is settled,
      not a gap. What it gained: anonymous completions recorded as usage data,
      the bounded per-IP limiter on the now-open write (the level id was
      already validated against the known set), a retry that resends a failed
      report instead of only clearing an error, and the /puzzles completion
      affordances (checkmark only, no empty circle, no duplicate chip, log-in
      invitation). Also fixed in passing: the list cached progress for five
      minutes with nothing invalidating it, so a level beaten seconds earlier
      could still show as unfinished.
      TRANSITIONAL DUAL READ — DO NOT "SIMPLIFY" IT AWAY. `campaign_progress`
      has a composite PRIMARY KEY `(user_id, level_id)`, and primary-key
      columns cannot be NULL, so it structurally cannot hold an anonymous row;
      dropping a primary key is not an additive migration. Hence a new table,
      `campaign_level_completions`, mirroring `scripted_puzzle_completions`
      (nullable user id, ONE unique constraint, NULLs distinct). Writes go
      only to the new table; `readCampaignProgress` returns the distinct union
      of BOTH tables so no existing player's markers can vanish — that covers
      the deploy-to-backfill window, an old machine finishing an in-flight
      legacy write during rollout, and a backfill that fails. This is the
      expand/migrate/contract sequence, not accidental duplication.
      CONTRACT STEP (board task `cb05c49d`, after a soak): re-run and verify
      `scripts/backfill-campaign-completions.ts`, then remove the legacy half
      of the read, and only later drop `campaign_progress`.
      DONE `fadc71e`, deployed + prod-verified 2026-07-29: migration 0020 ran
      via release_command and the catalogs read back a NULLABLE `user_id`, the
      named UNIQUE (user_id, level_id), and the cascade FK. The backfill ran
      twice (idempotent both times): 15 legacy rows / 10 users / 2 levels
      copied, every triple read back with its timestamp intact, 0 unexpected
      extras. Live checks: anonymous GET /api/campaign/progress 401, a bogus
      level 400 "Invalid level ID", an extra body key 400, a valid anonymous
      completion 200 with the row landing at `user_id` NULL (one telemetry row
      from verification — the table then held 16 rows, 15 authenticated).
      ROUND-TRIP probe green after the deploy (game `siUWmsvj` on Generated
      Puzzle 1 — survived BGS init, human move accepted, BOT REPLIED).
      STILL OPEN: Nil's authenticated walkthrough (no test account exists) —
      beat a campaign level logged in, confirm the checkmark appears
      immediately on returning to the list and survives a reload.
- [x] **S-G4 — likes / dislikes (generated puzzles only).** `puzzle_votes` table (one
      changeable row per user+puzzle), vote allowed only for a puzzle the user has
      beaten, captured on the game page right after the win notification and changeable
      afterwards from that puzzle's solved card; counts on the puzzle listing and a
      "Most liked" sort control.
      Shape: `puzzle_votes` (migration 0021) is the one table here with a NOT NULL
      user id — an anonymous vote cannot be earned, so unlike the two completion
      tables there is no telemetry case. `{value: 1 | -1 | null}`; null deletes the
      row, which is how a misclick gets undone. The earned check reuses the
      decisive-win rule rather than restating it: `puzzle-progress.ts` now holds ONE
      private query (`decisiveGeneratedSolves`) behind both
      `readSolvedGeneratedPuzzleIds` and `hasSolvedGeneratedPuzzle`, with the draw
      regression pinned against the shared path.
      Statuses: 401 anonymous, 400 malformed, 404 unknown OR retired puzzle
      (matching launch semantics — existing rows survive and return if it is
      re-enabled), 403 for a caller who has not decisively won it.
      The listing stays PUBLIC: optional auth only adds `myVote`. Counts show on
      every generated card including for visitors who cannot vote, because a "Most
      liked" sort with invisible numbers explains nothing. Sorting is client-side
      over the ~39 rows, non-mutating, with `sortIndex` as the deterministic
      tiebreak (every puzzle starts at zero, so without it sort stability decides).
      Aggregates are ONE grouped query plus at most one for the caller's own votes,
      never per card.
      WHAT THE 390px SCREENSHOT CHANGED: the vote control fits beside "Retry puzzle"
      in the desktop panel's existing fixed-height block, but NOT in the mobile
      toolbar — that bar centres its result text in an absolute layer, so at 390px
      "Nil won - Puzzle - no rating change" ran underneath the buttons. Mobile gets
      its own slim strip above the toolbar instead (the board area is measured, so
      it costs a few pixels of board rather than breaking a budget). Same lesson for
      the failure state: an inline "Not saved" sentence collided in both compact
      rows, so it is a bounded icon with `role="status"` plus screen-reader text,
      and the mobile strip swaps its own label instead of growing.
      PRE-EXISTING, deliberately untouched: at 390px the mobile toolbar's centred
      result text already slides under the Retry button after any game.
      DONE `5d43751`, deployed + prod-verified 2026-07-29: migration 0021 ran via
      release_command and the catalogs read back the composite PRIMARY KEY, both
      FKs (users cascade, saved_puzzles no-action), and
      `CHECK ((value = ANY (ARRAY['-1'::integer, 1])))`. Live: anonymous vote write
      401, anonymous vote read 401, an out-of-range value 401 (auth precedes
      validation — the 400 path is pinned by `tests/game/puzzle-vote-guards.test.ts`
      with a test identity), the public listing still 200 over all 39 puzzles with
      zeroed counts, `myVote` null, and sortIndex ascending. ROUND-TRIP probe green
      (game `0oWQL7q9` on Generated Puzzle 1 — bot replied).
      STILL OPEN: the logged-in half needs Nil, since a vote requires both auth and
      a real decisive win — beat a generated puzzle, like it from the win panel,
      flip it, clear it, and check the card shows the same vote afterwards. An
      authenticated-but-unsolved 403 can be observed in the same session.

## Loop 4 status

All five slices are shipped and production-verified: S-ID, S-G3, S-UI2 (+ its
fix-forward), S-CAMP, S-G4. Doc §G is complete. Outstanding, and neither is loop-4
scope: Nil's two logged-in walkthroughs (campaign markers, puzzle votes), and the
contract step for the campaign dual read (board task `cb05c49d`).

## Open questions parked for Nil

None — decisions 1-7 above cover the whole loop. New ambiguity about production data
or scope goes to Nil rather than being resolved in-loop.

## SLICE S-ID PICKUP (authored at loop-4 setup)

- Baseline: `7686a97` (docs-only ahead of prod `ea44def`; this slice's deploy carries
  both).
- Goal: every game created by a server-authoritative puzzle launch records WHICH puzzle
  it was, on the game record, so completion can be verified server-side later. Nothing
  else rides along — no progress reads, no UI, no votes.
- Mechanics: `server/routes/games.ts` POST `/play` already resolves the saved-puzzle row
  in its `"puzzleId" in parsed` branch (~line 513) and has the id in hand.
  `createGameSession` (`server/games/store.ts` ~464) takes an args object and builds the
  `GameSession` (~78); `persistCompletedGame` (`server/games/persistence.ts` ~91) writes
  the `games` row. Thread the id through those three points.
- Retry inherits it for free: Retry relaunches by puzzleId through the same route.
- Migration: additive nullable column; review the generated SQL before deploy.
- Tests: a persisted puzzle-launched game carries the id; an ordinary bot game persists
  NULL; the existing DB-less integration tests stay green.
- Verification: deploy, then a prod round-trip probe that launches a puzzle by id,
  plays to a finish, and reads the row back inside the fly machine showing puzzle_id set.
- Locked: no completion reads, no votes, no UI, no backfill of existing games.

## SLICE S-G3 PICKUP (authored after S-ID shipped at b784ddb)

WHAT S-ID TAUGHT:

1. **Do not reuse another feature's encoding without reading its edge cases.**
   `outcome_rank` answers "how did each player place", and rank 1 for BOTH players is
   its perfectly sensible encoding of a draw. Reading it as "did this player win" is
   what would have shipped the draw bug. Whenever S-G3 borrows an existing column,
   find the case where its meaning is not what the new feature assumes.
2. **A test for a deliberate omission must be proven non-vacuous.** The rematch test
   passes trivially if the field is simply never set anywhere. Temporarily introduce
   the behaviour you are forbidding, watch the test fail, then revert — cheap, and it
   converts an assertion into evidence.
3. **Absence-of-value evidence needs the row to exist.** Reviewer's catch: reading NULL
   proves nothing if the game was never persisted. Drive control cases to the same
   counted threshold (both players moved, counted result) before reading them.
4. **The loop-3 probe harness still runs unmodified** — launch by puzzleId, wait 6s
   past connect, submit a cat move by trying legal targets, wait for the bot's reply,
   resign. Keep that shape; a 0-move probe cannot see a dead engine.

- Baseline: `b784ddb` (+ this docs commit); production runs `b784ddb`.
- Goal (doc §G3): a logged-in player sees which puzzles they have solved, on /puzzles,
  for BOTH sets — generated (server-verified) and scripted (client-asserted).
- Generated read: join `games` (puzzle_id NOT NULL) to `game_players`, requiring a
  DECISIVE win — the user's row at rank 1 AND the opponent's row at rank 2 for the same
  game (binding requirement 1 above; ship the draw regression test). Check query
  planning and add the `game_players.user_id` index if needed.
- Scripted: new table (nullable user id, partial unique index where user_id is not
  null), an additive migration, a completion endpoint modeled on
  `server/routes/campaign.ts` (which is the existing client-asserted precedent), and
  validation of the puzzle id against the known scripted set. Anonymous writes are
  accepted for usage data — keep them cheap and consider a light rate limit.
- Frontend: `frontend/src/hooks/use-puzzle-progress.ts` is the localStorage hook to
  replace; it is consumed by `puzzles.index.tsx` (~49, `isCompleted` per card) and
  `puzzles.$id.tsx` (~32/56, `markCompleted` on solve). Anonymous visitors see no
  markers plus a log-in invitation (Nil's decision 2).
- Verification: prod round-trip probe as ever, plus a logged-in check walked through
  with Nil (there is no test account) — solve a puzzle, see the marker appear, confirm
  it survives a reload and shows on another device.
- Locked: no votes (S-G4), no backfill, no automated quality gating, additive migration
  only.

- [x] **S-UI2 — one card, both sections** (Nil's playtest feedback on S-G3, 2026-07-28,
      verbatim): the scripted cards always drew an empty circle while generated ones
      only show a checkmark once solved — drop the empty circle; the "Completed" chip
      duplicates the checkmark — remove it; make every button the width of the
      scripted "Replay"; put the scripted puzzles in three columns too.
      Since all four converge on one card, both sections render a single local
      `PuzzleCard` (reviewer: keep it local — two call sites, route-specific props)
      rather than two trees kept looking alike, per CLAUDE.md rule 4. Buttons reserve
      "Replay" width via an invisible sizing label in the same grid cell, never a
      hardcoded size (reviewer amendment: "Solve" is intrinsically narrower, so
      dropping `w-full` alone would NOT have satisfied Nil's item 3); the labels live
      in `frontend/src/lib/puzzle-action-label.ts` with a test asserting the sizing
      label stays the widest, so rewording a button fails a test instead of silently
      making the row ragged. Cards are full-height flex columns with the action at
      `mt-auto`, because scripted cards carry author+difficulty and would otherwise
      leave buttons at different heights across a grid row.
      Author line and "Difficulty: N/5" badge RETAINED — Nil called only the
      Completed chip redundant.
      FIX-FORWARD after Nil saw it in production ("the buttons look bad, the space
      is not well used at all"): the card is now HORIZONTAL — text left, action
      right-aligned and vertically centred. Stacking the button under the text left
      a small pill in the bottom-left of a ~280px card beside a wide empty strip,
      and made every card tall; the scripted section went from ~690px to ~460px of
      height. `mt-auto` is gone: a horizontal card aligns buttons by centring, so
      the amendment's goal survives without its mechanism.
      TRAP WORTH REMEMBERING: `components/ui/card.tsx` bakes `flex flex-col` into
      Card and merges with tailwind-merge, which only drops a base utility when a
      CONFLICTING one is passed. Passing `flex` alone does NOT beat `flex-col` —
      the direction must be explicit (`flex-row`), or `items-center` silently
      centres everything horizontally in a still-vertical card.
      PROCESS LESSON: I had been reasoning about layout from source and sending Nil
      screenshots I had not looked at. Headless Chrome IS installed on auntie, and
      the Read tool displays a PNG — so screenshot your own visual work to a file
      and LOOK at it before gating it. Chrome flags that work: headless,
      disable-gpu, no-sandbox, hide-scrollbars, window-size=W,H,
      virtual-time-budget=6000, screenshot=PATH, then the url.

## SLICE S-G4 PICKUP (authored after S-G3 shipped at 1820993)

WHAT S-G3 TAUGHT:

1. **A comment cannot make a property true.** Both of the reviewer's blockers were
   places where I asserted a guarantee in prose instead of establishing it: a
   "retry" that only reset mutation state, and an ordering claim ("mount is late
   enough") standing in for an ordering the server did not actually provide. When
   writing a comment that says "this is safe because X", check that X is enforced
   somewhere.
2. **Fix the server, not the client.** The freshness race was closed by making the
   bot finish path persist before broadcasting — matching every other path — rather
   than by adding client-side revalidation. Afterwards the client comment describes
   an invariant instead of a hope.
3. **No database here shapes the design, honestly.** Moving the rule out of the
   route into `server/games/puzzle-progress.ts` made the real SQL reachable by a
   container-backed test without mocking auth. Say plainly which tests cannot run
   on auntie rather than weakening them until they can.
4. **Verify a rule against production data, not just fixtures.** The naive-versus-
   decisive comparison (71 vs 57) turned "the reviewer was right in principle" into
   a measured count of rows that would have been miscredited.

WHAT S-CAMP ALSO TAUGHT (it shipped between S-G3 and this slice):

1. **A structural blocker beats a preference argument.** The campaign could not
   reuse its own table because a composite PRIMARY KEY cannot hold a NULL, and
   dropping a primary key is not additive. Checking that first turned a design
   debate into a one-line fact. Look for the constraint that decides the
   question before weighing options.
2. **Expand/migrate/contract removes the window you were about to accept.** I
   planned "read the new table, then backfill", with a short window where real
   users would see no markers; the reviewer's union read made that window,
   a failed backfill, and a mid-rollout legacy write all degrade to nothing
   visible. A transitional read needs a loud comment, a doc entry, and a
   follow-up task, or the next reader deletes it as duplication.
3. **Check for a test hook before declaring something untestable here.**
   `server/kinde.ts` honours an `x-test-user-id` header when NODE_ENV=test, so
   Hono routes are drivable directly. That moved four assertions (401 read,
   400 validation) out of the Docker-only suite and onto this box, where they
   actually run.
4. **Deleting a visual element can move everything around it.** Dropping the
   empty circle stepped completed rows' titles right by 40px, because that
   icon had been holding the column open for every row. Screenshotting the
   change and LOOKING at it is what caught it — reading the diff would not
   have.

- Baseline: `fadc71e` (+ this docs commit); production runs `fadc71e`.
- Goal (doc §G4, Nil's spec): a player who has BEATEN a generated puzzle can like or
  dislike it; one changeable vote per user and puzzle; votes stored in the DB; the
  list sortable so the most liked come first.
- Scope decisions already made (see decisions 6 and 7 above): GENERATED puzzles only;
  capture on the game page right after the win notification; also changeable later
  from that puzzle's card once solved; numeric order stays the default with a "Most
  liked" control ranking by likes minus dislikes, puzzle number as tiebreak.
- Shape: additive `puzzle_votes` table (user_id, puzzle_id, value, timestamps; one
  row per user+puzzle), an auth-gated write that REFUSES a vote for a puzzle the
  caller has not solved — reuse `readPuzzleProgress`'s decisive-win rule rather than
  restating it — vote counts on the listing, and the caller's own vote when authed.
- Watch for: the listing endpoint is currently unauthenticated and fail-closed on
  bad rows; adding per-caller vote state must not make it require auth for everyone.
- Verification: the usual round-trip probe; counts read back in the fly machine; and
  a logged-in walkthrough with Nil, since voting requires both auth and a real win.
- Locked: no automated quality gating (votes inform Nil, they do not retire
  puzzles), ELO untouched, additive migration only.

## SLICE-N PICKUPS

Authored when the previous slice commits, folding in what it taught.
