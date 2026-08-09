/**
 * Does the navigation reporting actually fire, in the real app?
 *
 * The unit tests decide what SHOULD be reported. They cannot check the wiring,
 * because `gtag` only exists when `location.hostname` is wallgame.io - see the
 * guard in frontend/index.html - so the production code path never runs on a
 * normal dev server.
 *
 * This gets around that honestly rather than by relaxing the guard: Chrome is
 * told to resolve wallgame.io to this machine, so the page really is served
 * from that hostname and the real branch executes.
 *
 * Entirely offline. An earlier version proxied /api to production and called
 * itself read-only; it was not. `GET /api/games/:id` runs `getReplayGame()`,
 * which INCREMENTS `games.views`, so every run of that version quietly wrote to
 * the production database. Nothing here talks to production now: the API is
 * stubbed, the game ids are invented, and requests to Google hosts are aborted.
 *
 * The evidence is `window.dataLayer` - what our code queued, and in what order,
 * before any of Google's code ran. That is a claim about OUR behaviour, not
 * about delivery: whether Google accepts an event is a question only a real
 * production check can answer.
 *
 *   bun run build
 *   bun scripts/browser-harness/ga-report-verify.ts
 */

import { chromium, type Browser } from "playwright-core";

const PORT = 5176;
const HOST_NAME = "wallgame.io";
const BASE = `http://${HOST_NAME}:${PORT}`;
const dist = `${process.cwd()}/frontend/dist`;

/**
 * Two invented ids. What is under test is whether the ROUTER reports a
 * parameter change, which does not care whether a game exists - and inventing
 * them removes the last reason to touch production.
 */
const GAME_A = "aaaaaaaa";
const GAME_B = "bbbbbbbb";

/**
 * Serves the built app and stubs the API. Every /api route answers 404: the
 * page renders its not-found state, which is all this needs, because the router
 * resolves the route either way and that resolution is the thing being
 * measured.
 */
const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api")) {
      return Response.json({ error: "stubbed" }, { status: 404 });
    }

    const file = Bun.file(`${dist}${url.pathname}`);
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(`${dist}/index.html`), {
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  },
});

/** What every path outside the canonical list is called. */
const GENERIC_TITLE = "Wall Game - free online strategy board game";

interface PageViewEvent {
  page_path: string;
  page_title: string;
  page_location: string;
  page_referrer: string;
}

let browser: Browser | undefined;
const results: string[] = [];
let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  results.push(
    `${ok ? "PASS" : "FAIL"}  ${label.padEnd(46)} got ${JSON.stringify(actual)}${
      ok ? "" : `  expected ${JSON.stringify(expected)}`
    }`,
  );
}

try {
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    // The whole point: the app must believe it is on the production hostname.
    args: [`--host-resolver-rules=MAP ${HOST_NAME} 127.0.0.1`],
  });

  const context = await browser.newContext();

  // An allowlist of exactly one host, rather than a blocklist of the ones I
  // happened to think of. wallgame.io is mapped to the local server above, so
  // everything the app legitimately needs resolves here - and everything else,
  // including Google Fonts and any analytics endpoint, never leaves. That is
  // what makes "offline" a checkable claim instead of a hopeful one.
  await context.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host !== HOST_NAME) return route.abort();
    return route.continue();
  });

  const page = await context.newPage();

  /** Every page_view our code has pushed, in order. */
  const reported = () =>
    page.evaluate(() => {
      const layer =
        (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
      return layer
        .map((entry) => Array.from(entry as ArrayLike<unknown>))
        .filter((args) => args[0] === "event" && args[1] === "page_view")
        .map((args) => args[2] as PageViewEvent);
    });

  const since = async (before: number) => (await reported()).slice(before);
  const count = async () => (await reported()).length;

  /**
   * Waits for the event itself rather than for the URL. `location.pathname`
   * changes when the History API is called, which is BEFORE the router has
   * resolved and before anything is reported - so waiting on the URL and then
   * reading the events is a race that passes by luck on a fast machine.
   */
  async function waitForOneMore(before: number, expectedPath: string) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const batch = await since(before);
      if (batch.length > 0) return batch;
      await page.waitForTimeout(100);
    }
    results.push(`FAIL  no event within 4s for ${expectedPath}`);
    failures++;
    return [];
  }

  // Arrive the way 88% of real visitors do. This is not decoration: an omitted
  // page_referrer makes gtag substitute document.referrer, and document.referrer
  // is exactly this value - for the whole visit, since no document is ever
  // loaded again. Without a real external referrer here, the bug this guards
  // against cannot appear even when the code has it.
  await page.setExtraHTTPHeaders({ referer: "https://www.google.com/" });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  check(
    "the visit really began off-site",
    await page.evaluate(() => document.referrer),
    "https://www.google.com/",
  );

  check(
    "gtag guard passed (hostname)",
    await page.evaluate(() => location.hostname),
    HOST_NAME,
  );
  // The config-owned initial page_view is gtag's own; ours must not add one.
  check("initial load emits no explicit event", await count(), 0);

  // --- a real click to a different route
  let mark = await count();
  await page.click('a[href="/play"]');
  let batch = await waitForOneMore(mark, "/play");
  check("/ -> /play events", batch.length, 1);
  check("/ -> /play path", batch[0]?.page_path, "/play");
  check(
    "/ -> /play title matches destination",
    batch[0]?.page_title,
    "Play Wall Game online - free, no account needed",
  );
  check("/ -> /play location", batch[0]?.page_location, `${BASE}/play`);
  // The page just left, and it must be OURS. Left out of the payload, gtag
  // substitutes document.referrer, which in a single-page app is still whatever
  // brought the visitor in - so this asserts against a real external arrival
  // below, where the substitution would actually be visible.
  check("/ -> /play referrer", batch[0]?.page_referrer, `${BASE}/`);
  check(
    "document.title already set at send time",
    await page.title(),
    batch[0]?.page_title,
  );

  // --- the same location again: nothing
  mark = await count();
  await page.evaluate(() => {
    history.pushState({}, "", location.pathname);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForTimeout(800);
  check("identical location emits nothing", (await since(mark)).length, 0);

  // --- parameter-only, between two invented ids
  const a = GAME_A;
  const b = GAME_B;

  await page.goto(`${BASE}/game/${a}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  mark = await count();
  // A raw pushState alone does not make TanStack resolve; the popstate is what
  // its history listener acts on, so this is a genuine router resolution and
  // not a synthetic call into our own subscription.
  await page.evaluate((id) => {
    history.pushState({}, "", `/game/${id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, b);
  batch = await waitForOneMore(mark, `/game/${b}`);
  check(`/game/${a} -> /game/${b} events`, batch.length, 1);
  check("param-only path", batch[0]?.page_path, `/game/${b}`);
  check("param-only title", batch[0]?.page_title, GENERIC_TITLE);
  check("param-only location", batch[0]?.page_location, `${BASE}/game/${b}`);
  check("param-only referrer", batch[0]?.page_referrer, `${BASE}/game/${a}`);

  // --- back, then forward. Asserted by destination, not only by count: a
  // stale or swapped event has the same count as a correct one.
  mark = await count();
  await page.goBack();
  batch = await waitForOneMore(mark, `/game/${a}`);
  check("back emits one", batch.length, 1);
  check("back path", batch[0]?.page_path, `/game/${a}`);
  check("back title", batch[0]?.page_title, GENERIC_TITLE);
  check("back location", batch[0]?.page_location, `${BASE}/game/${a}`);

  mark = await count();
  await page.goForward();
  batch = await waitForOneMore(mark, `/game/${b}`);
  check("forward emits one", batch.length, 1);
  check("forward path", batch[0]?.page_path, `/game/${b}`);
  check("forward title", batch[0]?.page_title, GENERIC_TITLE);
  check("forward location", batch[0]?.page_location, `${BASE}/game/${b}`);
  check("forward referrer", batch[0]?.page_referrer, `${BASE}/game/${a}`);

  // The whole visit at once. Per-step assertions each check one payload; this
  // one checks that NOTHING anywhere in the visit still points at Google, which
  // is the shape the real property saw.
  const all = await reported();
  check(
    "no reported navigation came from off-site",
    all.filter((event) => !event.page_referrer?.startsWith(BASE)),
    [],
  );
} finally {
  await browser?.close();
  void server.stop(true);
}

console.log("\n=== navigation reporting, real app, production hostname ===");
for (const line of results) console.log(line);
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
