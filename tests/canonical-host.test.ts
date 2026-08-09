/**
 * www.wallgame.io redirects to the apex, and no other host does.
 *
 * Requests carry an absolute URL rather than a path, because that is what sets
 * the host under test - the same quantity production reads, since Bun builds
 * Request.url from the Host header.
 *
 * Like tests/api-not-found.test.ts, this starts no Postgres and binds no port.
 * Importing the server still reads DATABASE_URL, so an inert one is set below.
 */

import { describe, it, expect, beforeAll } from "bun:test";

let createApp: typeof import("../server/app").createApp;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://inert:inert@127.0.0.1:5432/inert";
  ({ createApp } = await import("../server/app"));
});

describe("requests arriving on www.wallgame.io", () => {
  const redirected = [
    {
      what: "a deep link with a query string",
      from: "http://www.wallgame.io/game/abc123?ply=3&foo=bar",
      to: "https://wallgame.io/game/abc123?ply=3&foo=bar",
    },
    {
      what: "the bare root",
      from: "http://www.wallgame.io/",
      to: "https://wallgame.io/",
    },
    {
      what: "an https request",
      from: "https://www.wallgame.io/puzzles",
      to: "https://wallgame.io/puzzles",
    },
    // Ahead of the JSON 404 fallback and of every real API route.
    {
      what: "an unmatched /api path",
      from: "http://www.wallgame.io/api/no-such-endpoint",
      to: "https://wallgame.io/api/no-such-endpoint",
    },
    {
      what: "a real API route",
      from: "http://www.wallgame.io/api/games/live",
      to: "https://wallgame.io/api/games/live",
    },
    // The row this task exists for: ahead of the socket's origin and auth
    // middleware, which answer this path today.
    {
      what: "the game socket upgrade path",
      from: "http://www.wallgame.io/ws/games/abc123",
      to: "https://wallgame.io/ws/games/abc123",
    },
    {
      what: "a host written in capitals",
      from: "http://WWW.WALLGAME.IO/play?a=1",
      to: "https://wallgame.io/play?a=1",
    },
    {
      what: "a host carrying an explicit port",
      from: "http://www.wallgame.io:8080/play",
      to: "https://wallgame.io/play",
    },
    {
      what: "a bare ?, which the URL parser drops",
      from: "http://www.wallgame.io/play?",
      to: "https://wallgame.io/play",
    },
  ];

  for (const { what, from, to } of redirected) {
    it(`301s ${what}`, async () => {
      const response = await createApp().app.request(from);

      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe(to);
    });
  }

  it("redirects a POST as well as a GET", async () => {
    const response = await createApp().app.request(
      "http://www.wallgame.io/api/bots/play",
      { method: "POST" },
    );

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(
      "https://wallgame.io/api/bots/play",
    );
  });
});

describe("hosts the redirect must not touch", () => {
  /**
   * The last two rows are the substring trap: a predicate written with
   * includes(), startsWith() or endsWith() passes every other row in this file
   * and hands www.wallgame.io.evil.example an open redirect off our domain.
   */
  const untouched = [
    { what: "the apex", url: "https://wallgame.io/play" },
    { what: "the fly.dev host", url: "https://wallgame.fly.dev/play" },
    { what: "the vite dev origin", url: "http://localhost:5173/play" },
    { what: "the dev server itself", url: "http://localhost:3000/play" },
    { what: "a raw loopback address", url: "http://127.0.0.1:3000/play" },
    {
      what: "a lookalike host starting with www.wallgame.io",
      url: "http://www.wallgame.io.evil.example/play",
    },
    {
      what: "a lookalike host ending with wallgame.io",
      url: "http://notwww.wallgame.io/play",
    },
  ];

  for (const { what, url } of untouched) {
    it(`leaves ${what} alone`, async () => {
      const response = await createApp().app.request(url);

      // Whether /play is HTML or a 404 depends on frontend/dist, which CI
      // builds after this suite. Not being a redirect is the claim.
      expect(response.status).not.toBe(301);
      expect(response.headers.get("location")).toBeNull();
    });
  }

  it("still answers an API route on the apex", async () => {
    const response = await createApp().app.request(
      "https://wallgame.io/api/games/live",
    );

    expect(response.status).toBe(200);
    // Reads the in-memory game store, so this needs no database.
    expect(await response.json()).toEqual({ games: [] });
  });

  it("still answers an unmatched API path on a dev host with the JSON 404", async () => {
    const response = await createApp().app.request(
      "http://localhost:3000/api/no-such-endpoint",
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});
