# Minimax AI loop — standing orders + slice handoffs

> **Re-read this file at the start of every iteration.** [why: conversations compact, this file doesn't.]
> Owner/manager: **Nil**. Reviewer (pairing): **Game Reviewer** (`agent-1780864878869-eq7t`, room "Parked Projects").

---

## North star

Players on **wallgame** can choose a second AI opponent — the **classic-Wallwars minimax engine** (negamax + alpha-beta + transposition tables) — served from auntie the same way the Deep-Wallwars bots are, and play a full **classic** game against it to a legal finish.

What must not be diluted: it is **served server-side via the existing V3 bot protocol** (a stdin/stdout JSON-lines engine behind the official bot-client), exactly like deep-wallwars — not a one-off script, not a UI hack, not a wasm side-channel.

v1 scope (agreed with Nil): **8×8 classic only, fixed ~3–4s think-time.** Multi-size and difficulty tiers are parked (see Deferred).

---

## Process per slice

```
plan → [Game Reviewer plan-gate] → implement → run gates → self-review checklist
     → [Game Reviewer diff-gate] → sign-off → ONE focused commit (ticks the slice's box)
```

- **Never start slice N+1 before slice N is committed.**
- **Author the next slice's PICKUP block only after the current slice commits**, folding in what it taught (a "what slice N-1 learned" note at the top of each handoff).

### Self-review checklist (run every slice, before asking for diff-gate)
- [ ] Did I judge correctness by the **engine wire output / BGS messages**, not by the UI board?
- [ ] Every move the engine emits is **legal** in the position (verified against the evidence surface)?
- [ ] Any bug a gate caught has a **regression test at the right layer** in this same slice?
- [ ] No gate weakened "just this once"?
- [ ] Commit touches **only my files** (scoped `git add`), no files from the Standing rails do-not-touch list?
- [ ] One focused commit, slice checkbox ticked in it?

---

## Gates per slice

None of these cost money or quota. CPU + local only — no GPU, no LLM, no paid API, no network to prod.

### Always-run (cheap, deterministic, no Docker)
```bash
# 1. Build the engine (vendored core + wrapper). Proven on auntie: g++ 13.3, cmake 3.28.
cd minimax-engine && cmake --preset release && ( cd build_release && make )

# 2. Engine self-tests (NOTE: baseline is 11/12 — see Resources "known baseline failure").
./minimax-engine/build_release/wallwars_ai test

# 3. Translation unit tests (added to the engine's own Tests::RunTests framework in tests.h):
#    coords/walls/notation round-trip + eval-perspective. Runs via the same `wallwars_ai test`.

# 4. Protocol smoke (slice 1b+): pipe canned BGS JSON lines into the wrapper binary,
#    assert response types + that every bestMove is legal. No server, no DB.
./minimax-engine/scripts/protocol-smoke.sh
```

### Needs-docker (still free/local/offline — the high-confidence end-to-end gate)
```bash
# Full serve→protocol→play loop, isolated ephemeral Postgres, NODE_ENV=test (mock auth).
# `sg docker -c` activates the docker group in-session (nil is in the group but this
# login predates it). A fresh loop session may have docker directly — try plain first.
sg docker -c 'NODE_ENV=test bun test tests/integration/bot-5-minimax-engine.test.ts'
```
> Proven baseline: the equivalent `bot-3-dummy-engine.test.ts` runs **3 pass / 0 fail in ~9s** on auntie.

There are **no env-gated quota-burning gates** in this project (nothing to opt into). If that ever changes, it goes here with a hard-refuse-without-opt-in guard.

---

## Standing rails  (Phase-1 prohibitions, verbatim — never relax in the loop)

1. **NEVER touch the live production bot service.** Do not stop/start/edit the `wallgame-bot.service` systemd unit, do not edit `official-custom-bot-client/deep-wallwars.prod.config.json`, and **never connect any client to `wallgame.fly.dev` or the prod server.** All testing uses the testcontainers integration harness, or a local server + a bot-client with its **own** `--client-id`, ports, and `/tmp` state. (There is a real Postgres on `localhost:5432` and other live containers — never reuse or clobber them; testcontainers spins its own.)
2. **NEVER edit files that already have uncommitted changes** (in-flight work by others): `official-custom-bot-client/src/ws-client.ts`, `package.json`, `bun.lock`, `frontend/bun.lock`, `scripts/bot-monitor.sh`. If a slice seems to need one of these, **stop and queue it for Nil** — do not edit.
3. **No `git push`. No branches** (unless Nil asks). One focused commit per slice; **commit only my own changes** (explicit scoped `git add`, never `git add -A`).
4. **Never weaken a gate to make it pass.** A gate failure is fixed in-slice or becomes a queued decision. A gate-found bug gets a regression test in the same slice.
5. **Judge by the evidence surface, not the UI.** The engine's stdin/stdout JSON and the BGS wire messages are the oracle. Screenshots/board renders are artifacts, never assertions.
6. **Prod-touching steps are HUMAN-ONLY.** Adding the bot to the live config / restarting the service / making it publicly visible happens only in the final slice and only with Nil's explicit go.

---

## Slice plan  (tick the box in the commit that ships the slice)

- [ ] **1a — Vendored core builds in-monorepo.** `minimax-engine/` compiles via documented command; the known 11/12 self-test failure (move ordering) is understood + quarantined (not hidden); reproducible build doc.
- [ ] **1b — Tracer wrapper (8×8 classic).** New `minimax_bgs_engine` target speaks V3 JSON-lines (start/evaluate/apply/end), holds per-session `Situation`, returns a **legal** move in standard notation; a full 8×8 classic game plays to a legal finish through `bot-5-minimax-engine.test.ts`. Evidence = BGS wire + engine stdout.
- [ ] **2 — Translation + eval hardening.** Wall↔edge bijection and pawn-move mapping proven by round-trip unit tests; evaluation correct **sign** (P1-perspective) and squashed to [-1,1]; golden-position tests. Draw / "one-move rule" mapped correctly.
- [ ] **3 — (parked unless promoted) Multi-size 5×5–8×8** via runtime dispatch over template instantiations.
- [ ] **4 — (HUMAN-ONLY to trigger) Productionize.** Name/appearance/visibility/recommended settings, config + service wiring, monitoring. Both AIs selectable. Only on Nil's go.

---

## Deferred / parked  (do-not-pick-up list + queued human-only decisions)

- **Multi-board-size support (5×5–8×8).** The engine is templated `<int R,int C>` at **compile time**; v1 fixes 8×8. Promote slice 3 only if Nil asks. Approach when promoted: enumerate supported (R,C), instantiate each, dispatch at runtime on session board size.
- **Difficulty tiers** (multiple bots at different think-times) — parked.
- **Queued for Nil (HUMAN-ONLY):** bot display name, appearance/color, public vs private visibility, recommended board sizes shown in UI, and the actual go-live (prod config edit + service wiring/restart). None of these are decided in the loop.
- **Build-system integration choice** (standalone `cmake --preset` vs. wiring into root `bun run ci`): assistant may propose; confirm with Game Reviewer; anything that edits root build files near the do-not-touch list is queued for Nil.

---

## Resources

### Confirmed mappings (the gold — verified from source)
- **Players:** wallgame **p1 ↔ old player 0** (start top-left (0,0) → goal bottom-right); **p2 ↔ old player 1** (start top-right (0,C-1) → goal bottom-left). No axis flip.
- **Cells:** `node = row*C + col`; both systems use (0,0) = top-left, row increases downward.
- **Eval:** must be **P1-perspective**, range [-1,+1] (+1 = P1 winning) regardless of which side the engine plays. Old negamax eval is **side-to-move-relative** → convert (negate when `sit.turn==1`) then squash. Use `clampEvaluation` semantics from `shared/custom-bot/engine-api.ts`.

### Standard notation (`shared/domain/standard-notation.ts`)
- Cell: `<col-letter><row>` where col = `a`+col, row = `totalRows - r` (1-based, bottom-up). e.g. (0,0) on 8×8 → `a8`.
- Wall: `>`+cell = vertical, `^`+cell = horizontal.
- Action prefixes: `C`=cat/pawn move, `M`=mouse (standard variant only). **Classic uses `C`.**
- Move = actions joined by `.` (e.g. `Cb8.>c5`), up to 2 actions; pass/none = `---`.

### Protocol + engine contract
- Messages: `shared/contracts/custom-bot-protocol.ts`; engine view: `shared/custom-bot/engine-api.ts`.
- Flow per session: `start_game_session`→`game_session_started`, `evaluate_position`→`evaluate_response{bestMove, evaluation, ply}`, `apply_move`→`move_applied`, `end_game_session`→`game_session_ended`. State is **per-`bgsId`, tracked across moves** (evaluate_position relies on prior apply_move; engine holds the position).
- Classic initial state (`shared/domain/classic-setup.ts`): `pawns.p1={cat:[0,0],home:[last,last]}`, `pawns.p2={cat:[0,last],home:[last,0]}`, `walls:[]`.

### Templates to copy (don't reinvent)
- **Wrapper structure:** `deep-wallwars/src/bgs_engine_main.cpp` (CLI flags, stdin line reader, type-dispatch, response writer, SessionManager). **But write LIGHT:** pure C++17 + a single-header JSON lib, **synchronous** (read line → `GetMove` → write line). No Folly, no gflags, no TensorRT — minimax is fast and per-session serial.
- **Logic reference:** `dummy-engine/src/index.ts` (per-session state map, same message handlers).
- **E2E test:** copy `tests/integration/bot-3-dummy-engine.test.ts` → `bot-5-minimax-engine.test.ts`, point `engineCommands` at the built binary, variant `classic`, 8×8.

### Old engine API (vendored under `minimax-engine/`)
- `Negamax<R,C>::GetMove(Situation<R,C> sit, int millis)` → `Move` (time-budgeted iterative deepening). Eval is computed inside; may need a small accessor to surface the root eval for `evaluate_response`.
- `Situation<R,C>`: `tokens[2]` (player node positions), `turn` (0/1), `G.edges[]` (walls), `ApplyMove`, `UndoMove`, `Winner()` (0/1, or **2 = draw** via one-move rule), `IsGameOver`, `MoveToString`, `SetStartingSituation`, `ParseMove`/`ParsedMoveToMove`.
- `Move{ token_change /*node delta*/, edges[2] /*walls removed, -1=none*/ }`. Helpers: `DoubleWalkMove`, `WalkAndBuildMove`, `DoubleBuildMove`.
- Wall↔edge surface (`graph.h`): `EdgeBetweenNeighbors`, `EdgeAbove/Right/Below/Left`, `IsRealEdge`, `NumRealEdges`. **The wall(cell,orientation) ↔ edge-index bijection is the error-prone heart of slice 2 — prove it with round-trip tests.**

### Evidence surfaces
- Engine stdin/stdout JSON lines (drive directly via the protocol smoke script).
- BGS wire messages logged in `tests/integration/bot-5-minimax-engine.test.ts`.
- `wallwars_ai test` output.

### Provenance
Vendored from `github.com/nmamano/wallwars` `/AI` at commit `bb730f1f988d1b4fb2e1dc1786d62c70215be60e` (2026-02-27), MIT. See `minimax-engine/PROVENANCE.md`.

### Traps (each will bite if ignored)
1. **Compile-time board size** (`<R,C>` template) — v1 = 8×8 only.
2. **Wall↔edge bijection** — prove both directions with round-trip tests.
3. **Eval perspective + squash** — side-to-move-relative → P1-relative → [-1,1].
4. **Draw / one-move rule** — `Winner()==2` → wallgame draw handling.
5. **Known baseline self-test failure** — `NegamaxOrderedMovesTest` fails 11/12 at baseline ("948: Mismatch", move-ordering heuristic, NOT correctness — `NegamaxGetMoveTest` passes). Understand before relying on `wallwars_ai test`; quarantine explicitly, never silently.

---

## SLICE-1a PICKUP — authored now

- **Baseline commit:** this session's commit that vendors `minimax-engine/` + this file. (Record the hash on commit.)
- **Goal:** the vendored engine builds inside the monorepo via a documented, reproducible command, and the one known self-test failure is understood and explicitly quarantined (not hidden, not "fixed" by deleting the test).
- **Load-bearing mechanics / traps:**
  - It's a single translation unit (`source/main.cc` includes everything as headers) — build is fast; LTO is irrelevant.
  - `NegamaxOrderedMovesTest` fails at baseline. Investigate whether it's platform/compiler-dependent ordering vs. a real bug. Likely benign (move-ordering heuristic, search still correct). Decide: quarantine with a clear comment + keep it visible, OR fix if trivial and clearly a portability issue. Do **not** make `wallwars_ai test` "green" by hiding it.
  - Decide build integration: keep `minimax-engine/` standalone (`cmake --preset release`) for now; do **not** touch root build/CI files (they're on the do-not-touch list).
- **Acceptance criteria:** `cd minimax-engine && cmake --preset release && (cd build_release && make)` succeeds from a clean checkout; `wallwars_ai test` runs and the only failure is the documented, quarantined one; a short `minimax-engine/BUILD.md` documents the command + the known-failure note.
- **Decide-with-Game-Reviewer:** quarantine vs. fix for the failing test; whether to keep standalone build.
- **Locked (don't relitigate):** server-side serving via V3 protocol; 8×8 classic v1; pure-C++17 light wrapper (no Folly).
- **Resources:** `minimax-engine/` (vendored), this file's Resources section.

## SLICE-1b PICKUP — *author after 1a commits*
(Goal preview: tracer wrapper `minimax_bgs_engine` + `bot-5-minimax-engine.test.ts` green for one full 8×8 classic game. The "what 1a learned" note goes here.)

## SLICE-2 PICKUP — *author after 1b commits*

## SLICE-3 PICKUP — *parked unless promoted by Nil*

## SLICE-4 PICKUP — *HUMAN-ONLY trigger*
