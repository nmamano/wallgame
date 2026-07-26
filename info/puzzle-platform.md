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
| `dw-puzzle` | PuzzleBot | 10000 | puzzles |

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
```

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
`bun x eslint .`. prettier is not pinned and ~37 files fail `--check` - format only files
you touch, never repo-wide (task ee6cf406).

---

## 3. What exists

Commits, newest last: `c25a132`, `1250597` (custom-setup variants, authored turn state),
`94c989b` (candidate launcher), `a5abd94` (standard generation + puzzle framing),
`24e22d3` (PuzzleBot + variant naming), plus the puzzle-name banner commit.

- `/generated-candidates` - unlinked route, 32 deterministic 6x6 positions, one click
  launches a normal game against PuzzleBot.
- `shared/domain/generated-custom-setup-candidates.ts` - the generator, plus
  `findGeneratedCandidate()` which resolves a game back to its candidate by matching the
  position (deterministic generation means the position identifies itself; no field was
  added to the game schema to carry a playtest label).
- Game page: no rematch offer for puzzles, no match score, opponent shown as PuzzleBot at
  a nominal 3000, "Puzzle" instead of "Custom-Setup-Standard" (one shared
  `variantDisplayName`), back/exit return to the candidate list.
- Puzzle games are **unrated** and do not touch ELO (`server/routes/games.ts` ~496-507).

### Current generation heuristic

- 6x6 board, **18 neutral walls**, sampled blind.
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

### A. Bug: the puzzle banner and back link only exist on mobile

`frontend/src/routes/game.$id.tsx` has **two separate layout trees** - a mobile early
return around line 261 and "Desktop Layout" from about line 505. The puzzle banner (which
names the candidate and states the goal) and the "Back to puzzles" link were only added to
the mobile branch, so on desktop Nil sees neither. This is the duplicated-render-tree trap
in CLAUDE.md; the fix should probably hoist the shared chrome rather than paste it twice.

### B. Bug: PuzzleBot resigns in ordinary games

Game `ixQQelmh`, a Classic match against PuzzleBot, ended in a resignation. PuzzleBot is
reachable from the normal bot picker at all because bot discovery collapses
`custom-setup-*` onto the base variant (`custom-setup-store.ts` uses
`botCapabilityVariant(variant)`), so the puzzle bot has to declare `standard`/`classic` to
be discoverable, and the puzzle page then picks it by **string match on the bot id**
(`bot.id.includes("puzzle")` in `generated-candidates.tsx`). That is a hack.

To be clear about what is and is not broken: officiality **is** enforced - the page filters
`isOfficial` before the id match, both bots are registered official, and the server
re-checks official-only at `POST /bots/play`. An unofficial bot named "puzzle" cannot
hijack anything. The problem is narrower: because both bots end up declaring the same
variants, "the official bot for this variant" is ambiguous, and the id match is the
tiebreak.

**Nil's fix, agreed: the bot client should register the true variant it serves.** Then the
two bots are registered for genuinely different variants, "pick the official bot for that
variant" becomes unambiguous everywhere, and the id match disappears. It also keeps
PuzzleBot out of the normal picker, which is where the Classic resignation came from.
Investigate the resignation separately in case it is a real engine fault at 10k samples
rather than a consequence of PuzzleBot being offered for a game it was never meant to
serve.

### C. Lower PuzzleBot to 5k samples, and check parallelism

10k is too slow in play. Drop `--samples` to 5000 in
`transformer.prod.config.json`. Also confirm how many samples run concurrently -
`--parallel_samples 32` today - and consider raising it, since higher parallelism buys
throughput without lowering strength.

### D. Retry after failing a puzzle

Still missing. Agreed implementation: **relaunch the same candidate into a fresh game**.
No state rewinding, no server work - the candidate config is already client-side.

### E. Bug: takeback does not work

`server/games/bgs-store.ts` has a full takeback-replay path for bot games, so this is a
bug and not a missing feature. Untested hypothesis: the replay rebuilds the BGS session
from the standard initial state rather than the authored one, or the seeded partial turn
breaks it.

### F. Bug: puzzle attempts pollute Past Games

Puzzle games appear on the Past Games page, are labelled with the wrong variant, and
clicking one fails with "no game saved". They should not appear there at all. Nil's note:
"there may be other bugs, who knows" - worth a sweep of the surfaces that enumerate games
(history, profile, rankings) for custom-setup leakage.

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

### H. Generation heuristic: add the distance-delta rule

Nil: *"the best move improves your distance to the goal by at most 1, not 2"*. This
filters out positions whose answer is simply walking at your mouse. It is the one quality
rule he wants; the others from the original spec (naive bot loses, single-sample bot
loses) remain dropped.

### I. Smaller items

- Nothing compiles the C++ in CI (see section 2) - a missing include reached production.
- The bot's official token is visible in process args on the desktop and has appeared in
  an isomux room log. Low risk in a private office; rotate if wanted.
- Engine only ever emits its own best turn, so an equally good alternative has no
  representation. A ceiling on candidate quality if automated filtering ever returns.

---

## 5. Things that will mislead you

- **"Older games stop resolving their name."** `findGeneratedCandidate` matches a game's
  position against a freshly generated candidate set. Games created before a generator
  change no longer match any current candidate, so their banner falls back to a generic
  "Puzzle" label. Nothing is lost; the position and the game are intact. It is only a
  label, and it is arguably correct - that game is no longer one of the current candidates.
- **Do not trust `bun run ci`** on auntie, and do not chase it.
- **Do not restore** `...GENERATED_PUZZLES` into `PUZZLES`.
- There are two git stashes on auntie holding old local playtest wiring and a prettier
  reformat. Leave both; identify stashes by message, never by index.
