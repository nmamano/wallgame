/**
 * Does GA count an in-app navigation on wallgame.io?
 *
 * GA reports roughly a quarter of the games the server records. This is the
 * script that found out why.
 *
 * IT ANSWERED ITS QUESTION ALREADY, on 2026-08-05. The hypothesis it was built
 * to test - that enhanced measurement misses a change to a path PARAMETER, so
 * /game/A -> /game/B goes uncounted - turned out to be too narrow. A real click
 * from / to /play, two entirely different routes, also produced nothing. GA on
 * wallgame.io counts full document loads and NOTHING ELSE. Keep the script for
 * re-checking that after a deploy, not for re-deriving the same answer.
 *
 * It taps the wire: every event GA sends is an HTTP request to a collect
 * endpoint, so the requests the browser makes ARE the event stream, one step
 * before Google sees them.
 *
 * IT RUNS AGAINST PRODUCTION and therefore refuses to start without
 * --confirm-live-ga. gtag only initialises when location.hostname is
 * wallgame.io, so production is the only place it exists - but a run puts real
 * events into the real analytics property, and the ordinary reason to be
 * reading this file is not a reason to do that. For verifying a CHANGE, use
 * ga-report-verify.ts instead: that one is entirely offline.
 *
 * WHAT IT WRITES: nothing, now. An earlier version navigated to two EXISTING
 * replay URLs, and `GET /api/games/:id` runs `getReplayGame()`, which
 * increments `games.views` - so those runs did write to the production
 * database, contrary to what this header used to claim. It now uses invented
 * game ids AND intercepts every /api request with a local 404, so the real
 * production page and the real gtag still load and run while no game endpoint
 * is ever reached.
 *
 * It does still emit live analytics events into the real property, which is why
 * --confirm-live-ga stays.
 *
 *   node scripts/browser-harness/ga-navigation-events.mjs --confirm-live-ga
 */

import { chromium } from "playwright-core";

const args = process.argv.slice(2);
if (!args.includes("--confirm-live-ga")) {
  console.error(
    "Refusing to run: this sends real events to the live wallgame.io GA property.\n" +
      "For verifying a code change, use ga-report-verify.ts, which is offline.\n" +
      "To run anyway:\n" +
      "  node ga-navigation-events.mjs --confirm-live-ga",
  );
  process.exit(1);
}

// Invented, and never fetched - see the header. Two ids that differ is all the
// parameter-only step needs.
const replayA = "aaaaaaaa";
const replayB = "bbbbbbbb";

const SITE = "https://wallgame.io";

/**
 * Collect endpoints, matched broadly on purpose: GA uses regional hosts
 * (region1.google-analytics.com), the www and bare forms, and analytics.google.com.
 * Matching only one of them would read as "no events fired".
 */
function isCollect(url) {
  return (
    /(^|\.)google-analytics\.com/.test(new URL(url).hostname) ||
    /(^|\.)analytics\.google\.com/.test(new URL(url).hostname)
  );
}

/**
 * GA puts events in the query string, and in POST bodies when it batches, so
 * both have to be read. `en` is the event name and `dl` the page location.
 */
function eventsFrom(request) {
  const url = new URL(request.url());
  const found = [];

  const fromParams = (params, source) => {
    const name = params.get("en");
    if (!name) return;
    found.push({
      name,
      location: params.get("dl") ?? params.get("page_location") ?? "",
      source,
    });
  };

  fromParams(url.searchParams, "query");

  const body = request.postData();
  if (body) {
    for (const line of body.split("\n")) {
      if (line.trim()) fromParams(new URLSearchParams(line), "body");
    }
  }

  // The first request of a session carries no `en` - it is the config/page_view
  // pair gtag sends on load. Record it so the ladder's control is visible.
  if (found.length === 0 && url.searchParams.has("dl")) {
    found.push({
      name: url.searchParams.get("t") === "pageview" ? "page_view" : "(config)",
      location: url.searchParams.get("dl") ?? "",
      source: "query",
    });
  }

  return found;
}

const log = [];
let started = 0;

function record(step, events) {
  for (const event of events) {
    log.push({ step, at: Date.now() - started, ...event });
  }
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
// A fresh context every run: no extensions, no ad blocker, no prior consent or
// client id, so the first load is a genuine first load.
const context = await browser.newContext();

// The game endpoint increments a view counter, so it is answered locally. GA
// and the rest of the site are deliberately NOT intercepted: the whole point is
// to watch what the real production page really sends.
await context.route("**/api/**", (route) =>
  route.fulfill({
    status: 404,
    contentType: "application/json",
    body: '{"error":"intercepted by ga-navigation-events"}',
  }),
);

const page = await context.newPage();

let step = "0-setup";
page.on("request", (request) => {
  if (!isCollect(request.url())) return;
  record(step, eventsFrom(request));
});

// page_view only. Counting every recorded GA event would fold in session_start,
// first_visit and user_engagement, and report a step as "counted" when what
// actually fired was something else entirely.
const countIn = (name) =>
  log.filter((e) => e.step === name && e.name === "page_view").length;
const settle = (ms) => page.waitForTimeout(ms);

started = Date.now();

// --- Step 1: the control. A fresh load must produce a page_view, or nothing
// downstream means anything.
step = "1-initial-load";
await page.goto(SITE, { waitUntil: "networkidle" });
await settle(3000);

// A marker that does not survive a document reload, so a "navigation" that was
// really a full page load can be told apart from a client-side one.
const markContext = () =>
  page.evaluate(() => {
    window.__navProbe = true;
  });
const contextSurvived = () => page.evaluate(() => window.__navProbe === true);

// --- Step 2: a real in-app navigation to a DIFFERENT route.
step = "2-clientside-nav-different-route";
await markContext();
await page.click('a[href="/play"]');
await settle(3000);
const step2WasClientSide = await contextSurvived();

// --- Step 2b: control. Pushing the URL the page is already on should emit
// nothing; if it does, any count from step 2 is suspect.
step = "2b-same-path-duplicate";
await page.evaluate(() => history.pushState({}, "", location.pathname));
await settle(3000);

// --- Step 3: the hypothesis. Same route, different parameter.
step = "3-replay-A";
await page.goto(`${SITE}/game/${replayA}`, { waitUntil: "networkidle" });
await settle(3000);

step = "3b-param-only-push";
await markContext();
// Synthetic on purpose: TanStack's navigation ends in this same History API
// call, which is the primitive enhanced measurement patches. Reaching a second
// game page through the UI would mean creating one, which this must not do.
await page.evaluate((id) => history.pushState({}, "", `/game/${id}`), replayB);
await settle(4000);
const step3WasClientSide = await contextSurvived();

await browser.close();

console.log("\n=== every GA event on the wire, in order ===");
for (const event of log) {
  console.log(
    `${String(event.at).padStart(6)}ms  ${event.step.padEnd(32)} ${event.name.padEnd(12)} ${event.location}`,
  );
}

console.log("\n=== ladder ===");
console.log(
  `1  initial load                 page_views: ${countIn("1-initial-load")}`,
);
console.log(
  `2  in-app nav to /play           page_views: ${countIn("2-clientside-nav-different-route")}  (client-side: ${step2WasClientSide})`,
);
console.log(
  `2b same-path duplicate (control) page_views: ${countIn("2b-same-path-duplicate")}  (expected 0)`,
);
console.log(
  `3  load /game/${replayA}          page_views: ${countIn("3-replay-A")}`,
);
console.log(
  `3b param-only /game/${replayB}      page_views: ${countIn("3b-param-only-push")}  (client-side: ${step3WasClientSide})`,
);
