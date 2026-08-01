# Puzzle Platform - active work doc

Single source of truth for the puzzle feature: what exists, how the environment is wired,
and everything still to do. Companion to `info/puzzle-generation.md`, which is the
research narrative (how we got here, and the negative result about real-game corpora).
**This file is the one to read before picking the work up.**

Status: **shipped as a first-class feature** (loops 1-4, Nil-playtested through
loop 4's S-UI2).
The /puzzles page presents 10 scripted + 33 generated puzzles (named persisted
entities, continuously numbered, launched server-authoritatively by puzzleId);
P1 always moves first — human-as-P2 puzzles open with the bot's scripted
lead-in as real ply 0 — and takeback, move history, Retry, and last-move
colors all work. Loop 4 (`plans/puzzle-loop-4.md`) is COMPLETE: completion tracking (S-ID,
S-G3), one card treatment (S-UI2), the solo campaign on the same completion
model (S-CAMP), and likes/dislikes (S-G4). Section G is done. Awaiting only
Nil's two logged-in walkthroughs.
Batch 2 (`plans/puzzle-batch2.md`) is COMPLETE — all five of Nil's items
shipped and production-verified 2026-07-29/30:
S-EVAL (generated puzzles must be DECISIVELY WINNING for the mover; six that
were not are retired; the filter records the engine's evaluation instead of
discarding it), S-BOTS (Superhuman Bot rename plus a non-official Easy Bot),
and S-FOLD (the landing page trimmed to two single-player cards, and the solo
campaign folded under /puzzles as its FIRST section).

**The /puzzles page is now three sections — Campaign, Handcrafted Puzzles,
Generated Puzzles — sharing ONE progress read.** `GET /api/puzzles/progress`
returns `solvedGeneratedIds`, `solvedScriptedIds` and (required)
`completedCampaignLevelIds`; it calls `readCampaignProgress` so the
transitional union over the two campaign tables stays in one place. Campaign
writes still go to `/api/campaign/complete`, and
`GET /api/campaign/progress` is kept as COMPATIBILITY surface for browsers on
an older bundle — do not delete it merely because nothing in the repo calls
it. `/solo-campaign` redirects to `/puzzles`; levels still play at
`/solo-campaign/$id`.
Last updated 2026-07-29.

Isomux task: **638f40e6** (umbrella; loop-4 scope). Related bot/engine ops
tasks: 8f1cf7e3 (engine concurrency, caused two incidents), b4c2b191
(graceful losing), 87e711cb (WSL/bot autostart) — all Nil-side or unassigned.

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

### Driving the real app in a browser (S-BATCH1, 2026-07-29)

`scripts/browser-harness/` closes the gap the row above creates. It serves the BUILT
frontend (`frontend/dist`) with a stubbed API and drives real headless Chrome over the
DevTools protocol, so questions like "do cards arrive in waves", "does the nav bar fit at
1024px", or "does navigating back re-read progress" get measured instead of reasoned
about. Chrome is installed on auntie. See its README - it is a diagnostic tool, not a
test suite, and no gate runs it.

The lesson it exists to enforce: **an experiment proves nothing unless you can name what
it makes impossible.** The campaign example flips server-side state from the driver,
outside the browser, precisely so a checkmark cannot have come from any earlier read.

### The three configured bots

All three run on the desktop from ONE client process, configured in
`official-custom-bot-client/transformer.prod.config.json` (tracked in git).
Two are OFFICIAL; Easy Bot is deliberately not.

| botId | Name | Official | Samples | Serves |
|---|---|---|---|---|
| `dw-transformer` | Superhuman Bot | yes | 1000 | ordinary games |
| `dw-puzzle` | PuzzleBot | yes | 5000 (parallel 128), naive below -0.9 | puzzles |
| `dw-easy` | Easy Bot | **no** | 1 (no root noise), 33% naive moves | ordinary games |

Naming history: `dw-transformer` was "Transformer Bot (experimental)" until
2026-07-29 (Nil). The bot ID never changed, which is what keeps its rating and
game history attached — `built_in_bots.display_name` is re-upserted by bot id
on every attach, so a rename propagates to historical games for free.

**Easy Bot's non-official status is load-bearing, not cosmetic.** The client
withholds the official token for a bot marked `"official": false`, the server
derives `isOfficial` from that token match, and `custom-bot-store.ts` then
excludes non-official bots from the custom-setup variants and from
`findEvalBot`. So Easy Bot structurally cannot become the puzzle oracle or
serve the evaluation bar; it also simply does not advertise those variants,
which is a second independent reason.

**Easy Bot runs at ONE sample, which is what Nil asked for** ("a single sample
per move, basically just policy head"). That took an engine change: board task
`945fe1ef`. Until then `peek_best_move` needed a fully expanded two-action turn
— an expanded GRANDCHILD, which only appears once the root's best child is
visited a second time — so below roughly 100 samples the engine answered "No
legal move available" instead of playing weakly (measured FAIL at
1/2/4/8/16/32/64/96, OK at 112/128/256/1000, with `--parallel_samples` ruled out
as the variable). 128 was the smallest working number and the reason this bot
used to be pinned there.

`MCTS::peek_best_action`/`peek_best_move` now fall back to `TreeEdge::prior` —
the policy head's own probability, filled in for every legal action the moment a
node is created — whenever nothing below that point has been expanded. So one
sample gives a complete move: the first action is the edge that sample expanded
(the top prior), the second is the policy's pick in the position that follows.
`commit_to_action` deliberately does NOT fall back, so self-play and training are
untouched.

The second half of "policy only" is `--root_noise_factor 0`, also new in that
task. The engine mixes 25% Dirichlet noise into the ROOT priors by default
(`add_root_noise`), which is right for self-play exploration and wrong here: at
one sample the move would come from a policy that is a quarter noise. The flag
is per process and defaults to the old 0.25, so Superhuman Bot and PuzzleBot are
unaffected; only Easy Bot sets it to 0. Both halves are pinned together in
`tests/game/bot-config-guards.test.ts`, because dropping either one leaves a bot
that looks configured and is not.

**One sample was not enough.** Nil played it after that rollout and lost about
8-2 — "really impressive", not an easy bot. The policy head alone is simply
strong, so sample count had stopped being the lever. What ships instead (board
task `9c0ac857`, Nil's design) is `"naiveMoveRate"` on `dw-easy` in the config
file: a per-move coin flip, so that share of moves comes from the client's own
naive walk-toward-the-goal policy and the rest still come from the engine. Per
move, not per game — the bot plays well most of the time and drops the
occasional weak move, rather than being a different bot for a whole game.

Tuned by Nil playing it, which is the only calibration that counts. It went out
at 0.2; over 5 games he went 3-2 and called it still a bit too hard, so it is
now **0.33**. The 0.2 run is the evidence that the knob does what it says: 75
naive moves out of 382 Easy Bot evaluations, 19.6% observed, with no shadow
retired and no fallback to the engine for a missing naive move.

It is deliberately a WRAPPER feature, in `official-custom-bot-client`. No C++
change, no rebuild, no GPU, no transport branch: retuning the percentage is a
config edit plus a client restart. It is also invisible to the server —
`index.ts` strips `naiveMoveRate` (like `official`) before the attach message,
so the wire shape is unchanged and no deploy has to land first.

The cost is that the naive policy is STATEFUL — board, pawns, ply — and cannot
be consulted for the first time on the move it is asked to play. So a SHADOW
dumb-bot session runs alongside the engine session for the whole game:
`start_game_session` and `apply_move` fan out to both, and only
`evaluate_position` picks one. The engine stays the authority — its response is
what goes on the wire, and on a naive turn only `bestMove` is swapped while the
engine's evaluation is kept, so the eval stream stays continuous. Anything that
suggests the shadow has drifted (an apply the engine refused, an apply the
shadow refused, a ply that disagrees with the engine's, or an evaluation that
fails) retires the shadow and the game finishes on pure engine moves. The naive
path can only ever REPLACE a move the engine already produced, which is also why
a naive answer of `---` (the policy's "I am stuck") falls back to the engine
instead of passing the turn away. `tests/game/easy-bot-naive-mix.test.ts` pins
the shadow's legality against a real `GameState`.

(Internal detail — website copy must not describe sample counts, tree search, or
the naive mix.)

**PuzzleBot loses gracefully below -0.9** (`--losing_fallback
--losing_fallback_eval -0.9`, board task `b4c2b191`, Nil's own design). In a
position the search scores as
completely lost, every line loses — so the visit counts are ranking moves whose
outcomes are identical, and the winner of that ranking can look absurd to a
human. Below the threshold the move comes from `SimplePolicy`'s priors instead
(walk the cat toward the goal), taken as a policy argmax and re-asked after the
first action so the second one cannot be an illegal undo.

**The flapping is the FEATURE, so there is deliberately no hysteresis.** The
bot coasts while the human plays correctly, and snaps back to full-strength
search the instant the human errs and the eval recovers. Nil: "if the human
makes a mistake, it gets punished with full strength. that's WAI." Latching
into naive mode would delay exactly that punishment.

**Scoped to PuzzleBot only, and that is load-bearing.** Enablement is a SEPARATE
switch from the threshold, because no number can mean "off": `root_value()`
reaches exactly -1.0 whenever every sample ends in a loss, so an earlier version
that defaulted the threshold to -1 and called it disabled would have fired for
Superhuman and Easy in exactly those positions. The engine also refuses to start
with the threshold but not the switch, so a half-configured command cannot look
enabled and quietly do nothing. The eval scale is NOT calibrated and carries a
large board-size
dependent offset: a symmetric opening reads **-0.605 on 6x6, -0.827 on 8x8 and
+0.764 on native 12x10**. So on 8x8 a bot merely somewhat behind in an ordinary
game would cross -0.9 and start playing naively for no reason a player could
understand. -0.9 was sized against the real puzzle corpus instead: the 36 kept
puzzles in `shared/domain/generated-custom-setup-verdicts.json`, evaluated at
PuzzleBot's own configuration, put the BOT between -0.757 and -0.992 with a
median of -0.912, so the threshold lands on the corpus median and fires from the
first move in 21 of 36. Numbers and method in `plans/engine-cluster.md`.

Before restarting the client after any config edit, run the fail-closed
preflight: `bun scripts/validate-bot-config.ts
official-custom-bot-client/transformer.prod.config.json`. It parses with the
client's own schema and asserts bots and `engineCommands` are the same exact
set, because a bot with a MISSING command parses fine and then silently serves
the built-in dummy implementation (board task `5f302c24` covers the runtime
half of that hazard, which is not fixed).

Same binary and model, different `--samples`. The engine's sample count is **process
global** (`bgs_engine_main.cpp` sets `config.samples_per_move = FLAGS_samples` once), which
is why two processes rather than a per-session override: teaching the engine that
"custom-setup means think harder" would push product knowledge into a layer that has no
business knowing what a puzzle is.

Restarting the bots (needed after a config or engine change).

**DANGER, learned by causing it 2026-07-29: `tmux kill-session -t bot-client`
takes the whole WSL instance down when that is the ONLY tmux session.** The
tmux server exits with its last session, nothing else holds WSL open, and WSL
shuts down mid-restart — so the `tmux new-session` that follows can appear to
succeed and then vanish with the box. Symptom: ssh to
`desktop-053vvpl-1` times out and tailscale shows it offline while
`desktop-053vvpl` (the Windows side) stays online. Recovery is the
Windows-side one-liner below, which worked first try.

So ALWAYS hold the tmux server open before killing anything:

```
ssh nilo@desktop-053vvpl-1
tmux new-session -d -s keepalive 'sleep infinity'   # tmux server now survives
tmux kill-session -t bot-client
tmux new-session -d -s bot-client -n bot-client "bash ~/run_transformer_bot.sh"
```

Alternative that never touches a session at all, derived from
`~/run_transformer_bot.sh` (a `while true` supervisor that relaunches the
client 10s after it exits) but NOT YET EXERCISED: capture the client's exact
PID and kill only that, then wait ~15s for the supervisor to relaunch it with
the freshly read config. Exact PIDs only — never a `pkill -f` pattern.

Verify, in this order:

```
# 1. capture the log's byte offset BEFORE restarting, so an OLD "Engine
#    started" line cannot satisfy the check:
#      stat -c %s ~/logs/bot-client-transformer.log
# 2. after restart, read only what came after it:
#      tail -c +<offset+1> ~/logs/bot-client-transformer.log
#    expect "Engine started for bot" for ALL THREE bots, then
#    "Successfully attached with 3 bot(s)".
# 3. /api/bots?variant=standard lists Superhuman Bot and Easy Bot;
#    ?variant=custom-setup-standard lists ONLY PuzzleBot.
# 4. REQUIRED since 2026-07-26: a full round-trip probe (launch a puzzle,
#    survive >5s past connect, play a move, get the bot's reply, resign),
#    plus a second round trip against Easy Bot specifically.
# 5. after an engine REBUILD, prove the new engines are the new BINARY:
#      stat -Lc %i /proc/<pid>/exe      # must equal the on-disk inode
```

**Use `stat -L` for that inode check, and check the parent.** Two traps, both hit
on 2026-07-30. Without `-L`, `stat -c %i /proc/<pid>/exe` returns the inode of
the PROCFS SYMLINK, which is a different number per process and never matches
anything on disk - it looks like a real reading and answers nothing. And
`pgrep -f deep_ww_bgs_engine` matches your own shell, so filter to the bot
client's children (`awk '{print $4}' /proc/<pid>/stat` against the client's pid)
before believing a count. A correct reading looks like this - three engines,
one per bot, all on the same inode as the file on disk:

```
ENGINE pid=4986 ppid=4960 inode=41613 flags=--samples 1000
ENGINE pid=4987 ppid=4960 inode=41613 flags=--samples 1 --root_noise_factor 0
ENGINE pid=4988 ppid=4960 inode=41613 flags=--samples 5000
```

Running engines hold their old image as a DELETED inode
(`readlink /proc/<pid>/exe` ends in " (deleted)"), which is how you can tell a
process that predates the rebuild from one that does not.

**`ps` on the bot client exposes the official token** in its command line.
Redact before pasting anything from it: `sed -E 's/--official-token [^ ]+/--official-token REDACTED/g'`.

**The client does NOT capture engine stderr** (found 2026-07-30). Nothing
matching `bgs_engine_main` reaches `~/logs/bot-client-transformer.log`, so an
engine's own startup line — including its `Configuration: samples=... root_noise=...
losing_fallback=...` state — is not readable there. To establish what a running
engine is actually configured to do, read `/proc/<pid>/cmdline` for the argv and,
if the mapping matters, launch the same binary directly with the same flags and
read its startup line. Engine-side diagnostics being invisible in the client log
is adjacent to board task `5f302c24`.

**A restart replays every abandoned game.** Immediately after one, the log shows
bursts like `Applying move ... at ply 57/58/59/60` for a game whose human left
hours earlier — a resync rebuilding that tree. Expected, and exactly the cost
board task `ce4434fc` describes; do not mistake it for live play.

Before killing anything, check nothing is mid-game on these bots: look for
`Evaluating position` / `Applying move` lines in the last few minutes, and
resolve any suspicious open session against `GET /api/games/<id>`
(`matchStatus.status`). Do NOT use "a session start with no matching end" as
the signal — around 70 sessions are permanently unmatched in a normal log, so
that test says nothing. A live game would survive anyway if the client returns
inside the 30s grace window, but do not rely on that.

**If `desktop-053vvpl-1` (WSL) is unreachable entirely** (ssh hangs, tailscale
shows it offline while `desktop-053vvpl` — the WINDOWS side of the same box —
is online): the WSL instance has stopped (it does NOT auto-start, and nothing
restarts the bot). Recovery from auntie, no human at the desk needed
(2026-07-28 outage):

```
ssh nilo@desktop-053vvpl "wsl -d Ubuntu -u nilo -- tmux new-session -d -s bot-client -n bot-client \"bash ~/run_transformer_bot.sh\""
```

The tmux server keeps WSL alive. Then verify attach + listing + the round-trip
probe as below.

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

#### There IS a C++ unit test suite, and it is cheap. RUN IT. (found 2026-07-30)

`CMakeLists.txt` defines a Catch2 target `unit_tests`, gated on `find_package(Catch2 3)`.
Catch2 is installed on the desktop, so it has always been buildable - it had simply never
been built. Measured: **~5 s to build, sub-second to run**, and it needs no extra model
work because the `.trt` files `model_trt` depends on already exist in `build-tests/`.

```
cd ~/nil/wallgame/deep-wallwars/build-tests && nice -n15 make -j6 deep_ww_bgs_engine unit_tests
timeout 300 ./unit_tests "[dispatcher]"   # concurrency cases; a TIMEOUT is a FAILURE
timeout 300 ./unit_tests                  # full suite
```

**Compare the failures BY NAME, not by count.** A count alone is not a gate: "still N" is also
true if one stale test gets fixed while a real regression takes its slot.

**The suite is now GREEN (task `e5fec60c`, 2026-07-30).** Expected result:

```
test cases: 103 | 102 passed | 0 failed | 1 failed as expected
```

The one expected failure is `TensorRT 5x5 model`, tagged `[!shouldfail]` upstream - it handles
itself and is not a defect. **Any other failure is real.**

What the six long-standing failures turned out to be, since "they are stale, ignore them" was
the standing assumption for three weeks and was only 5/6 right:

- Four `parse_move_notation` cases were stale. The fixture's cat is at **a1**, not the `a8`
  every comment claimed (`cell_notation` is `official_row = rows - cell.row`, so internal
  `[7,0]` on 8 rows is a1), so they fed the parser a cell six rows from the pawn. Proved with
  a round trip: every legal action's own notation parses straight back, 4 of 4.
- `validate_request - rejects freestyle variant` was stale in the other direction - freestyle
  became supported and the test kept pinning the old rejection. Now inverted, with a
  `survival` case added so the reject path stays covered.
- `parse_move_notation - Invalid notation` was **a real defect, not a stale test.**
  `parse_notation_part` read the row with `std::stoi`, which stops at the first non-digit
  without reporting it, so `"Ca2Mh1"` parsed as `"Ca2"` and silently discarded an action.
  That is the inbound path `handle_apply_move` uses for the human's move, so a truncating
  parse would leave the engine searching a position the real game is not in. Fixed with
  `std::from_chars` in `src/engine_adapter.cpp`.

`scripts/cpp-test-gate.sh` used to exclude all six. Worth remembering why that was worse than
it looked: the exclusion was the wildcard `~parse_move_notation*`, so it hid the entire parser
group and any NEW parser breakage would also have gone unreported while the gate said green.
The exclusions are gone; the gate now runs everything.

Extracting the names (the console reporter prints a header block per failure, and gflags in
`test/main.cpp` eats `--`-style Catch2 flags, so the XML reporter is not available):

```
./unit_tests 2>/dev/null > /tmp/ut.txt
grep -A1 '^-\{79\}$' /tmp/ut.txt | grep -v '^-' | grep -v '\.cpp:[0-9]' \
  | grep -v '^\.\{10,\}$' | grep -v '^$' | sort -u
```

#### Building here REPLACES the binary production launches from

`build-tests/deep_ww_bgs_engine` is the exact path the bot client spawns. Running engines
keep their in-memory image, so a build does not change what is currently serving - but the
NEXT respawn picks up whatever you just built, whether or not you meant to deploy. Do not
build a candidate here and then walk away from it.

Corollary for rollback: there is no saved copy of the previous binary. Rolling back means
checking out the old sha in a separate build worktree and rebuilding.

### Deploying

```
rm -rf /tmp/wg-deploy && mkdir -p /tmp/wg-deploy
git archive <sha> | tar -x -C /tmp/wg-deploy
cd /tmp/wg-deploy && ~/.fly/bin/fly deploy --remote-only
```

Clean export so another agent's uncommitted work never ships. fly CLI is authenticated on
auntie. `bun run ci` **cannot** pass on auntie, because `bun run test` shells to `wsl.exe`,
which does not exist here. The tests themselves do run: Docker was installed on auntie on
2026-08-01, so `sg docker -c 'bun scripts/run-tests.ts'` runs the whole suite including the
Testcontainers ones. Use that script rather than a bare `bun test` over several integration
files - each file starts its own Postgres and HTTP server, so they must not share a process.
Also verify with `bun run build` (0 TS errors) and `bun x eslint .`. prettier is pinned
(3.8.3) and the repo formatted once (`6d08c66`); `bun x prettier --check .` must stay clean.

---

## 3. What exists

Commits, newest last: `c25a132`, `1250597` (custom-setup variants, authored turn state),
`94c989b` (candidate launcher), `a5abd94` (standard generation + puzzle framing),
`24e22d3` (PuzzleBot + variant naming), plus the puzzle-name banner commit.

- **Curation state — 8 of 41 rows retired, 33 live.** Two rounds:
  1. loop 3 S-COPY `3636107`: the original Generated Puzzle 1 and 6 (Nil: too easy).
     S-P2 then renumbered the ENABLED rows contiguously: **old 2–5 → new 1–4,
     old 7–41 → new 5–39**.
  2. **S-EVAL 2026-07-29:** six puzzles the mover was not decisively winning —
     then-current **17, 19, 28, 32, 34, 39** (candidates `synthetic-6x6-21`,
     `-23`, `-35`, `-41`, `-43`, `-48`; row ids `1aU39bPioY`, `5S-CAHHLH9`,
     `PU1J5kqmoK`, `IuJo82y0Tg`, `w1CbAJ10fA`, `pIsulg5AOf`). Survivors above 17
     renumbered: **18→17, 20→18, 21→19, 22→20, 23→21, 24→22, 25→23, 26→24,
     27→25, 29→26, 30→27, 31→28, 33→29, 35→30, 36→31, 37→32, 38→33.**

  Display names are presentation; identity is `source_fingerprint` and the row id,
  and disabled rows keep their historical names. **Nil's ratings are unaffected by
  the S-EVAL renumbering** because every rated puzzle sits below 17: pool good
  overall; **1, 2, 8, 9 good**; **6, 7 excellent**. (6 and 7 are also the two
  survivors closest to the decisively-winning threshold — see the audit note in
  `plans/puzzle-batch2.md` before ever raising it.) Retire future rejects with
  `fly ssh console -a wallgame -C "bun scripts/retire-puzzles.ts '<current display name>' ..."`
  — it matches names among ENABLED rows only and renumbers survivors in the same
  transaction, so numbers stay continuous.
- **Naming (S-BATCH1 `caf7117`, 2026-07-29):** generated puzzles are called
  "Puzzle 1".."Puzzle 39" - the word "Generated" described how a puzzle was made, which
  is not the player's business. The handcrafted ten are also "Puzzle 1".."Puzzle 10", so
  the first ten names OVERLAP on purpose. That is safe only because a display name is
  presentation: identity is the row id, and seed matching is by `source_fingerprint`.
  **Nothing may look a puzzle up by name.** `retire-puzzles.ts` takes names, but matches
  them among ENABLED `saved_puzzles` rows only, and the handcrafted set is not in that
  table at all. The one-time rename ran in-machine via
  `scripts/rename-generated-puzzles.ts` (fail-closed, idempotent - a re-run exits 0
  saying there is nothing to do). Historical note: rows retired before this keep their
  old "Generated Puzzle N" names, exactly as they kept their old numbers.
- **Saved puzzles (`3d3a318`, S-G1):** the 41 filtered candidates are PERSISTED in the
  `saved_puzzles` table as named entities (seeded as "Generated Puzzle 1..41", renamed
  since - see above), seeded manually
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
- **TWO engine filters, both Nil's, both read off the SAME single evaluate response:**
  1. *Distance rule:* reject when applying the engine's best first move improves the
     mover's distance to their goal by 2 (delta -2 is the rule, whatever the move's
     actions are).
  2. *Decisively-winning rule (2026-07-29, S-EVAL):* reject unless the mover's
     evaluation is at least `MIN_MOVER_EVALUATION` (0.65). Solving a puzzle means
     winning it, so a position the mover cannot win is not a puzzle. This narrows the
     "Nil is the filter" rail by exactly one property — it is a precondition of his own
     model, not a judgement of taste. **`evaluation` was in the engine's response all
     along and was being discarded**, which is how six unwinnable puzzles shipped; see
     `plans/puzzle-batch2.md` for the measurements and the audit of every keep flip.
     The threshold is a threshold on the engine's [-1,+1] number, NOT a calibrated win
     probability (the UI happens to display 0.65 as 82.5%). It is the MIDPOINT of Nil's
     observed keep/retire boundary, deliberately not hugging either edge: repeated
     evaluations of the same position vary by ~0.04, so a threshold set at an anchor
     turns engine noise into an arbitrary classification.
     **The engine is stochastic, so a boundary classification is a measurement, not a
     fact.** `NEAR_THRESHOLD` in the filter script flags anything within 0.15 for human
     review; a single recorded evaluation still decides the artifact, and a rerun never
     rewrites it. Do NOT "fix" this with a minimum-of-N rule: the puzzles nearest the
     threshold are the two Nil rated EXCELLENT, so discarding boundary cases
     preferentially discards the best puzzles.

  Verdicts live in `shared/domain/generated-custom-setup-verdicts.json`, bound to
  mover-aware fingerprints and validated fail-closed. **Nothing in that file is
  trusted:** the loader replays every recorded best move with production rules, requires
  the recorded distances to reproduce, rejects an empty move (`"---"` is valid notation
  for a pass and would otherwise reproduce any delta-0 record), and RECOMPUTES `keep` —
  the stored flag is an audit checksum and disagreement throws, so a rule change with a
  stale artifact fails loudly instead of honouring old decisions.
  Current batch: 36 kept / 48. Regenerate with
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

Beyond those two rules no quality filter is applied. The positions being decent is
still mostly a property of "6x6, 18 walls, short races" rather than of selection —
what the second rule adds is only that the mover can actually win.

---

## 4. Open work

Items A, B, C, D, and F were fixed 2026-07-26 (slice loop, `plans/puzzle-bugs-loop.md`,
commits `9ea1062`..`2b4a0c0`, reviewed by Project Reviewer 1) - summary in section 4bis.

### E. Bug: takeback does not work - RESOLVED (Nil confirmed 2026-07-29)

Nil confirmed on 2026-07-29 that takeback works in production. No fix was made for it
directly, so it was either never broken in the shape reported or it was fixed in passing
by one of the 2026-07-26 bot-game repairs (section 4bis). Kept here rather than deleted
so the next reader does not go hunting for it again.

The original report: `server/games/bgs-store.ts` has a full takeback-replay path for bot
games, so this looked like a bug and not a missing feature. Untested hypothesis at the
time: the replay rebuilds the BGS session from the standard initial state rather than the
authored one, or the seeded partial turn breaks it.

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

### G. Make it a first-class feature — G1/G2 DONE (loop 2); G3/G4 = loop 4

1. **Discoverability — DONE** (S-G2, `bacc0ce`): one /puzzles page in the site
   nav presents both sets; /generated-candidates redirects there.
2. **Cohesion — DONE** (S-G2 + loop 3 S-UI): the 10 scripted puzzles stay on
   their scripted model but share the page with unified card treatment.
   `GENERATED_PUZZLES` in `shared/domain/generated-puzzles.ts` remains a
   **third**, older set from the real-game pipeline, deliberately not spread
   into `PUZZLES` - unvetted, must not ship.
3. **Completion tracking — DONE** (loop 4, S-ID `b784ddb` + S-G3 `1820993`).
   `games.puzzle_id` (nullable text, FK `saved_puzzles.id`, migration 0018) is
   written from the puzzle row the SERVER resolved during a
   server-authoritative launch, so a completion can never be credited to a
   puzzle the client merely named; `createRematchSession` deliberately drops
   it. No backfill — games finished before the deploy keep NULL.
   **A solve is a DECISIVE win.** `buildOutcomeRank` gives BOTH players rank 1
   when there is no winner, so "the human's row is rank 1" counts draws as
   solves — measured in prod, that rule would have miscredited 14 rows. The
   shipped rule also requires the opponent's row at rank 2. It lives in
   `server/games/puzzle-progress.ts` (derived, never stored); scripted
   completions are client-asserted rows in `scripted_puzzle_completions`,
   whose NULLABLE user_id records anonymous solves as usage telemetry (one
   UNIQUE (user_id, puzzle_id) gives idempotent logged-in writes AND
   unlimited anonymous rows, because Postgres treats NULLs as distinct).
   **Ordering rule this established:** a finished game is PERSISTED BEFORE the
   finished state is broadcast (`server/games/finish-sequence.ts`) — the
   bot-move path used to broadcast first, which let a player return to
   /puzzles before their win existed. A persistence failure still cannot
   suppress the broadcast.
4. **Likes / dislikes — DONE** (loop 4, S-G4). Generated puzzles only. A vote is
   EARNED: the write refuses a puzzle the caller has not DECISIVELY won, using
   the same query as completion (`hasSolvedGeneratedPuzzle`), so the rule lives
   in one place. `puzzle_votes` (migration 0021) keys on (user_id, puzzle_id)
   with `CHECK (value in (-1, 1))` and a NOT NULL user id — the one table here
   that has no anonymous case, because an anonymous vote cannot be earned.
   `{value: 1 | -1 | null}`, where null deletes the row. Captured on the game
   page right after a win, changeable later from the puzzle's card. The
   listing stays unauthenticated and merely gains `myVote` for a logged-in
   caller; counts are one grouped query plus at most one for the caller's own
   votes. Numeric order is the default; "Most liked" sorts client-side by
   likes minus dislikes with `sortIndex` as the tiebreak. Votes inform
   curation only — nothing retires a puzzle automatically.
5. **The solo campaign uses the same model — DONE** (loop 4, S-CAMP, board
   task `98a0e022`). Campaign levels are played entirely client-side against a
   local AI, so their completion is client-asserted like the scripted puzzles
   and cannot be server-verified; everything else now matches — anonymous
   usage rows, the per-IP limiter on the open write, a retry that resends,
   and the same completion affordances.
   **Transitional dual read — do not remove it as duplication.**
   `campaign_progress` has a composite PRIMARY KEY `(user_id, level_id)` and
   so cannot hold an anonymous (NULL user) row, which is why S-CAMP added
   `campaign_level_completions` (migration 0020) instead of altering it.
   Writes go only to the new table; `readCampaignProgress` unions both so no
   existing player's markers vanish before
   `scripts/backfill-campaign-completions.ts` has run and been verified.
   Removing the legacy half of the read, and later dropping the old table, is
   a deliberate follow-up — see `plans/puzzle-loop-4.md`.

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
position-matching code below. (Added in loop 4 S-ID, `b784ddb`, exactly when completion
tracking began; display still rides the client handshake and needs nothing on the record.)

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
