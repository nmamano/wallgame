# Puzzle bugs loop — standing orders + slice handoffs

Re-read this file at the start of every iteration. Conversations compact; this file does not.
Companion: `info/puzzle-platform.md` is the authoritative doc for the model, the environment,
and the bug details. Read section 2 of it before touching any machine.

## North star

The five puzzle-platform bugs — A (banner/back-link on desktop), B (PuzzleBot variant
registration), C (5k samples), D (retry), F (Past Games pollution) — fixed on main, each
verified by production evidence, one reviewed commit per slice. Nothing else changes.

## Process per slice

plan → Reviewer plan-gate → implement → always-run gates → Reviewer diff-gate → sign-off →
ONE focused commit (tick the checkbox in the same commit) → push → deploy / bot restart as
the slice requires → production verification → author the next slice's pickup.

Production verification is necessarily post-commit (deploys ship a committed sha). If it
fails, fix forward in-slice before starting the next slice — never start slice N+1 with N
unverified. While waiting on the reviewer, end the turn with a ~20–25 min fallback wakeup;
the reply is the real wake signal.

## Gates per slice

Always-run (on auntie, before every diff-gate):
- `bun run build` — 0 TS errors
- `bun x eslint .` — clean
- prettier on touched files only (`bun x prettier --write <files>`), NEVER repo-wide

Reviewer gates: plan-gate and diff-gate via isomux message to **Project Reviewer 1**
(`agent-1780864878869-eq7t`). Commit only on sign-off.

Production evidence (post-deploy): fresh `curl` reads of the prod API, the desktop bot log
(`~/logs/bot-client-transformer.log` — NOT the tmux pane), DB reads via
`~/.fly/bin/fly ssh console -a wallgame` running a bun script inside the machine
(base64-encode the script to dodge `-C` quoting). Screenshots via the isomux preview-url
endpoint are artifacts for Nil, never assertions. Login-required checks: ask Nil and walk
him through it — there is no test account.

NOT gates: `bun run ci` (cannot pass on auntie — tests shell to wsl.exe), anything a UI or
tmux pane merely appears to show.

## Standing rails (prohibitions, verbatim)

- NEVER `pkill -f` / `killall` on any box; capture exact PIDs at launch and kill those only.
- NEVER scp source to the desktop; source moves by git only (commit → push → pull).
- NEVER run repo-wide prettier; ~37 pre-existing files fail `--check`.
- NEVER restore `...GENERATED_PUZZLES` into `PUZZLES`.
- NEVER touch the two auntie stashes or the desktop's intermediate-phase0a stash; identify
  stashes by message, never by index.
- NEVER deploy anything but a clean `git archive` export of a committed sha (recipe below).
- NEVER restart `wallgame-dev-5174` while Nil is mid-game on it; for own dev use port 5175.
- NEVER add wrong-move detection, correctness checks, or automated puzzle-quality gating —
  that is the old model creeping back (doc section 1).
- NEVER touch ELO/rating paths (`server/routes/games.ts` ~496–507 keeps puzzles unrated).
- NO DB schema migrations in these slices.
- NEVER weaken a gate to pass; fix in-slice or queue the decision.

## Decision protocol

- Alone: code structure within a reviewer-approved plan.
- With Reviewer 1: design choices — where the hoisted chrome lives (A), how the true
  variant is declared (B), where F's filtering lives (server query vs frontend).
- PARKED FOR NIL (queued, never decided in-loop): anything needing a migration, C++ engine
  changes, scope beyond A/B/C/D/F, acting on resignation-investigation findings, anything
  ambiguous about production data. Nil is online — asking early beats queueing when in doubt.
- Hard-blocked → queue it, work what is unblocked. Fully blocked → stop the loop cleanly,
  leave Nil a summary. Stop also on 3 consecutive gate failures on one slice.

## Slice plan

- [ ] S-A — puzzle banner + "Back to puzzles" visible on desktop (hoist, don't duplicate)
- [ ] S-B — bot client registers the true variant per bot; delete the
      `bot.id.includes("puzzle")` tiebreak; PuzzleBot out of the normal picker; bounded
      investigation of the `ixQQelmh` resignation (findings → parked queue)
- [ ] S-C — `dw-puzzle` samples 10000 → 5000; review `--parallel_samples 32`, raise only on
      evidence; ONE combined desktop bot restart + deploy covers B+C (B's pre-restart
      verification is code/config-level; both fully verified after the bounce)
- [ ] S-D — retry on a finished puzzle relaunches the same candidate into a fresh game,
      client-side only
- [ ] S-F — puzzle games excluded from Past Games; sweep history/profile/rankings surfaces
      for custom-setup leakage

## Deferred / parked

Do not pick up: E (takeback), G (first-class feature / named saved puzzles), H
(distance-delta rule), I (CI for C++, token rotation, alt-move representation).
G interaction note: the banner label comes from `findGeneratedCandidate()`, which G will
delete. S-A moves that code, never extends it.

Parked-for-Nil queue: (empty)

## Resources

- Deploy: `rm -rf /tmp/wg-deploy && mkdir -p /tmp/wg-deploy && git archive <sha> | tar -x -C /tmp/wg-deploy && cd /tmp/wg-deploy && ~/.fly/bin/fly deploy --remote-only`
- Bot restart: `ssh nilo@desktop-053vvpl-1`, then `tmux kill-session -t bot-client`, then
  `tmux new-session -d -s bot-client -n bot-client "bash ~/run_transformer_bot.sh"`, then
  confirm "Successfully attached" in `~/logs/bot-client-transformer.log`.
- Reviewer: Project Reviewer 1 = `agent-1780864878869-eq7t`, POST
  `localhost:4000/api/agents/<id>/messages` (isomux).
- Key files: `frontend/src/routes/game.$id.tsx` (mobile tree early-return ~261, desktop
  tree ~505; `findGeneratedCandidate` use at 46–49; back-link 285–294; banner 299–306),
  `frontend/src/routes/generated-candidates.tsx` (`bot.id.includes("puzzle")`),
  `official-custom-bot-client/transformer.prod.config.json` (both bots' config),
  `server/games/custom-bot-store.ts` (`botCapabilityVariant` collapse),
  `server/routes/games.ts` (unrated carve-out ~496–507).
- Phase-2 probes (2026-07-26, all ✓): build 0 errors; eslint clean; fly auth
  nil.mamano@gmail.com; desktop SSH ok, `bot-client` tmux alive, desktop repo clean at
  24e22d3; prod reachable (/, /generated-candidates 200); preview-url works (system Chrome
  on auntie); Reviewer 1 pinged. Baseline commit on auntie: 4fe69c6.

## SLICE-A PICKUP (authored at loop setup)

- Baseline: the commit that adds this file.
- Goal: on a desktop-width viewport, an active puzzle game shows the puzzle banner (name +
  goal sentence) and the "Back to puzzles" back-link, exactly as mobile already does.
- Load-bearing mechanics: `game.$id.tsx` has two separate layout trees (mobile early
  return ~261, desktop ~505); the banner/back-link were only added to the mobile branch.
  CLAUDE.md implementation rule 4 applies: hoist the shared chrome so it renders once —
  do not paste it into the desktop tree. Watch what the desktop tree renders in the same
  position (it may have its own header/back-link to reconcile rather than add alongside).
- Acceptance: puzzle game at ≥1280px shows banner + back-link; ordinary games and
  spectator view unchanged; mobile unchanged; build+lint clean; reviewer plan- and
  diff-gates signed off; post-deploy screenshot artifact plus code-level evidence.
- Locked (don't relitigate): no new fields on the game record; label keeps coming from
  `findGeneratedCandidate()` for now (deletion is G's job); no wrong-move anything.

## SLICE-N PICKUPS

Authored when the previous slice commits, folding in what it taught ("what S-<prev>
learned" block at the top of each).
