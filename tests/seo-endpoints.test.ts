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

describe("GET /sitemap.xml", () => {
  it("serves XML rather than the SPA shell", async () => {
    const { app } = createApp();

    const response = await app.request("/sitemap.xml");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/xml\b/);
    expect(body.toLowerCase()).not.toContain("<!doctype html");
    expect(body).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
  });

  it("advertises exactly the canonical pages", async () => {
    const { app } = createApp();

    const body = await (await app.request("/sitemap.xml")).text();

    // An exact list, not a subset check: a subset check would silently accept a
    // private or legacy URL that someone later appends to the route list.
    expect(sitemapLocations(body)).toEqual([
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
    const { app } = createApp();

    const body = await (await app.request("/sitemap.xml")).text();
    const locations = sitemapLocations(body);

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
});
