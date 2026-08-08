/**
 * Which SESSION does an in-app navigation belong to?
 *
 * Sibling of ga-navigation-events.mjs. That one asked whether an in-app
 * navigation is counted at all, and the answer (2026-08-05) was no, which is
 * why we now send page_view ourselves. This one asks the question that answer
 * created: the events fire, but do they land in the visitor's EXISTING session?
 *
 * The symptom that prompted it, measured on the GA property 2026-08-08: since
 * the manual page_view shipped on 2026-08-05, an "Unassigned" channel appeared
 * holding 96 sessions/day with source/medium "(not set)", 0 new users and 0
 * engaged sessions. Nobody new arrived - existing visits were being split.
 *
 * GA puts the session on the wire, so the wire can answer it. Per request:
 *
 *   sid  session id      - a NEW value means a new session began
 *   sct  session count   - which session this is for this browser
 *   _ss  session start   - present, and 1, on the first event of a session
 *   dr   document referrer - what GA attributes the session FROM
 *   seg  session engaged
 *
 * IT ANSWERED ITS QUESTION ALREADY, on 2026-08-08, and the answer was NO: the
 * hypothesis it was built to test - that our manual page_view starts a second
 * session - is WRONG. Every event carried the SAME `sid` as the load. What the
 * run did show, in the column that was only there as context, is the actual
 * fault:
 *
 *     11837ms  page_view  sid=1786211805  ...  https://www.google.com/
 *
 * The referrer on an in-app navigation was still Google. Nothing in the payload
 * set `page_referrer`, so gtag substituted `document.referrer`, which a
 * single-page app never updates - and every navigation of the visit therefore
 * re-announced an external arrival. Fixed by building the referrer from the
 * page being left; see PageViewPayload in frontend/src/lib/analytics.ts.
 *
 * So this is now a POST-DEPLOY re-check, not a diagnosis: after the fix ships,
 * the `referrer` column on every event below the first must read wallgame.io.
 * Before it ships, running it reproduces the bug, which is the one way to know
 * the check can fail.
 *
 * IT RUNS AGAINST PRODUCTION, for the same reason its sibling does - gtag only
 * initialises on wallgame.io - and so it carries the same guard. A run emits a
 * handful of real events into the real property.
 *
 * Unlike its sibling it does NOT stub the API. That script had to, because it
 * visited /game/:id and `getReplayGame()` increments a view counter. This one
 * walks /, /play and /puzzles, which only read - and a stubbed API leaves the
 * app half-rendered, which is itself a way to measure nothing and believe it.
 *
 *   node scripts/browser-harness/ga-session-attribution.mjs --confirm-live-ga
 */

import { chromium } from "playwright-core";

if (!process.argv.slice(2).includes("--confirm-live-ga")) {
  console.error(
    "Refusing to run: this sends real events to the live wallgame.io GA property.\n" +
      "To run anyway:\n" +
      "  node scripts/browser-harness/ga-session-attribution.mjs --confirm-live-ga",
  );
  process.exit(1);
}

const SITE = "https://wallgame.io";

function isCollect(url) {
  const { hostname } = new URL(url);
  return (
    /(^|\.)google-analytics\.com/.test(hostname) ||
    /(^|\.)analytics\.google\.com/.test(hostname)
  );
}

/**
 * The session fields live in the QUERY string even when the events themselves
 * are batched into the body, because they describe the request's browser rather
 * than any one event. So both are read, and the query is treated as the default
 * for every event in the body.
 */
function readRequest(request) {
  const url = new URL(request.url());
  const q = url.searchParams;
  const shared = {
    sid: q.get("sid") ?? "",
    sct: q.get("sct") ?? "",
    ss: q.get("_ss") ?? "",
    seg: q.get("seg") ?? "",
    dr: q.get("dr") ?? "",
    fv: q.get("_fv") ?? "",
  };

  const events = [];
  const push = (params) => {
    const name = params.get("en");
    if (!name) return;
    events.push({
      name,
      dl: params.get("dl") ?? shared.dl ?? "",
      ...shared,
      // A batched event may override the session fields for itself.
      sid: params.get("sid") ?? shared.sid,
      ss: params.get("_ss") ?? shared.ss,
      dr: params.get("dr") ?? shared.dr,
    });
  };

  push(q);
  const body = request.postData();
  if (body) {
    for (const line of body.split("\n")) {
      if (line.trim()) push(new URLSearchParams(line));
    }
  }
  if (events.length === 0 && q.has("dl")) {
    events.push({ name: "(no en)", dl: q.get("dl") ?? "", ...shared });
  }
  return events;
}

const log = [];
let step = "0-setup";
let started = 0;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext();

const page = await context.newPage();
page.on("request", (request) => {
  if (!isCollect(request.url())) return;
  for (const event of readRequest(request)) {
    log.push({ step, at: Date.now() - started, ...event });
  }
});

// A step that navigated nowhere and a step that navigated and was not counted
// look identical in the event log, and only one of them is an analytics bug.
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(`${step}: ${error.message}`));
const whereAreWe = async (label) =>
  console.log(`  [${label}] url=${page.url()}  events so far=${log.length}`);

const settle = (ms) => page.waitForTimeout(ms);
started = Date.now();

// The control: a real load, with a referrer, so there is a healthy session to
// compare against. Referred from Google, because that is where 88% of real
// visitors come from and "(direct)" would hide an attribution bug.
step = "1-load-referred-from-google";
await page.setExtraHTTPHeaders({ referer: "https://www.google.com/" });
await page.goto(SITE, { waitUntil: "networkidle" });
await settle(3000);
await whereAreWe(step);

// The subject: exactly what a player does, and what we now report ourselves.
// A marker that a document reload would wipe, so a "navigation" that was really
// a full load cannot be mistaken for the client-side one being measured.
step = "2-in-app-nav-to-play";
await page.evaluate(() => {
  window.__navProbe = true;
});
await page.click('a[href="/play"]');
await settle(3000);
const stillSameDocument = await page.evaluate(() => window.__navProbe === true);
await whereAreWe(step);
console.log(`  [${step}] client-side (same document)=${stillSameDocument}`);

step = "3-in-app-nav-to-puzzles";
await page
  .click('a[href="/puzzles"]')
  .catch((e) => console.log(`  ${e.message.split("\n")[0]}`));
await settle(3000);
await whereAreWe(step);

await browser.close();

if (pageErrors.length) {
  console.log("\n=== uncaught page errors ===");
  for (const e of pageErrors) console.log(`  ${e}`);
}

console.log("\n=== every GA event on the wire, with its session ===\n");
console.log(
  `${"at".padStart(7)}  ${"step".padEnd(30)} ${"event".padEnd(14)} ${"sid".padEnd(12)} ${"sct".padEnd(4)} ${"_ss".padEnd(4)} ${"seg".padEnd(4)} referrer`,
);
for (const e of log) {
  console.log(
    `${String(e.at).padStart(5)}ms  ${e.step.padEnd(30)} ${e.name.padEnd(14)} ${String(e.sid).padEnd(12)} ${String(e.sct).padEnd(4)} ${String(e.ss).padEnd(4)} ${String(e.seg).padEnd(4)} ${e.dr || "(none)"}`,
  );
}

const sessions = [...new Set(log.map((e) => e.sid).filter(Boolean))];
console.log(`\ndistinct session ids seen: ${sessions.length}`);
console.log(
  sessions.length > 1
    ? "  MORE THAN ONE. An in-app navigation started a new session."
    : "  one. Every event landed in the session the load created.",
);

// The finding. Everything after the initial load is an in-app navigation, and
// an in-app navigation that still names an outside site as its referrer is the
// bug this file exists to catch.
const stale = log
  .slice(1)
  .filter((e) => e.dr && !e.dr.startsWith("https://wallgame.io"));
console.log(`\nin-app navigations still referred from off-site: ${stale.length}`);
console.log(
  stale.length > 0
    ? `  NOT FIXED - e.g. ${stale[0].dr}. Every one of these tells GA the\n` +
        "  visitor just arrived from outside, mid-session."
    : "  none. Every reported navigation names a page of ours.",
);
