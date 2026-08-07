# Browser harness

Drives the **built frontend** in a real headless Chrome, against a stubbed
API, so questions about what a player actually sees can be answered with
evidence.

**`bun run ci` does not run any of this**, and cannot: these need a Chrome
binary and a current `frontend/dist`, neither of which the test gates can
assume. Most scripts here are tools you point at a question, and they print
what they found without judging it.

One exception, and it is deliberate: **`drive-account-nudge.ts` asserts.** It
is the gate for a change whose whole claim is about what a player sees, so it
measures, prints everything, and then exits non-zero if a required invariant
failed. Run it with `bun run harness:nudge`.

## Why it exists

Every other layer here checks a _part_ of the app. Unit tests check pure
functions. The probe scripts drive the server and the bot over a websocket.
Neither can tell you whether cards appear in waves, whether a nav bar fits,
or whether navigating back re-reads data - and reasoning about those from
source has produced confident wrong answers more than once.

## Running

Use the `harness:*` scripts. Each one is `bun run build && <driver>`, and the
`&&` is the point: a build that fails stops the run instead of leaving you at
a prompt to launch a driver against the previous commit's `dist`.

```bash
bun run harness:nudge     # the account nudge - ASSERTS, exits non-zero on failure
bun run harness:puzzles   # paint order, failure states, nav fit
bun run harness:campaign  # the worked example
bun run harness:pwa       # the manifest and its icons, against local dist
```

Running a driver directly still works and is sometimes what you want - a
second run against a build you have just made costs nothing extra. It is also
the one way to get a stale reading, so if you do it, build first and know that
nothing is checking you.

That failure is not hypothetical: on 2026-08-07 a type error failed the build,
the driver ran against the previous bundle, and the run reported a clean
failure of a feature that had never been loaded. The output looked exactly
like a real defect.

`drive-pwa-manifest.ts` has TWO modes and the URL decides which. With one, it
drives that live site and no build is involved. Without one, it serves local
`frontend/dist` through the stub - so the no-argument form goes stale exactly
like the others, and `harness:pwa` above is the form to use for it. Supply the
URL directly:

```bash
bun scripts/browser-harness/drive-pwa-manifest.ts https://wallgame.io/
```

(An earlier draft of this README called that script live-only. It is not, and
the driver's own header said so - which is a reminder that a claim about what a
script reads is worth checking against the script.)

Set `CHROME_PATH` if your Chrome is not on `PATH` as `google-chrome`,
`chromium`, or `chromium-browser`.

## The pieces

- **`cdp.ts`** - launches Chrome and talks the DevTools protocol to it:
  `evaluate`, `navigate`, `setViewport`, `screenshot`.
- **`stub-server.ts`** - serves `frontend/dist` plus whatever API answers the
  question needs, with optional latency. Records every `/api` request; read
  the log to tell "it re-read" from "it looked right by luck".
- **`drive-*.ts`** - one script per question.
- **`wall-edge-measure.mjs`** - where EXACTLY does a wall's edge fall, and its
  joint's? Reports both as sub-pixel positions. Reads the 50% crossing of the
  red channel between the plateau outside a shape and the one inside it,
  because a wall's neighbour is a CELL and a joint's is the darker background:
  the same geometry produces different-looking pixels on either side, so any
  absolute threshold reports a defect that is not there.
- **`joint-layers.mjs`** - WHICH LAYER is a wall/joint mismatch in? Three
  things can disagree and lumping them together is how an earlier attempt at
  this ended up rewriting the rasterizer: where CSS Grid put the CELL, where
  the joint's wrapper box sits, and where its artwork is actually PAINTED. The
  first two come from the DOM, the third only from pixels. It also paints the
  wrapper a solid colour as a control - if that lands on the wall's edge while
  the artwork does not, the geometry is fine and the artwork is short.

Both take `PROBE_BASE` (default `http://127.0.0.1:5175`) and `EDGE_DPR`;
`joint-layers.mjs` also takes `PROBE_THEME` (crisp|default). Run a dev server
first - they drive the source, not `dist`.

Measured 2026-08-05, on the div-based board, two walls meeting at a joint: the
wall box and the joint box agree to four decimals and the wall's edge sits
exactly on the grid cell's edge, at every DPR. The only non-zero readings are
at FRACTIONAL device pixel ratios, where the painted artwork lands 0.06-0.10
device px past the wall - a paint-time effect, not a geometry one. Reach for
these before proposing a coordinate change; that is a bug class that has
already cost this repo four commits and a rollback.

## Designing an experiment that proves what you think

Seeing the right thing on screen is not evidence that it got there the way
you assume. `drive-campaign-progress.ts` is the worked example: the question
is whether returning to a list RE-READS, and the answer only counts if the
new data could not possibly have arrived any earlier.

The shape that works:

1. Start the stub in the "before" state, and confirm the page shows it.
2. Get the app into position - here, onto the level page, which reads
   progress on mount and must still see the "before" state.
3. Flip the server-side state **from the driver**, not through the browser.
   No request, no cache write, nothing the app can observe.
4. Do the thing under test, then check both the screen and the request
   counter. Success requires the count to have increased AND the new state
   to be visible.

An earlier version flipped the state on the first read instead. The
checkmark still appeared, the log still showed three reads, and the
conclusion still happened to be right - but a read during level mount could
have produced the identical picture, so the experiment did not actually rule
out the alternative. If you cannot name what your setup makes impossible,
you are collecting anecdotes.

## Traps worth knowing

**Verify selectors by dumping the real class names.** This lucide version
renders `lucide-circle-check-big`. Guessing `lucide-check-circle-2` matches
nothing, and "zero checkmarks found" reads exactly like the bug you are
hunting. Match on a substring (`svg[class*="circle-check"]`), and when a
selector finds nothing, print the DOM before believing it.

**Never kill Chrome by matching its command line.** `launchChrome()` returns
the exact pid and a `stop()`. A pattern-matching kill on this box once
matched the office server and took it down twice.

**A stub that answers everything proves nothing.** `stub-server.ts` returns
501 for any route you did not define, on purpose - a silent `{}` would let a
page look healthy while asking for something that does not exist.

**Build before you drive.** The scripts serve `frontend/dist`. A stale dist
means you are measuring the previous version of your change, which is its own
special kind of wasted afternoon. `bun run harness:*` chains the build for
exactly this reason - reach for those rather than the driver path.
