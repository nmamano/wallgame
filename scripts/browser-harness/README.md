# Browser harness

Drives the **built frontend** in a real headless Chrome, against a stubbed
API, so questions about what a player actually sees can be answered with
evidence.

This is **not a test suite.** Nothing here asserts, and no gate runs it: it
needs a Chrome binary and a current `frontend/dist`, neither of which the
test gates can assume. It is a tool you point at a question, and it prints
what it found.

## Why it exists

Every other layer here checks a _part_ of the app. Unit tests check pure
functions. The probe scripts drive the server and the bot over a websocket.
Neither can tell you whether cards appear in waves, whether a nav bar fits,
or whether navigating back re-reads data - and reasoning about those from
source has produced confident wrong answers more than once.

## Running

```bash
bun run build                                          # dist must be current
bun scripts/browser-harness/drive-puzzles-page.ts      # paint order, failure states, nav fit
bun scripts/browser-harness/drive-campaign-progress.ts # the worked example
```

Set `CHROME_PATH` if your Chrome is not on `PATH` as `google-chrome`,
`chromium`, or `chromium-browser`.

`seam-probe.mjs` is the odd one out: it asks a question about pixels rather
than about behaviour, so it drives the **dev server** (no build, no stub) and
uses `playwright-core` for its screenshot and DPR control instead of `cdp.ts`.

```bash
cd frontend && bun run dev -- --port 5175 --host 127.0.0.1   # in another shell
bun scripts/browser-harness/seam-probe.mjs                   # walls vs joints
bun scripts/browser-harness/wall-edge-measure.mjs            # exact edge positions
bun scripts/browser-harness/shadow-equivalence.mjs           # CSS shadow vs SVG (no server needed)
PROBE_THEME=default PROBE_FIXTURE=puzzle bun scripts/browser-harness/seam-probe.mjs
```

Env: `PROBE_BASE`, `PROBE_DPRS`, `PROBE_THEME` (crisp|default), `PROBE_FIXTURE`
(twocolour|puzzle). It exercises a matrix of device pixel ratios because the
defect it was written for appears at some and not others.

## The pieces

- **`cdp.ts`** - launches Chrome and talks the DevTools protocol to it:
  `evaluate`, `navigate`, `setViewport`, `screenshot`.
- **`stub-server.ts`** - serves `frontend/dist` plus whatever API answers the
  question needs, with optional latency. Records every `/api` request; read
  the log to tell "it re-read" from "it looked right by luck".
- **`drive-*.ts`** - one script per question.
- **`wall-edge-measure.mjs`** - where EXACTLY does a wall's edge fall, and its
  joint's? Reports both as sub-pixel positions and prints the colour profile
  down the run. This is the instrument; `seam-probe.mjs` is the gate. Reach for
  it when the gate fires, or when a render looks wrong and you need a number
  rather than an opinion - it is what caught a joint painted 0.48 device px
  wider than its wall, which a coverage test cannot see because nothing is
  missing.
- **`seam-probe.mjs`** - is a wall joint painted a pixel off from the wall it
  joins? Compares the joint's brightness against its own wall's at the SAME
  column. An absolute test ("is it the wall colour?") flags every shape's
  antialiased outer edge and reports a bug that is not there; only the
  difference between the two sides is a defect. It still understands the
  pre-fix DOM (wall divs, per-joint divs), so it can be pointed at older code
  and shown to go red - a check never observed failing is not evidence.
  Checks TWO independent failures: a coverage deficit inside the run (a hole),
  and a mismatch between where the wall's side edge falls and where the joint's
  does (an overhang). The second was missing at first, and a joint painted
  wider than its wall sailed through a clean run - nothing was missing, so
  there was no hole to find.

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
special kind of wasted afternoon.
