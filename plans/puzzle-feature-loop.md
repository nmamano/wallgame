# Puzzle feature loop (loop 2) — standing orders + slice handoffs

Re-read this file at the start of every iteration. Conversations compact; this file does
not. Companions: `info/puzzle-platform.md` (model, environment, open items - THE doc to
read first) and `plans/puzzle-bugs-loop.md` (loop 1's record: what shipped, what it
taught, the parked queue). Loop 1 fixed bugs A-D, F and the J copy polish; this loop
builds the feature.

## North star

Generated puzzles become a real feature: takeback works, generation enforces Nil's
quality rule, puzzles are named persisted entities, one discoverable puzzles page
presents both puzzle sets, and the bot connection lifecycle no longer resigns live games
on routine websocket blips.

## Nil's decisions already made (do not re-ask)

- Puzzle set is FLUID: persist the generated batch with auto-names; Nil pokes at it
  before making it official, and the H heuristic + (future) like/dislike sorting are the
  quality insurance. Over time disliked puzzles get retired and new ones added. Do NOT
  add automated quality gating - Nil is the filter.
- The 10 hand-authored scripted puzzles STAY scripted for now, but must be reachable
  from the same puzzles page as the generated set. Page format/layout is the agent's
  call, optimized for easy navigation.
- Loop size similar to loop 1 (5 slices). G3 (completion tracking) and G4
  (likes/dislikes) are DEFERRED to loop 3 - do not pick up.
- Reviewer: Project Reviewer 1 (`agent-1780864878869-eq7t`), plan-gate + diff-gate per
  slice, commit only on sign-off. No other agents.
- Autonomy: push + deploy to production autonomously per slice; bot restarts anytime
  (15s gap rule); login-required verification = walk Nil through it (no test account).

## Process per slice

plan → Reviewer plan-gate → implement → always-run gates → Reviewer diff-gate →
sign-off → ONE focused commit (tick the checkbox in it) → push → deploy / restart as the
slice requires → production verification → author the next slice's pickup (with a "what
the previous slice taught" block). Production verification is post-commit; if it fails,
fix forward before the next slice. While waiting on the reviewer, end the turn with a
~20-25 min fallback wakeup; the reply is the real wake signal.

## Gates per slice

- `bun run build` — 0 TS errors (frontend); server/shared changes ALSO need
  `bun x tsc --noEmit -p tsconfig.json` (ignore the CMake-artifact noise under
  minimax-engine/build_release - those are not TypeScript files).
- `bun x eslint .` — clean.
- prettier on touched files only, NEVER repo-wide.
- NOT gates: `bun run ci` (cannot pass on auntie), anything a UI merely appears to show.
- Production evidence: fresh curl reads of prod APIs, desktop bot log
  (`~/logs/bot-client-transformer.log`), DB reads via
  `~/.fly/bin/fly ssh console -a wallgame` (base64-encode a bun script, run inside the
  machine), preview-url screenshots as artifacts only. The probe harness from loop 1
  (create a real game via POST /api/bots/play + drive the game websocket with a bun
  script) is proven - reuse it; keep probe games at 0 moves where possible (they never
  persist) and resign them.

## Standing rails (prohibitions)

- NEVER `pkill -f` / `killall` on any box; exact PIDs only.
- NEVER scp SOURCE to the desktop; source moves by git (test DATA files are fine).
- NEVER run repo-wide prettier.
- NEVER restore `...GENERATED_PUZZLES` into `PUZZLES` (that third stale set stays dead).
- NEVER touch the two auntie stashes or the desktop phase0a stash.
- NEVER deploy anything but a clean `git archive` of a committed sha:
  `rm -rf /tmp/wg-deploy && mkdir -p /tmp/wg-deploy && git archive <sha> | tar -x -C /tmp/wg-deploy && cd /tmp/wg-deploy && ~/.fly/bin/fly deploy --remote-only`
- NEVER restart `wallgame-dev-5174` while Nil is mid-game; own dev on port 5175.
- NEVER add wrong-move detection, correctness checks, or automated puzzle-quality
  gating.
- Bot restart recipe: kill tmux `bot-client`, WAIT 15s (reattach race), start
  `bash ~/run_transformer_bot.sh` in tmux, then verify BOTH the attach log line AND that
  `/api/bots?variant=custom-setup-standard` lists dw-puzzle.
- Migrations ARE allowed this loop (G1 needs one). Extra care: migrations run
  automatically on deploy via fly release_command; review the generated SQL before
  deploying, additive-only (no drops/renames of existing columns).
- NEVER weaken a gate to pass; fix in-slice or park the decision for Nil.
- Stop conditions: 3 consecutive gate failures on one slice → stop and summarize; any
  ambiguity about production data → ask Nil (he is reachable).

## Slice plan

- [ ] S-E — takeback works in puzzle (custom-setup) bot games
- [ ] S-CX — connection lifecycle: fix the reattach race AND add a disconnect grace
      period (delay clientId cleanup, re-bind sessions on prompt reattach) - one code
      path, server-side. Nil approved both.
- [ ] S-H — generation rule: keep a candidate only if the best first move improves the
      mover's true distance to goal by at most 1 (filters "just walk at your mouse"
      positions). Nil's one quality rule; the dropped rules (naive bot loses, etc.) stay
      dropped.
- [ ] S-G1 — puzzles become named persisted entities: DB table + migration, generate a
      batch with the H rule, auto-names, launch-by-id; DELETE findGeneratedCandidate and
      the position-matching (banner name rides the URL or handshake - doc §G says
      nothing goes on the game record for display)
- [ ] S-G2 — one puzzles page: nav entry, presents the 10 scripted puzzles AND the
      persisted generated set; format optimized for navigation (agent's call)

## Deferred / parked

- G3 completion tracking, G4 likes/dislikes → loop 3 (needs G1's persisted ids).
- I-items: CI for the C++/bot-client (7 pre-existing client tsc errors in dumb-bot.ts +
  a fixture), bot token rotation, engine alt-move representation.
- Parked-for-Nil from loop 1 (see plans/puzzle-bugs-loop.md): none remain active -
  the resignation-policy and reattach questions became S-CX; probe games deleted.

## Resources / what loop 1 taught (compressed)

- Environment: NO backend on auntie - testing means deploying to production. Bots run on
  the 4090 desktop (`ssh nilo@desktop-053vvpl-1`), source reaches it by git pull only.
  Engine flags live in `official-custom-bot-client/transformer.prod.config.json`
  (dw-puzzle: 5000 samples / 128 parallel).
- In puzzles the HUMAN always moves first (authored turn state in
  `config.variantConfig.turn`). A bot-log eval at ply 0 with nothing after = abandoned
  game, not a hang.
- The strict runtime bot-config schema (`shared/contracts/custom-bot-config-schema.ts`)
  is enforced at client config load AND server attach → schema-affecting server changes
  deploy BEFORE the bot client restarts.
- Replay assembly (`server/db/game-queries.ts` assembleReplayGame) now derives each
  mover from `replayState.turn` - S-E's takeback fix likely needs the same authored-
  state/authored-turn treatment in `server/games/bgs-store.ts` (doc E's hypothesis).
- TypeScript-level acceptance ≠ runtime-schema acceptance: verify Zod/strict schemas
  empirically before assuming a new key/variant flows through.
- The reviewer catches real bugs - give the plan-gate real detail; it pays.

## SLICE-E PICKUP (authored at loop-2 setup)

- Baseline: 101e073.
- Goal: takeback works in a puzzle game vs PuzzleBot.
- Doc's untested hypothesis (E): `server/games/bgs-store.ts` has a full takeback-replay
  path for bot games; it may rebuild the BGS session from the STANDARD initial state
  rather than the authored one, or the seeded partial turn breaks it. Loop 1's evidence
  makes this very plausible: a session log showed AbJciKHX get "Ending game session"
  immediately followed by "Starting game session" with the SAME id and different moves -
  that is the takeback replay rebuilding the session.
- First step: reproduce empirically with the probe harness (launch puzzle, play a human
  move via dummy-ai, request takeback over the game websocket, observe bgs-store logs
  and the desktop client log), THEN read the replay path with the failure in hand.
- Verification: scripted probe performs a takeback in a real prod puzzle game and the
  game continues correctly (bot answers the replayed position); an ordinary bot game
  takeback still works (regression).
- Locked: no wrong-move anything; takeback UI already exists - this is a server fix.

## SLICE-N PICKUPS

Authored when the previous slice commits, folding in what it taught.
