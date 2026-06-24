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

### Mandatory wrapper gates (from plan-gate — required from slice 1b onward)
- **stdout is protocol-only.** The old engine logs search progress to `std::cout` ("Search depth…", "Best move…"). That MUST NOT reach the JSON-lines stdout — redirect/suppress the engine's stdout during `GetMove` (to stderr or silenced). The protocol-smoke gate asserts stdout parses as pure JSON-lines. **Slice-1b acceptance criterion, not optional.**
- **Error paths:** unsupported board size/variant, unknown `bgsId` on apply/evaluate, duplicate start / end-of-missing session, malformed move in `apply_move` → engine returns a well-formed error response, never crashes.
- **Session isolation:** multi-session smoke (even at 8×8) — two `bgsId`s, apply different moves, evaluate both, assert no state bleed.
- **Assert every move:** the BGS integration test asserts every `apply_move` is server-accepted and every response is well-formed — not merely that the game finishes.

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

## Plan-gate log

- **2026-06-23 — Game Reviewer (gpt-5.5): APPROVED WITH CONDITIONS** on baseline `ca401ac`. Conditions folded in below: split slice 2 → 2a/2b; exact wall↔edge bijection (horizontal anchor = `EdgeBelow(node(r-1,c))`, not `node(r,c)`); deterministic eval squash + terminals driven by `Winner()`; **stdout-protocol isolation as a 1b blocker**; error-path + multi-session protocol smoke; precise quarantine of `NegamaxOrderedMovesTest`. Standalone cmake for 1a accepted.

---

## Slice plan  (tick the box in the commit that ships the slice)

- [ ] **1a — Vendored core builds in-monorepo.** `minimax-engine/` compiles via documented command; the known 11/12 self-test failure (move ordering) is understood + quarantined (not hidden); reproducible build doc.
- [ ] **1b — Tracer wrapper (8×8 classic), small *tested* translation subset.** New `minimax_bgs_engine` target speaks V3 JSON-lines (start/evaluate/apply/end), holds per-session `Situation`, **stdout is protocol-only** (engine search logs suppressed/redirected — see Mandatory wrapper gates), returns a **legal** move in standard notation. Ships translation *smoke* tests for the exact wall anchors / pawn deltas any emitted move uses (no opaque notation bridge) + error-path + multi-session smoke. A full 8×8 classic game plays to a legal finish through `bot-5-minimax-engine.test.ts` with **every move asserted**. Does **not** claim wall-bijection/eval are hardened — that is 2a/2b.
- [ ] **2a — Translation hardening.** Wall↔edge bijection (both directions), pawn deltas, `apply_move` parsing proven by **exhaustive round-trip** tests over all real edges on 8×8 + fake-edge rejection (col `C-1` right, row `R-1` below) + corner anchors. Uses standard-notation helpers to avoid row-number slips.
- [ ] **2b — Eval + endgame.** Evaluation correct **sign** (P1-perspective) via a root-eval accessor; deterministic squash (`tanh(raw/scale)`, not raw clamp) to [-1,1]; terminal positions driven by `Winner()` (0→+1, 1→−1, 2→0), not a post-game-over search value; golden-position tests (sign + monotonic).
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
- **Eval:** must be **P1-perspective**, range [-1,+1] (+1 = P1 winning) regardless of which side the engine plays. Old `NegamaxEval` is **side-to-move-relative**: `p1Raw = (sit.turn==0) ? oldEval : -oldEval`. **Squash deterministically** (e.g. `tanh(p1Raw/scale)` with a documented `scale`) — do NOT plain-clamp raw integer scores (saturates to ±1, kills signal); clamp *after* squashing to satisfy `clampEvaluation` (`shared/custom-bot/engine-api.ts`). **Terminal positions:** drive from `Winner()` directly (0→+1, 1→−1, 2→0), not from a post-game-over search value. Surface root eval via a small accessor on the TT entry `GetMove` already fetches with the exact flag.

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
- Wall↔edge surface (`graph.h`): `EdgeBetweenNeighbors`, `EdgeAbove/Right/Below/Left`, `IsRealEdge`, `NumRealEdges`. **The exact bijection is below — it has a high-risk off-by-one; prove both directions with round-trip tests.**

### Wall↔edge bijection (EXACT — from plan-gate; the highest-risk mapping)
Old engine edge indexing: `EdgeRight(C,v) = 2*v` (even = edge to the **right** of node v); `EdgeBelow(R,C,v) = 2*v+1` (odd = edge **below** node v). Fake right edges live at the rightmost column, fake below edges at the bottom row.
Wallgame walls: vertical `{cell:[r,c]}` sits to the **right** of the cell (blocks `[r,c]↔[r,c+1]`); horizontal `{cell:[r,c]}` sits **above** the cell (blocks `[r-1,c]↔[r,c]`).
- **wallgame → old:**
  - vertical `[r,c]` → `EdgeRight(node(r,c)) = 2*(r*C+c)`. Valid only `c < C-1`.
  - horizontal `[r,c]` → `EdgeBelow(node(r-1,c)) = 2*((r-1)*C+c)+1`. Valid only `r > 0`.  **⚠ NOT `EdgeBelow(node(r,c))`** — that anchors the wall *below* the cell instead of *above*. This is THE off-by-one.
- **old → wallgame:** even `e`: base `e/2` → cell `[Row(base),Col(base)]`, vertical. odd `e`: base `(e-1)/2` → cell `[Row(base)+1, Col(base)]`, horizontal.
- Always `assert IsRealEdge` before converting. Tests: all real edges on 8×8, fake-right (`col C-1`), fake-below (`row R-1`), corner anchors (`>a8`, `^a7`, `^a1`).

### Evidence surfaces
- Engine stdin/stdout JSON lines (drive directly via the protocol smoke script).
- BGS wire messages logged in `tests/integration/bot-5-minimax-engine.test.ts`.
- `wallwars_ai test` output.

### Provenance
Vendored from `github.com/nmamano/wallwars` `/AI` at commit `bb730f1f988d1b4fb2e1dc1786d62c70215be60e` (2026-02-27), MIT. See `minimax-engine/PROVENANCE.md`.

### Traps (each will bite if ignored)
1. **Compile-time board size** (`<R,C>` template) — v1 = 8×8 only.
2. **`std::cout` pollution** — the engine prints search logs to stdout; a JSON-lines engine's stdout must be protocol-only. Redirect/suppress during `GetMove`. (Plan-gate blocker for 1b.)
3. **Wall↔edge bijection** — see the EXACT mapping above; horizontal-wall anchor is `EdgeBelow(node(r-1,c))`, **not** `node(r,c)`. Round-trip + fake-edge tests.
4. **Eval** — side-to-move → P1-relative; deterministic squash (not raw clamp); terminals from `Winner()`.
5. **Draw / one-move rule** — `Winner()==2` → wallgame draw (eval 0).
6. **Known baseline self-test failure** — `NegamaxOrderedMovesTest` fails 11/12 at baseline ("948: Mismatch", move-ordering heuristic, NOT correctness — `NegamaxGetMoveTest` passes). The build/test gate runs the FULL suite visibly AND separately asserts the only failure is exactly this test name + count; **fail the gate if name/count changes**. `BUILD.md` records compiler/platform + the exact failure. Never delete or silently skip it.

---

## SLICE-1a PICKUP — authored now

- **Baseline commit:** `ca401ac` (vendored `minimax-engine/` + this file). The loop's slice 1a builds on this.
- **Goal:** the vendored engine builds inside the monorepo via a documented, reproducible command, and the one known self-test failure is understood and explicitly quarantined (not hidden, not "fixed" by deleting the test).
- **Load-bearing mechanics / traps:**
  - It's a single translation unit (`source/main.cc` includes everything as headers) — build is fast; LTO is irrelevant.
  - `NegamaxOrderedMovesTest` fails at baseline. Investigate whether it's platform/compiler-dependent ordering vs. a real bug. Likely benign (move-ordering heuristic, search still correct). Decide: quarantine with a clear comment + keep it visible, OR fix if trivial and clearly a portability issue. Do **not** make `wallwars_ai test` "green" by hiding it.
  - Decide build integration: keep `minimax-engine/` standalone (`cmake --preset release`) for now; do **not** touch root build/CI files (they're on the do-not-touch list).
- **Acceptance criteria:** `cd minimax-engine && cmake --preset release && (cd build_release && make)` succeeds from a clean checkout; the gate runs the **full** `wallwars_ai test` visibly AND separately asserts the only failure is exactly `NegamaxOrderedMovesTest` (11/12) — failing the gate if that changes; `minimax-engine/BUILD.md` documents the command, compiler/platform (g++ 13.3 / cmake 3.28 / Ubuntu 24.04), and the exact known failure.
- **Decide-with-Game-Reviewer:** quarantine vs. fix for the failing test; whether to keep standalone build.
- **Locked (don't relitigate):** server-side serving via V3 protocol; 8×8 classic v1; pure-C++17 light wrapper (no Folly).
- **Resources:** `minimax-engine/` (vendored), this file's Resources section.

## SLICE-1b PICKUP — *author after 1a commits*
(Goal preview: tracer wrapper `minimax_bgs_engine` + `bot-5-minimax-engine.test.ts` green for one full 8×8 classic game.)
**Hard acceptance criteria carried from plan-gate (do not drop):** (1) stdout protocol-only — engine search logs suppressed/redirected, asserted by protocol-smoke; (2) small *tested* translation subset (smoke tests for the exact wall anchors + pawn deltas the bot can emit); (3) error-path responses (bad size/variant, unknown bgsId, dup/missing session, malformed move); (4) multi-session no-state-bleed smoke; (5) every `apply_move` asserted server-accepted in the integration test. The "what 1a learned" note goes at the top when authored.

## SLICE-2 PICKUP — *author after 1b commits*

## SLICE-3 PICKUP — *parked unless promoted by Nil*

## SLICE-4 PICKUP — *HUMAN-ONLY trigger*
