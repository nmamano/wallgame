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
  existing `game_players.outcome_rank = 1` already say "this user won this puzzle". No
  completion row is written; the read is a join. Anonymous solves are the same rows
  with `user_id` NULL, which is the usage data Nil asked for, for free.
- **Scripted puzzles — stored, client-asserted.** A small table mirroring
  `campaign_progress`, with a NULLABLE user id so anonymous completions accumulate as
  usage events while logged-in ones stay one row per user+puzzle (partial unique index
  where user_id is not null).

Proven substrate (measured in prod 2026-07-28, read-only): 120 finished
`custom-setup-standard` games are persisted, 38 with a logged-in human, 26 of those won
by the human. The persistence path (`persistCompletedGame`) already records exactly
what completion tracking needs — only the puzzle's identity is missing from it.

## Slice plan

- [ ] **S-ID — puzzle identity on the game record.** Additive `puzzle_id` column on
      `games` (nullable, FK `saved_puzzles.id`), threaded from the server-authoritative
      puzzle launch through the game session into `persistCompletedGame`. No
      user-visible change; this is the groundwork doc §G explicitly deferred to G3.
- [ ] **S-G3 — completion tracking.** Auth-gated progress read merging the derived
      generated-puzzle wins and the stored scripted completions; scripted completion
      moves off localStorage; solved markers on /puzzles for logged-in users and a
      log-in invitation for anonymous ones; anonymous completions recorded for usage.
- [ ] **S-G4 — likes / dislikes (generated puzzles only).** `puzzle_votes` table (one
      changeable row per user+puzzle), vote allowed only for a puzzle the user has
      beaten, captured on the game page right after the win notification and changeable
      afterwards from that puzzle's solved card; counts on the puzzle listing and a
      "Most liked" sort control.

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

## SLICE-N PICKUPS

Authored when the previous slice commits, folding in what it taught.
