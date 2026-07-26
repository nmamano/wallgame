# Puzzle Platform - active work doc

Single source of truth for the puzzle feature: what exists, how the environment is wired,
and everything still to do. Companion to `info/puzzle-generation.md`, which is the
research narrative (how we got here, and the negative result about real-game corpora).
**This file is the one to read before picking the work up.**

Status: **playable but not a feature.** Generated candidates can be played against the
oracle in production, and Nil has confirmed the positions themselves are decent
("they all seem winnable, with a bit of thinking"). Everything else - discoverability,
retry, likes, merging with the existing puzzles - is open. Last updated 2026-07-26.

Isomux task: **638f40e6** (the only open puzzle task; everything else is folded in here).

---

## 1. The model

**A puzzle is a normal game against the oracle, from a carefully chosen position, on the
existing game page.** This is Nil's design and it supersedes the old bespoke puzzle UI.

- "Show move" is the eval engine turned on for your turn (`evaluate_position` in the bot
  protocol already returns best move plus eval).
- Seeing why a wrong move loses is the oracle punishing it by playing on. **No wrong-move
  modal, no correctness check.** If you find yourself preserving a "wrong move" detection
  path, the old model has crept back in.
- Winning is literally winning the game. This restricts puzzles to positions where a win
  is reachable, which is an accepted limitation. A possible later extension is "hold a
  winning position for X moves".
- **Nil is the filter.** Do not add automated puzzle-quality judgement, reachability
  gating, or correctness gating. Generation is cheap, so false negatives are free and
  false positives only cost him a moment.

Substrate: the `custom-setup-classic` / `custom-setup-standard` variants, which take an
explicit starting position (pawns + walls) with walls rendered **neutral/brown**. Wall
ownership is structurally unrepresentable - the wire schema is `.strict()` with no
`playerId` field.

---

## 2. Environment and setup (read this before touching anything)

### Where things run

| Piece | Where | Notes |
|---|---|---|
| Production site | Fly app `wallgame` -> https://wallgame.io | Deploys are **manual** |
| Database | Neon Postgres | `release_command = "bun run migrate"` in fly.toml |
| Official bots | **4090 desktop**, `ssh nilo@desktop-053vvpl-1` | tmux session `bot-client` |
| Bot supervisor | `~/run_transformer_bot.sh` on the desktop | restarts the client on crash |
| Bot logs | `~/logs/bot-client-transformer.log` on the desktop | NOT the tmux pane |
| Nil's playtest server | auntie, systemd --user `wallgame-dev-5174` | http://100.99.200.16:5174 |

**There is no backend on auntie.** Nothing listens on `:3000`, there is no `.env` and no
local Postgres, and the vite dev server proxies `/api` and `/ws` to a dead port. So the
5174 server renders pages but every API call fails - you cannot play a game locally
without standing up Postgres + server + a bot client pointed at it. **Testing puzzles
means deploying to production.**

`wallgame-dev-5174` runs vite with `WorkingDirectory=frontend/`, so it serves **stale**
transforms of `shared/**` until restarted. If you change anything under `shared/`, restart
that unit or you will debug ghosts. If Nil is mid-game on it, wait and ask.

### The two bots

Both run on the desktop from one client process, configured in
`official-custom-bot-client/transformer.prod.config.json` (tracked in git):

| botId | Name | Samples | Serves |
|---|---|---|---|
| `dw-transformer` | Transformer Bot (experimental) | 1000 | ordinary games |
| `dw-puzzle` | PuzzleBot | 5000 (parallel 128) | puzzles |

Same binary and model, different `--samples`. The engine's sample count is **process
global** (`bgs_engine_main.cpp` sets `config.samples_per_move = FLAGS_samples` once), which
is why two processes rather than a per-session override: teaching the engine that
"custom-setup means think harder" would push product knowledge into a layer that has no
business knowing what a puzzle is.

Restarting the bots (needed after a config or engine change):

```
ssh nilo@desktop-053vvpl-1
tmux kill-session -t bot-client
tmux new-session -d -s bot-client -n bot-client "bash ~/run_transformer_bot.sh"
# confirm: grep "Successfully attached" ~/logs/bot-client-transformer.log
# and: /api/bots?variant=custom-setup-standard lists dw-puzzle
# and REQUIRED since 2026-07-26: a full round-trip probe (launch a puzzle,
# survive >5s past connect, play a move, get the bot's reply, resign).
```

**The attach line and /api/bots listings are BLIND to a dead engine.** Incident
2026-07-26: the dw-puzzle engine segfaulted (exit 139, ~21:28Z, ordinary
serialized traffic — see board task 8f1cf7e3) while the CLIENT stayed attached
and listing; every puzzle game was created normally and then insta-aborted on
the failed engine session start, for ~103 minutes, silently. 0-move probes
also cannot see this (they resign before the engine is exercised) — only a
round-trip probe (bot actually replies to a move) proves engine health.

No kill-to-start gap is needed (the 15s rule is retired). Since `0c197b6` the server's
teardown is connection-scoped and deferred: a stale connection's close event cannot wipe
a newer attach with the same clientId, and a dropped client gets a 30s grace window
(`BOT_DISCONNECT_GRACE_MS`) in which its ACTIVE GAMES SURVIVE - on reattach the server
rebuilds each game's engine session and play continues (verified in prod: a puzzle game
survived a mid-game client kill+restart, game `0Sfsq10b`). During grace the bots are
hidden from listings, cannot start new games, and their seats show disconnected. If the
client stays down past the grace window, the games are resigned as before. Routine 1006
websocket blips therefore no longer resign live games.

Never use `pkill -f` on either box - on auntie it matches the isomux office server and
takes the whole office down. Capture an exact PID instead.

### Engine builds

Built on the desktop, never on auntie (no CUDA/folly there). Source reaches the desktop by
**git only** - commit, push, `git pull` on the desktop. Never scp.

```
cd ~/nil/wallgame/deep-wallwars/build-tests && nice -n15 make -j6 deep_ww_bgs_engine
```

`build-tests/` builds the bot engine; `build-puzzle/` builds `deep_ww` (the analysis
binary). **Nothing in CI compiles the C++** - `bun run build` and eslint are TypeScript
only. That is how a missing `#include <folly/Overload.h>` reached production and made the
engine unbuildable while the server already knew about the new variants. Worth closing.

### Deploying

```
rm -rf /tmp/wg-deploy && mkdir -p /tmp/wg-deploy
git archive <sha> | tar -x -C /tmp/wg-deploy
cd /tmp/wg-deploy && ~/.fly/bin/fly deploy --remote-only
```

Clean export so another agent's uncommitted work never ships. fly CLI is authenticated on
auntie. `bun run ci` **cannot** pass on auntie: `bun run test` shells to `wsl.exe` and the
integration tests need Docker. Verify with `bun run build` (0 TS errors) and
`bun x eslint .`. prettier is pinned (3.8.3) and the repo formatted once (`6d08c66`);
`bun x prettier --check .` must stay clean.

---

## 3. What exists

Commits, newest last: `c25a132`, `1250597` (custom-setup variants, authored turn state),
`94c989b` (candidate launcher), `a5abd94` (standard generation + puzzle framing),
`24e22d3` (PuzzleBot + variant naming), plus the puzzle-name banner commit.

- **Curation state (loop 3 S-COPY `3636107`, renumbered in S-P2):** the original
  Generated Puzzle 1 and 6 are RETIRED (`enabled=false`, Nil: too easy) — 39 live.
  S-P2 renumbered the ENABLED rows contiguously (display names are presentation;
  identity is `source_fingerprint`): **old 2–5 → new 1–4, old 7–41 → new 5–39**
  (disabled rows keep their historical names). Nil's ratings in NEW numbers:
  pool good overall; **1, 2, 8, 9 good** (were 2, 3, 10, 11); **6, 7 excellent**
  (were 8, 9). Retire future rejects with
  `fly ssh console -a wallgame -C "bun scripts/retire-puzzles.ts '<current display name>' ..."`
  — it matches names among ENABLED rows only and renumbers survivors in the same
  transaction, so numbers stay continuous.
- **Saved puzzles (`3d3a318`, S-G1):** the 41 filtered candidates are PERSISTED in the
  `saved_puzzles` table as named entities ("Generated Puzzle 1..41"), seeded manually
  inside the fly machine (`bun /app/scripts/seed-puzzles.ts`, idempotent via the UNIQUE
  mover-aware fingerprint). `GET /api/puzzles` is the read-only listing (every row
  Zod-validated fail-closed); the legacy tutorial-era CRUD route is gone (its `puzzles`
  TABLE remains, orphaned - dropping it is a future non-additive migration).
- `/generated-candidates` - still unlinked (S-G2 builds the real page); lists the
  persisted puzzles from the API and launches via the normal bot-game flow. The puzzle
  id+name ride the client game handshake (atomic pair, preserved across refresh,
  rematch, and Retry); the game banner names the puzzle from the handshake, and
  spectators/shared links see a generic "Puzzle" (by design).
- `shared/domain/generated-custom-setup-candidates.ts` - the generator
  (`findGeneratedCandidate` position-matching is DELETED per §G; `positionKey` remains
  for the verdict fingerprints).
- Game page: no rematch offer for puzzles, no match score, opponent shown as PuzzleBot at
  a nominal 3000, "Puzzle" instead of "Custom-Setup-Standard" (one shared
  `variantDisplayName`), back/exit return to the candidate list.
- Puzzle games are **unrated** and do not touch ELO (`server/routes/games.ts` ~496-507).

### Current generation heuristic (updated 2026-07-26, `3ea372e`)

- 6x6 board, **18 neutral walls**, sampled blind.
- **48 candidates; both ATTACK races (cat -> opponent's mouse, the actual goal in
  standard) are 3-6 moves through the walls.** The original generator paired each cat
  with its OWN mouse - the same "reach your mouse" misconception as the old banner
  copy - so the real races were unconstrained (measured 1..14). Fixed in S-H.
- **Engine-best-move filter (Nil's one quality rule):** a candidate is rejected when
  applying the engine's best first move improves the mover's distance to their goal by
  2 (delta -2 is the rule, whatever the move's actions are; the current seven rejected
  best moves all happened to be greedy walks). Verdicts live in
  `shared/domain/generated-custom-setup-verdicts.json`, bound to mover-aware
  fingerprints and validated fail-closed; a test replays every recorded best move.
  Current batch: 41 kept / 48. Regenerate with
  `bun scripts/filter-puzzle-candidates.ts` - an OFFLINE ssh driver on the desktop,
  strictly one request per response. **No batch/filter tooling may target the live
  production eval path or intentionally bulk-pump requests** — a filter run against it
  segfaulted the serving engine once (2026-07-26, exit 139; root cause unproven,
  concurrency implicated — parked item in plans/puzzle-feature-loop.md). This
  operational rail does not prohibit normal concurrent live games; they remain
  supported.
- **Standard** variant. This matters: the transformer has only ever seen *classic* with
  goals in the board corners, so a classic position with the home dropped anywhere is
  outside its training distribution and its play there was arbitrary. In standard the
  target is the mouse, which moves, so generated positions sit inside the distribution.
- Both races **3-6 moves**, measured as the **true path length through the walls**
  (`Grid.distance`), with walls placed first. An earlier version used Manhattan distance
  and placed walls afterwards, so a "4-move race" could be a pawn sealed off entirely -
  that produced nonsense play and probably the engine hang in game `7y7LrnoN`.
- Deterministic per index; 32 candidates; alternating which side the human plays.

No quality filter is applied. The positions being decent is currently a property of
"6x6, 18 walls, short races", not of selection.

---

## 4. Open work

Items A, B, C, D, and F were fixed 2026-07-26 (slice loop, `plans/puzzle-bugs-loop.md`,
commits `9ea1062`..`2b4a0c0`, reviewed by Project Reviewer 1) - summary in section 4bis.

### E. Bug: takeback does not work

`server/games/bgs-store.ts` has a full takeback-replay path for bot games, so this is a
bug and not a missing feature. Untested hypothesis: the replay rebuilds the BGS session
from the standard initial state rather than the authored one, or the seeded partial turn
breaks it.

### 4bis. What the 2026-07-26 fixes established (A, B, C, D, F)

- **A (banner on desktop):** the banner stack (puzzle/spectator/replay) is one render
  helper both layout trees call; desktop carries "Back to puzzles" inside the puzzle
  banner (its nav is the global site nav). `9ea1062`.
- **B (true variant registration):** bots declare exactly what they serve - PuzzleBot
  only `custom-setup-standard` - and the server does exact capability lookups
  (`botCapabilityVariant` is deleted, the id-match tiebreak too). The strict runtime
  config schema (`custom-bot-config-schema.ts`) had to learn the custom-setup keys; it
  is enforced at client config load AND server attach, so schema/server must deploy
  before the bot client restarts with a new-variant config. Puzzle evals now resolve to
  PuzzleBot as well. `fcc16d2`.
- **C (speed):** dw-puzzle runs `--samples 5000 --parallel_samples 128`; measured reply
  657ms end-to-end (was ~12s at 10k/32). The in-repo interactive preset (play.hpp) uses
  256 parallel, so 128 is conservative. `01d031d`.
- **D (retry):** a finished puzzle offers Retry where rematch would be - same authored
  config, same seat, fresh game; logic lives once in the game page controller. Works
  from the game's own config, so it does not depend on candidate resolution. `5a1090f`.
- **F (surface leakage):** root cause was `normalizeVariant()` in
  `server/db/game-queries.ts` collapsing custom-setup to standard (wrong label AND
  broken replay). It now knows the custom-setup variants, replay derives each mover
  from the game state's authored turn (half the puzzles start with player 2), and
  custom-setup games are excluded from Past Games, the random showcase, and live-games.
  Direct game URLs still work and replay correctly. `2b4a0c0`.
- **Model fact — SUPERSEDED by S-P1 (loop 3):** P1 always moves first, including in
  puzzles. A human-as-P2 puzzle now opens with the bot's scripted lead-in applied as
  REAL ply 0 (stored in `saved_puzzles.lead_in`, chosen by Nil's plausibility
  heuristic: 2-step cat advance toward the human mouse, else 2-step mouse flee from
  the human cat; no wall fallback — placed walls become owned/colored and the census
  showed 0 rows need it). Launches are server-authoritative: the client sends only
  `puzzleId` to POST /api/bots/play and the server derives config, seat, and lead-in
  from the row, fail-closed (a P2 row without a lead-in refuses to launch). Bot-log
  reading changes accordingly: a P2-puzzle session shows the human's reply at ply 1;
  an eval at ply 0 with nothing after is still an abandoned P1-puzzle game.
- **Model fact (loop 1, original wording for the record):** the OLD rule was that the
  human always moved first (authored
  turn state). A bot-log session showing an eval at ply 0 and nothing after is an
  abandoned human-first game, not an engine hang.
- **Nil confirmed all five fixes in an authenticated playtest (2026-07-26):** banner,
  back link, retry, bot speed, past-games absence, and the eval bar as a hint all work.
- **Agreed follow-ups (Nil, 2026-07-26) - BOTH DONE in `0c197b6` (loop 2, S-CX):**
  (1) the reattach race is fixed (connection-scoped teardown; stale closes and stale
  frames from a superseded connection are ignored); (2) the disconnect grace period
  exists (30s; games survive a drop and are healed by a full engine-session rebuild on
  reattach). See section 2's restart recipe for the operational consequences. Tests:
  `tests/integration/bot-7-connection-lifecycle.test.ts` (runs on auntie without
  Docker - the bot-6/bot-7 files fall back to a DB-less mode, so protocol-level
  server tests ARE runnable here despite the no-backend rule for the UI).

### G. Make it a first-class feature

The big one. Today `/generated-candidates` is **unlinked and unreachable** without typing
the URL, and there are two unrelated puzzle systems.

1. **Discoverability** - a real entry point in the site navigation.
2. **Cohesion with the existing puzzles.** `shared/domain/puzzles.ts` holds 10
   hand-authored puzzles on the old scripted model (fixed move list, wrong-move
   detection). Decide whether they migrate to play-vs-oracle or stay scripted, and how one
   puzzle list can present both. `GENERATED_PUZZLES` in
   `shared/domain/generated-puzzles.ts` is a **third**, older set from the real-game
   pipeline, deliberately not spread into `PUZZLES` - unvetted, must not ship.
3. **Completion tracking** - which puzzles a user has solved.
4. **Likes / dislikes**, per Nil's spec: logged-in users only, one vote per
   user/puzzle pair, changeable later, stored in the DB, and puzzles sortable so the most
   liked appear first. Needs a migration, an auth-gated endpoint, and UI.

**Nil's decision (2026-07-26): just give puzzles names and save them.** Generate a set,
give each a name or number, persist it under that name. Puzzles are entities, not a
deterministic function of a seed.

**Showing the name needs nothing on the game record.** The page that launched the puzzle
already knows which one it clicked, so the id can ride in the URL
(`/game/<id>?puzzle=<name>`) or in the handshake already stored client-side by
`saveGameHandshake`. Do not add a column for this.

A `puzzleId` on the game is needed only for **server-verified completion tracking**, since
a client claiming "I solved puzzle 7" is forgeable. Add it when completion tracking is
built, not before - these are two requirements and conflating them is what produced the
position-matching code below.

This replaces `findGeneratedCandidate()`, which resolves a game back to its candidate by
matching the board position. That was written to avoid touching the game schema, which was
the wrong thing to optimise for: the requirement was never "identify this position", it
was "puzzles have names". **Delete the position-matching rather than extend it.** It also
disposes of the "older games stop resolving their name" wrinkle entirely - a saved puzzle
keeps its name whatever the generator does next.

Persisting them is a prerequisite for the rest of this section anyway: votes and
completions cannot attach to something that only exists as a client-side computation.

### H. Generation heuristic: add the distance-delta rule - DONE (`3ea372e`, 2026-07-26)

Nil: *"the best move improves your distance to the goal by at most 1, not 2"*. Note the
rule is necessarily about the ENGINE's best move - a pure path-math reading is vacuous
(two steps along any shortest path always improve the distance by exactly 2). Implemented
as the engine-best-move filter described in section 3; the other original-spec rules
(naive bot loses, single-sample bot loses) remain dropped.

### J. Copy and naming polish (Nil's playtest feedback, 2026-07-26) - DONE

Fixed in `101e073`, deployed. Kept for the record:

1. **Banner goal copy is wrong.** It says "reach your mouse before PuzzleBot reaches its
   own" - the actual goal is **catch the opponent's mouse**. And drop "A draw is a
   possible best result": a puzzle must state its goal plainly, not hedge about outcomes.
2. **Candidate-card subtext is noise.** "You play P1 · distances 4/6 · 18 walls" serves
   no player purpose - remove it.
3. **"Play against oracle" means nothing to users.** The button should say "Try" or
   similar.
4. **`synthetic-6x6-01` looks like an internal id.** Display names must be human
   ("Synthetic Puzzle 1" at minimum) - properly solved by G's named saved puzzles, but
   the display string should not leak raw ids even before that.

(Nil also flagged the absence of completion tracking - that is G.3, already scoped.)

### I. Smaller items

- Nothing compiles the C++ in CI (see section 2) - a missing include reached production.
- The bot's official token is visible in process args on the desktop and has appeared in
  an isomux room log. Low risk in a private office; rotate if wanted.
- Engine only ever emits its own best turn, so an equally good alternative has no
  representation. A ceiling on candidate quality if automated filtering ever returns.
- **PuzzleBot loses ungracefully** (Nil playtest, 2026-07-26): once the engine sees the
  position as lost, every move has equal eval and play looks random/broken. Real fix is
  engine-side tie-breaking (max resistance) in the C++ — Nil's territory. Follow-up
  filed as **isomux board task b4c2b191** (P3).

---

## 5. Things that will mislead you

- **Banner names are client-side only.** The puzzle name comes from the launching
  client's stored handshake (atomic id+name pair). Spectators, shared links, and games
  launched before S-G1 show the generic "Puzzle" label - by design, nothing is lost.
- **Do not trust `bun run ci`** on auntie, and do not chase it.
- **Do not restore** `...GENERATED_PUZZLES` into `PUZZLES`.
- There are two git stashes on auntie holding old local playtest wiring and a prettier
  reformat. Leave both; identify stashes by message, never by index.
