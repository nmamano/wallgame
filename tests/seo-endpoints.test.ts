/**
 * The two crawler-facing endpoints: /robots.txt and /sitemap.xml.
 *
 * This file deliberately sits outside tests/integration/. Everything in there
 * starts a Postgres container, and a reader finding this file among them would
 * reasonably assume it did too - but these endpoints touch no database, no
 * websocket and no port, so `app.request()` against the real `createApp()` is
 * the whole harness.
 *
 * Importing the server module still reads DATABASE_URL at import time
 * (server/db/index.ts throws without it), so one is set below. It is
 * deliberately inert AND unconditional: postgres.js connects lazily so nothing
 * ever dials it, and overwriting rather than defaulting means this file cannot
 * reach a real database even on a machine where DATABASE_URL points at one.
 */

import { describe, it, expect, beforeAll } from "bun:test";

let createApp: typeof import("../server/app").createApp;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://inert:inert@127.0.0.1:5432/inert";
  ({ createApp } = await import("../server/app"));
});

/** Every <loc> in document order, so tests can assert the exact URL set. */
function sitemapLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]);
}

describe("GET /robots.txt", () => {
  it("serves plain text rather than the SPA shell", async () => {
    const { app } = createApp();

    const response = await app.request("/robots.txt");
    const body = await response.text();

    expect(response.status).toBe(200);
    // Tolerates the charset parameter; what matters is that it is not html.
    expect(response.headers.get("content-type")).toMatch(/^text\/plain\b/);
    expect(body.toLowerCase()).not.toContain("<!doctype html");
  });

  it("points crawlers at the sitemap", async () => {
    const { app } = createApp();

    const body = await (await app.request("/robots.txt")).text();

    expect(body).toContain("Sitemap: https://wallgame.io/sitemap.xml");
  });

  it("blocks the unbounded per-game URLs and nothing else", async () => {
    const { app } = createApp();

    const body = await (await app.request("/robots.txt")).text();
    const disallowed = [...body.matchAll(/^Disallow:\s*(.*)$/gm)].map(
      (match) => match[1],
    );

    expect(disallowed).toEqual(["/game/"]);
  });
});

describe("buildSitemapXml", () => {
  it("appends puzzle pages after the canonical ones, changing neither", async () => {
    const { buildSitemapXml } = await import("../server/routes/seo");

    const withPuzzles = sitemapLocations(
      buildSitemapXml(["/puzzles/1", "/puzzles/2"]),
    );
    const without = sitemapLocations(buildSitemapXml());

    expect(withPuzzles.slice(0, without.length)).toEqual(without);
    expect(withPuzzles.slice(without.length)).toEqual([
      "https://wallgame.io/puzzles/1",
      "https://wallgame.io/puzzles/2",
    ]);
  });

  /**
   * The escaping the file has always carried, finally exercised. Until the
   * list came from the database every value was a constant with no XML
   * metacharacter in it, so nothing could tell whether escapeXml was wired up.
   */
  it("escapes a slug that would otherwise break the document", async () => {
    const { buildSitemapXml } = await import("../server/routes/seo");

    const xml = buildSitemapXml(["/puzzles/a&b<c"]);

    expect(xml).toContain("https://wallgame.io/puzzles/a&amp;b&lt;c");
    expect(xml).not.toContain("a&b<c");
  });

  it("advertises exactly the canonical pages when there are no puzzles", async () => {
    const { buildSitemapXml } = await import("../server/routes/seo");

    // An exact list, not a subset check: a subset check would silently accept
    // a private or legacy URL that someone later appends to the route list.
    expect(sitemapLocations(buildSitemapXml())).toEqual([
      "https://wallgame.io/",
      "https://wallgame.io/play",
      "https://wallgame.io/puzzles",
      "https://wallgame.io/learn",
      "https://wallgame.io/ranking",
      "https://wallgame.io/live-games",
      "https://wallgame.io/past-games",
      "https://wallgame.io/about",
      "https://wallgame.io/study-board",
    ]);
  });

  it("omits the legacy redirects and the per-visitor pages", async () => {
    const { buildSitemapXml } = await import("../server/routes/seo");

    const locations = sitemapLocations(buildSitemapXml(["/puzzles/1"]));

    // Named separately from the exact-set assertion above because when one of
    // these does appear, the failure should say which kind of mistake it was.
    for (const path of [
      "/solo-campaign",
      "/generated-candidates",
      "/profile",
      "/settings",
    ]) {
      expect(locations).not.toContain(`https://wallgame.io${path}`);
    }
  });

  it("stays well-formed XML with puzzles in it", async () => {
    const { buildSitemapXml } = await import("../server/routes/seo");

    const xml = buildSitemapXml(["/puzzles/1"]);

    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    expect(xml.trimEnd()).toEndWith("</urlset>");
    const opens = (xml.match(/<url>/g) ?? []).length;
    const closes = (xml.match(/<\/url>/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});

describe("GET /sitemap.xml", () => {
  /**
   * Every request in this file reaches a DATABASE_URL that nothing answers, so
   * the route takes its failure path. That is deliberate: the failure status
   * is the thing worth asserting here, and the document itself is asserted
   * against buildSitemapXml above, with the real database covered in
   * tests/integration/puzzle-votes.test.ts.
   */
  it("withholds the sitemap rather than serving an incomplete one", async () => {
    const { app } = createApp();

    const response = await app.request("/sitemap.xml");
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("3600");
    // Not a 200 carrying the canonical pages: that would assert a current set
    // the server cannot vouch for (review, 2026-08-16).
    expect(sitemapLocations(body)).toEqual([]);
  });

  it("answers in plain text rather than the SPA shell when it fails", async () => {
    const { app } = createApp();

    const response = await app.request("/sitemap.xml");
    const body = await response.text();

    expect(response.headers.get("content-type")).toMatch(/^text\/plain\b/);
    expect(body.toLowerCase()).not.toContain("<!doctype html");
  });
});
