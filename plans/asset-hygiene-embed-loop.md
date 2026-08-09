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

- [x] **Slice 1** — stop emitting a hashed copy of every pawn SVG that nothing imports.
      Landed 2026-08-09. `dist` went 1125 files / 41 MB -> 417 files / 30 MB.
- [x] **Slice 2** — `assetUrl()` over `import.meta.env.BASE_URL` for the runtime-absolute
      asset paths, so a subdirectory mount stops 404ing. Landed 2026-08-09. 27 call sites
      across 10 files, not the 20 across 7 the task estimated.
- [x] **Slice 3** — `?embedded=1`: hide the login entry point, hide the four outbound
      destinations, self-host the two font families. Landed 2026-08-09, after Project
      Reviewer 1 blocked the first attempt over the analytics tag.

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

## SLICE-2 RECORD

**Baseline:** `ca390c8`.

**What slice 1 taught, and slice 2 used.** Both of slice 1's surprises were the task's
numbers being low - 708 wasted files, not ~290 - so slice 2 started by counting rather
than by trusting: 27 call sites across 10 files, against the task's "20 runtime-absolute
paths across 7 files". The extra three files are `routes/learn.tsx` (two images the task
listed under other files) and `lib/pawn-style.ts`, which builds the pawn URL that
`board.tsx` and `player-timer-card.tsx` render.

**Measured, same instrument both times**, serving `frontend/dist` built with
`--base=/embed/wall-game/` under that subdirectory: 7 asset 404s before (six sound
effects and the logo), 0 after. `/api/me` 404s in both and always will - a CDN has no
backend.

**The probe lied once, in my favour's opposite direction.** Its first version fetched
`"/audio/songs/song1.mp3"` with a hardcoded absolute path of its own, so after the fix it
still reported a 404 that the app was no longer responsible for. An instrument that
hardcodes what it is testing for measures itself. Fixed to resolve against
`document.baseURI`.

**What the browser probe cannot see.** Under a subdirectory the router renders "Not
Found", because it has default path history and no basepath - that was slice 4, which is
cancelled. So only what renders outside the router outlet is reachable: the nav logo, and
`sounds.ts`, which builds its `Audio` objects at module scope. The time-control icons, the
learn images and the pawn paths are covered by the static gate in
`tests/asset-url.test.ts` instead, which fails if any `frontend/src` file starts a string
literal with a `public/` path outside an `assetUrl()` call. It found all 27; it now finds
none.

**Production is unchanged.** At the root base `assetUrl` is a no-op:
`joinAssetPath("/", "/logo.png") === "/logo.png"`. Verified in Chrome against the root
build - `/`, `/learn` and `/play` resolve `/logo.png`, `/starting-position.png` and
`/board-coordinates.png` exactly as before, with no failed requests.

**Left alone deliberately:** `public/favicon/site.webmanifest` hardcodes `start_url`,
`scope` and three icon paths at the root. It is a static file, so `assetUrl` cannot reach
it, and under a subdirectory mount a portal never reads a manifest anyway. Fixing it
belongs to whoever needs an installable PWA at a non-root path.

---

## SLICE-3 PICKUP

**Baseline:** the slice-2 commit.

**Goal:** `https://wallgame.io/?embedded=1` renders a page a game portal will accept, and
`https://wallgame.io/` renders exactly what it does today.

**Load-bearing mechanics.**

- The flag must be LATCHED. A query param survives the initial load only; the first
  client-side navigation drops it. Latch to `sessionStorage` on first read, so the whole
  tab session stays embedded. Consequence worth accepting: a tab that once opened
  `?embedded=1` stays embedded until it is closed.
- Follow the house pattern in `lib/anonymous-id.ts`: a two-method storage interface so a
  test can pass its own, and a guarded accessor, because reading `window.sessionStorage`
  can itself throw in some privacy modes. Import `IdStorage` rather than declaring a
  second identical interface.
- Three things to hide: the login entry point (`components/navigation.tsx` builds a nav
  item labelled Profile/Login); `DISCORD_INVITE_URL` (`routes/index.tsx`,
  `routes/about.tsx`); and the nilmamano.com and en.wikipedia.org links in
  `routes/index.tsx` (x2) and `routes/about.tsx` (x4). The about-page links live inside a
  markdown template literal, so the conditional has to produce plain text, not an anchor.
- Fonts are the one part that CANNOT be flag-gated: `index.html` is static. Self-host
  unconditionally with `@fontsource/cormorant` and `@fontsource/geist-mono` (both 5.3.0,
  confirmed reachable 2026-08-09) at the weights the Google CSS2 query asks for -
  Cormorant 300/400/600/700, Geist Mono 400/500/600. Importing the CSS also gets the
  woff2 files base-rewritten by Vite for free, which is slice 2's problem solved for
  fonts.
- Because fonts are unconditional, this slice IS user-visible on wallgame.io. Screenshot
  the same pages before and after and show Nil, per the standing rule.

**Acceptance criteria.**

1. With no query param: the nav still has its Profile/Login item, all six outbound links
   are present, and the rendered pages are visually unchanged.
2. With `?embedded=1`: no login entry point, no outbound link to discord.gg,
   nilmamano.com or wikipedia.org, and no request to any host outside our own origin.
3. The latch survives a client-side navigation away from the URL carrying the param.
4. `sg docker -c 'bun run ci'` green.

**SLICE-3 RECORD — the probe was the thing at fault.**

Project Reviewer 1 blocked the first attempt: `index.html` injects Google Analytics, and
a portal frame must contact no third party at all. My browser probe had reported "zero
external hosts" and that measured NOTHING - analytics is gated to
`location.hostname === "wallgame.io"`, the probe served from `127.0.0.1`, so the whole
block was skipped. On the real URL it would have loaded.

This is the same error twice recorded in `ops-private/wallgamer-agent-notes.md`:
confirming the ABSENCE of something with an instrument that could not have shown its
presence. The tell was there and I read past it - a page that demonstrably ships an
analytics tag reporting no external hosts should prompt "why none?", not "good, none".

The repair removes localhost from the question entirely. `tests/embedded-analytics.test.ts`
extracts the shipped inline script from `index.html` and EXECUTES it - `new Function` plus
`with (window)`, so the script's bare `gtag(...)` resolves to the `window.gtag` it just
assigned, as in a browser - against a fake page whose hostname is `wallgame.io`, then
asserts what reached `document.head`. Deleting the `!embedded &&` guard fails 4 of its 9
tests. Alongside it, a probe launching Chrome with
`--host-resolver-rules="MAP wallgame.io 127.0.0.1"` gets a genuine production hostname and
aborts every Google request while recording it, so the check never calls out for real.

Two more things this slice taught:

- The suppression HAS to live in `index.html`, in plain JS. That script runs before any
  module, so by the time `lib/embedded-mode.ts` could answer, the tag would already be
  appended. The duplication is therefore forced, not lazy; the two literal-agreement
  tests are the drift alarm and the execution test is the behavioural gate.
- A background-task completion notification reports the WRAPPER's exit code. One CI run
  here failed on eslint while the notification said "exit code 0". Always echo the real
  status inside the command.
