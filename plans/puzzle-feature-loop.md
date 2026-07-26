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
- Prettier is pinned (3.8.3) and the repo formatted once (`6d08c66`); `prettier --check .`
  must stay clean.
- NEVER restore `...GENERATED_PUZZLES` into `PUZZLES` (that third stale set stays dead).
- NEVER touch the two auntie stashes or the desktop phase0a stash.
- NEVER deploy anything but a clean `git archive` of a committed sha:
  `rm -rf /tmp/wg-deploy && mkdir -p /tmp/wg-deploy && git archive <sha> | tar -x -C /tmp/wg-deploy && cd /tmp/wg-deploy && ~/.fly/bin/fly deploy --remote-only`
- NEVER restart `wallgame-dev-5174` while Nil is mid-game; own dev on port 5175.
- NEVER add wrong-move detection, correctness checks, or automated puzzle-quality
  gating.
- Bot restart recipe (15s gap RETIRED by S-CX): kill tmux `bot-client`, start
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
- [x] S-CX — connection lifecycle: fix the reattach race AND add a disconnect grace
      period (delay clientId cleanup, re-bind sessions on prompt reattach) - one code
      path, server-side. Nil approved both. DONE `0c197b6`, deployed + prod-verified
      (zero-gap restart with correct listings; live game `0Sfsq10b` survived a mid-game
      client kill+restart; race/takeback/ordinary probes green). 15s-gap rule retired.
- [x] S-H — generation rule: keep a candidate only if the best first move improves the
      mover's true distance to goal by at most 1 (filters "just walk at your mouse"
      positions). Nil's one quality rule; the dropped rules (naive bot loses, etc.) stay
      dropped. DONE `3ea372e`, deployed + verified (live game on a new candidate, page
      screenshot). ALSO fixed en route: the generator paired each cat with its OWN mouse
      (defense geometry); real attack races measured 1..14. Now both ATTACK races are in
      [3,6]; 48 candidates; engine filter kept 41 (all 7 rejections delta -2). Verdicts
      committed with mover-aware fingerprints; regenerate with
      scripts/filter-puzzle-candidates.ts (OFFLINE ssh driver — see parked item below).
- [ ] S-G1 — puzzles become named persisted entities: DB table + migration, generate a
      batch with the H rule, auto-names, launch-by-id; DELETE findGeneratedCandidate and
      the position-matching (banner name rides the URL or handshake - doc §G says
      nothing goes on the game record for display)
- [ ] S-G2 — one puzzles page: nav entry, presents the 10 scripted puzzles AND the
      persisted generated set; format optimized for navigation (agent's call)

## Deferred / parked

- PARKED FOR NIL (engine concurrency defect, found 2026-07-26 during S-H): a filter
  run against the LIVE production eval path segfaulted the serving engine (exit 139;
  PuzzleBot down until a client restart). Concurrent/load-shaped evaluation is
  implicated but the segfault's exact root cause is UNPROVEN. Independently
  reproduced: bulk-pumping stdin requests deadlocks the engine — bgs_engine_main.cpp
  schedules request handlers on its thread pool and blockingWaits coroutines ON THE
  SAME POOL (~line 283), starvation by construction. All 48 candidate positions
  evaluate cleanly when driven strictly sequentially, which strongly rules against
  these sampled positions as the trigger (though not position-independence
  universally). Operational rail until Nil addresses the engine: no batch/filter
  tooling may target the serving engine or intentionally bulk-pump requests — use the
  strictly sequential offline ssh driver (reviewer-mandated). This operational rail
  does not prohibit normal concurrent live games; they remain supported.
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

STATUS (2026-07-26, in progress): the doc's hypothesis is REFUTED — four scripted prod
probes (simple, deep-replay, mid-think, instant-resubmit takebacks) all pass; the server
takeback path is healthy and buildBgsConfig already uses the authored position. What the
probing DID find and this slice fixed (reviewer plan+diff sign-off): a game-start race —
a human first move landing while the initial eval is in flight made the bot play its
stale ply-0 best move, desyncing the engine until a forced resignation (repro: prod game
KMenTASH). Fix: sync guard in executeBotTurnV3 (bgs.currentPly must equal history
length); deterministic regression in tests/integration/bot-6-bgs-init-race.test.ts
(runs WITHOUT Docker on auntie via a DB-less fallback — protocol-level integration tests
ARE runnable here). Checkbox stays open until Nil describes what "takeback does not
work" looked like for him (asked in chat; three candidate explanations listed there).

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

## SLICE-CX PICKUP (authored after S-E's race fix shipped at 4d96f6e)

What S-E taught: (1) protocol-level integration tests RUN ON AUNTIE — the bot-6 test's
beforeAll falls back to a placeholder DATABASE_URL when no container runtime exists
(fallback is limited to the known missing-runtime errors; everything else rethrows), so
server lifecycle changes can be tested deterministically here with the mock bot-client
harness. Reuse that pattern. (2) Deterministic race tests: hold a protocol response to
keep the window open instead of sleeping. (3) Ply-count comparisons are not content
comparisons — sync checks must compare against the definitive history, a theme likely
to recur in reattach handling. (4) Production probes confirmed the sync guard fires in
prod (game ujKm0dvM) and all four takeback scenarios plus ordinary bot games stay green.

- Baseline: 4d96f6e.
- Goal (Nil approved both, one server-side code path): fix the bot-client reattach race
  AND add a disconnect grace period. Today: (a) registrations are keyed by clientId and
  the OLD connection's disconnect cleanup can run AFTER a new attach, silently wiping
  the fresh registration (loop 1 parked item 1; the reason for the 15s restart gap);
  (b) handleBotClientDisconnect resigns ALL of a client's active games the instant its
  websocket drops, though 1006 drops are routine and the client's engine and sessions
  survive them.
- Direction: delay clientId cleanup (grace period) and re-bind live sessions when the
  client reattaches promptly; make cleanup connection-scoped so a stale connection's
  teardown can never destroy a newer attach. Design details are the slice plan's job.
- Key files: server/routes/custom-bot-socket.ts (attach handling,
  handleBotClientDisconnect ~1150-1200), server/games/custom-bot-store.ts.
- Verification: bot-6-style deterministic tests (fast reattach keeps registration; games
  survive a drop + prompt reattach; grace expiry still resigns; ordinary attach/detach
  unaffected) + production: restart the desktop bot WITHOUT the 15s gap and confirm
  /api/bots listings survive, and a live probe game surviving a simulated drop.
- Rollout: server deploy only; a desktop bot restart afterwards exercises the new path
  (and, if the fix works, retires the 15s-gap rule — update info/puzzle-platform.md).
- Locked: no bot-client (desktop) code changes; no protocol version bump; ELO untouched.

## SLICE-H PICKUP (authored after S-CX shipped at 0c197b6)

What S-CX taught: (1) the autopilot mock-bot pattern (auto-answer protocol requests,
transcript + predicate waits) is the right harness for flows whose message order varies;
(2) some identity guards have no black-box test seam (Bun delivers force-close events
synchronously) - when so, keep the guard small, comment the exact scenario, and say so
at the diff gate rather than writing a probabilistic test; (3) prettier keeps trying to
rewrap three pre-existing long lines in game-socket.ts and one in custom-bot-socket.ts -
revert those hunks before every diff gate; (4) the deploy bounce itself is a live
drop+reattach exercise now, and the desktop restart needs no gap.

- Baseline: 0c197b6 (+ the docs commit).
- Goal (doc §H, Nil's one quality rule): generation keeps a candidate only if the best
  first move improves the mover's true distance to goal by AT MOST 1 (drops positions
  whose answer is simply walking at the target). The dropped rules (naive bot loses,
  single-sample bot loses) STAY dropped; no other automated quality gating.
- Mechanics: "best first move" needs the engine's verdict per candidate, and engines
  live on the desktop - but the rule as stated is about the MOVER's distance delta,
  computable in TypeScript: for the side to move, compare Grid.distance(cat, target)
  before and after each legal first move... CAREFUL: read the rule as Nil stated it -
  "the best move improves your distance to the goal by at most 1, not 2". The natural
  cheap formalization: a candidate is BAD if a single first move exists that improves
  the mover's true distance by 2 (i.e. a 2-step walk toward the mouse is the best
  thing to do). Whether "best move" means engine-best or distance-best is the ONE open
  interpretation question - decide with the reviewer at plan gate; if engine-best is
  required the slice needs the desktop analysis binary and becomes a different shape.
  Lean: distance-based (cheap, deterministic, in generated-custom-setup-candidates.ts,
  runs at generation time), argue it at plan gate.
- The filter changes which candidates the deterministic generator emits, so candidate
  indices shift - acceptable (G1 will persist puzzles as entities anyway; doc §5 says
  the "older games stop resolving their name" wrinkle is cosmetic).
- Verification: unit test the predicate on hand-built positions (a "walk 2 at the
  mouse" position is rejected, a wall-blocked one is kept); regenerate the 32 and spot
  check counts; deploy; Nil's playtest judges quality (he is the filter).
- Locked: no automated winnability/quality gating beyond this one rule; standard
  variant; 6x6/18 walls/3-6 races unchanged.

## SLICE-G1 PICKUP (authored after S-H shipped at 3ea372e)

What S-H taught: (1) verify domain-level assumptions empirically before building on
them — the "races" the generator constrained were the wrong pairs entirely, and the
distance-based reading of the quality rule was provably vacuous; (2) the engine is an
offline-drivable oracle now (scripts/filter-puzzle-candidates.ts) but must NEVER see
concurrent/bulk requests (parked item); (3) applyGameAction is immutable — it returns
the next state; (4) committed artifacts want fail-closed fingerprint validation and a
test that replays every record.

- Baseline: 3ea372e (+ the docs commit).
- Goal (doc §G1, Nil's decision "just give puzzles names and save them"): puzzles
  become named persisted entities. DB table + ADDITIVE migration (review generated SQL
  before deploy; fly release_command auto-runs it); persist the current 41-survivor
  batch with auto-names; the puzzles page lists from the DB and launches by id; DELETE
  findGeneratedCandidate and the position-matching (the banner name rides the URL or
  the client-side handshake — doc §G says nothing goes on the game record for display).
- Design questions for the plan gate: table shape (id, display name, config JSONB,
  createdAt, source/provenance), naming scheme, list/get API endpoints (Zod contracts
  in shared/contracts/), whether the generated-candidates page becomes the persisted
  list or S-G2 replaces it wholesale.
- Locked: no completion tracking, no votes (loop 3); no puzzleId column on games;
  additive-only migration; the verdict machinery stays (it filters FUTURE batches
  before they are persisted).

## SLICE-N PICKUPS

Authored when the previous slice commits, folding in what it taught.
