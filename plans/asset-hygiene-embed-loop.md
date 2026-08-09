# Asset hygiene + embeddable mode loop — standing orders + slice handoffs

Board task `d75dfde3`. Re-read this file at the start of every iteration: a conversation
compacts, a file does not.

## North star

wallgame.io ships without the ~9.4 MB of pawn SVGs that no code path can reach, every
asset path still resolves when the app is served from a subdirectory, and
`https://wallgame.io/?embedded=1` gives a game portal a page with no login, no outbound
links and no third-party font request — while the site with no query param behaves exactly
as it does today.

That last clause is the one that must not be diluted. Every embedded behaviour is
**default off**.

## Process per slice

plan → written self-review → implement → gates → diff read → ONE focused commit.

Solo, no reviewer agent. That follows Nil's 2026-08-06 call: a small self-contained
feature gets one design check and one diff read, and the marginal effort belongs on
looking at the running thing. None of these slices touches game state, the database or
money. Screenshots go to Nil before anything user-visible.

## Gates per slice

Always run, before every commit:

    sg docker -c 'bun run ci'      # prettier --check, eslint, full suite, build

`docker` needs the `sg docker -c '...'` wrapper on this box. `bun run ci` takes ~6 min;
the integration files each start their own Postgres through Testcontainers.

Per-slice measurement gates are in each slice handoff below. All of them must be seen
FAILING against the known-bad state before they are trusted.

Not run by CI, and this matters for test placement: `scripts/run-tests.ts` globs
`tests/**/*.test.ts` only, so the three test files under `frontend/src/**` never run.
Anything that needs CI coverage must be importable from `tests/`.

## Standing rails

- Do NOT submit anything to any portal, and do NOT create an account anywhere.
- Do NOT deploy, and do NOT touch CORS or the websocket origin allowlist.
- Do NOT restart the `wallgame-dev-5174` systemd unit — that is Nil's puzzle playtest
  server. Run your own: `cd frontend && bun run dev -- --port 5175 --host 127.0.0.1`.
- Build to `frontend/dist` and nothing else. `.gitignore` and `.prettierignore` list
  `dist`, which does not match `dist-portal` or any other name, so a build to a different
  outDir puts hundreds of generated files in front of `format:check` and blocks every
  push.
- A blocked or denied command means stop and ask. Never route around it.
- Never weaken a gate to make it pass. Fix it, or park the decision for Nil.
- Slice 4 (hash history) is CANCELLED. The CrazyGames form offers an "iframe" engine with
  an IFrame link field, so we stay on our own origin and routing never changes. Do not
  rebuild it.

## Slice plan

- [ ] **Slice 1** — stop emitting a hashed copy of every pawn SVG that nothing imports.
- [ ] **Slice 2** — `assetUrl()` over `import.meta.env.BASE_URL` for the runtime-absolute
      asset paths, so a subdirectory mount stops 404ing.
- [ ] **Slice 3** — `?embedded=1`: hide the login entry point, hide the four outbound
      destinations, self-host the two font families.

Stopping after any slice is a legitimate finish. Slice 3 alone is the shortest path to a
CrazyGames submission; slices 1-2 are production wins that stand on their own.

## Deferred / parked

- Slice 4, hash history — cancelled, see above.
- 10 Wall (`e4a13c17`) — backlog, judged too large. Its slices and open decisions are
  written there. Do not restart it.
- Submitting to CrazyGames — Nil's, not this loop's.
- 62 of the 385 pawn SVGs are byte-identical to a sibling (290 cat files produced 235
  distinct content hashes, 10 home files produced 3). Deduplicating the SOURCE art is a
  separate question for Nil, not part of this task.

## Resources

- Task spec: board task `d75dfde3`. Its "CARE" note about the glob modules handing
  components an imported URL is **wrong** — see slice 1.
- Portal probe (exploratory, prints, asserts nothing): `ops-private/w4-portal-probe/`.
  Its `DIST` constant points at `frontend/dist-portal`, which no longer exists and must
  not be recreated.
- Browser harness house pattern: `scripts/browser-harness/`. `stub-server.ts` serves
  `frontend/dist` with a stubbed API; `drive-account-nudge.ts` is the one driver that
  ASSERTS and is the model for a gate. Every `harness:*` script is
  `bun run build && <driver>`.
- Baseline measured 2026-08-09 at `9d5ee2e`, `frontend/dist`: **1125 files, 41 MB**, of
  which `assets/*.svg` is 323 files / 9.4 MB and `pawns/` is 385 files / 11 MB.

---

## SLICE-1 PICKUP

**Baseline:** `9d5ee2e`, main clean, CI green.

**Goal:** the production build stops carrying a hashed copy of every pawn SVG.

**Load-bearing mechanics — read before designing.**

The task's warning that "the glob modules hand components an imported URL" is not what the
code does. All three of `cat-pawns.ts`, `mouse-pawns.ts` and `home-pawns.ts` call
`Object.keys(import.meta.glob(...))` and throw the loader functions away. Nothing in the
app ever imports a pawn SVG as a module. The duplication is therefore not two live
mechanisms in tension — it is 323 assets emitted because `import.meta.glob` puts 385
files from `public/` into Rollup's module graph, and no code path can reach any of them.

The single live URL mechanism is the string one: `resolvePawnStyleSrc()` in
`lib/pawn-style.ts` builds `/pawns/<type>/<name>.svg`, and `pawn-selector.tsx` joins its
`basePath` prop (`"/pawns/cat/"` etc., from `routes/settings.tsx` and
`routes/study-board.tsx`) to a filename. Both keep working untouched.

So the fix is to get the FILENAME LIST without importing the files. Rejected
alternatives:

- Move the art into `src/` and make the glob the sole mechanism. Biggest change of the
  three: pawn choices are persisted as bare filenames, and `resolvePawnStyleSrc` also
  accepts absolute paths and `http(s)` URLs, so hashed URLs would mean touching
  persistence semantics and every consumer, for no user-visible gain.
- Commit a generated list. Reintroduces the manual maintenance the original comment
  exists to avoid.

**Acceptance criteria.**

1. `find frontend/dist -type f | wc -l` drops by ~323 from 1125, and `du -sh frontend/dist`
   drops by ~9 MB from 41 MB.
2. `find frontend/dist/assets -name '*.svg' | wc -l` is 0.
3. `frontend/dist/pawns` still holds all 385 files.
4. The pawn lists are unchanged, in the same order — assert this against a list captured
   from the pre-change build, not against a hand-written expectation.
5. /settings and /study-board render every pawn option, and a game shows the chosen pawn.
   Screenshot both.
6. `sg docker -c 'bun run ci'` green.

**Locked — do not relitigate.** The art stays in `public/`. The string URL mechanism
stays. The "no manual maintenance" property stays.

---

## SLICE-2 PICKUP — authored when slice 1 commits

## SLICE-3 PICKUP — authored when slice 2 commits
