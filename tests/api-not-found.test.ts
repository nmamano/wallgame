/**
 * An unmatched path under /api answers with a JSON 404, not the SPA shell.
 *
 * Same bug class as robots.txt and sitemap.xml serving the app (fixed in
 * 1ffc080): two serveStatic catch-alls on `*` sit at the bottom of createApp,
 * so anything no route claimed used to come back as index.html with a 200. A
 * caller that asked for an endpoint which does not exist - a typo, a removed
 * route, a bot client on an old path - had to parse HTML to discover it failed.
 *
 * Like tests/seo-endpoints.test.ts and tests/html-shell.test.ts, and unlike
 * everything in tests/integration/, this starts no Postgres container and binds
 * no port: app.request() against the real createApp() is the whole harness.
 * Importing the server module still reads DATABASE_URL at import time, so an
 * inert one is set below.
 *
 * The shell fixture is not decoration. Without it the pre-fix response depended
 * on whether frontend/dist happened to exist - 200 HTML on a machine that had
 * built the frontend, a text/plain 404 from Hono in CI, where the suite runs
 * before the build. Supplying a shell makes the served bytes the same either
 * way, and matches production, which always loads one.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { parseHtmlShell } from "../server/routes/html-shell";

let createApp: typeof import("../server/index").createApp;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://inert:inert@127.0.0.1:5432/inert";
  ({ createApp } = await import("../server/index"));
});

/**
 * The nine tags parseHtmlShell rewrites, and nothing else. It requires exactly
 * one of each and throws otherwise, so this is as small as a valid shell gets.
 * The marker is what proves a response came from here rather than from any
 * other source of HTML.
 */
const SHELL_FIXTURE = `<!doctype html>
<html lang="en">
  <head>
    <title>Wall Game</title>
    <meta name="description" content="Original description." />
    <meta property="og:title" content="Original title" />
    <meta property="og:description" content="Original description." />
    <meta property="og:url" content="https://wallgame.io/" />
    <meta name="twitter:title" content="Original title" />
    <meta name="twitter:description" content="Original description." />
    <meta name="twitter:url" content="https://wallgame.io/" />
    <link rel="canonical" href="https://wallgame.io/" />
  </head>
  <body>
    <div id="root" data-fixture="shell-fixture-marker"></div>
  </body>
</html>
`;

const appWithShell = () =>
  createApp({ htmlShell: parseHtmlShell(SHELL_FIXTURE) }).app;

describe("unmatched paths under /api", () => {
  /**
   * Bare /api is here to pin a matcher claim rather than a caller's habit:
   * Hono's `/api/*` covers the parent path and the empty segment as well as a
   * nested one, and a future rewrite of the pattern could quietly stop doing so.
   * The POST row covers the other half - before the fix those already returned
   * 404, because the catch-alls are GET-only, but as text/plain.
   *
   * None of these sit under /api/games on purpose. `GET /api/games/:id` claims
   * every single segment there, so an invented path like /api/games/nonsense is
   * a MATCHED route that reads a game id, not an unmatched one - it belongs to
   * the case below, and asserting a 404 for it would be asserting the wrong
   * thing.
   */
  const unmatched = [
    { method: "GET", path: "/api/no-such-endpoint" },
    { method: "GET", path: "/api/no-such-endpoint/nested" },
    { method: "GET", path: "/api" },
    { method: "GET", path: "/api/" },
    { method: "POST", path: "/api/no-such-endpoint" },
  ];

  for (const { method, path } of unmatched) {
    it(`answers ${method} ${path} with a JSON 404`, async () => {
      const response = await appWithShell().request(path, { method });
      const body = await response.text();

      expect(response.status).toBe(404);
      // Tolerates the charset parameter; what matters is that it is not HTML.
      expect(response.headers.get("content-type")).toMatch(
        /^application\/json\b/,
      );
      expect(body.toLowerCase()).not.toContain("<!doctype html");
      // An exact body, not a subset check: this text is user-visible and a
      // caller may match on it, so a change to it should fail here first.
      expect(JSON.parse(body)).toEqual({ error: "Not found" });
    });
  }
});

describe("paths the fallback must not claim", () => {
  it("leaves a matched API route alone", async () => {
    const response = await appWithShell().request("/api/games/live");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(
      /^application\/json\b/,
    );
    // Reads the in-memory game store, so this needs no database.
    expect(await response.json()).toEqual({ games: [] });
  });

  it("still serves the app shell on a frontend deep link", async () => {
    const response = await appWithShell().request("/play");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html\b/);
    // The marker, not merely "some HTML": it proves the shell was rendered and
    // served, rather than the fallback having answered in a different dress.
    expect(body).toContain('data-fixture="shell-fixture-marker"');
  });
});
