/**
 * Cache headers of the built site (task f23b28a4): a hashed file under
 * /assets is kept a year; a missing /assets name is a 404 that nobody keeps
 * (before, it was the HTML page, which Cloudflare cached for 4 h); the page
 * itself is checked again on each visit.
 *
 * The static handlers read ./frontend/dist from the working directory, and
 * the suite runs before the build, so this test works in a temp folder with
 * a small built site of its own.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="d" />
    <link rel="canonical" href="https://wallgame.io/" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://wallgame.io/" />
    <meta property="og:title" content="t" />
    <meta property="og:description" content="d" />
    <meta name="twitter:url" content="https://wallgame.io/" />
    <meta name="twitter:title" content="t" />
    <meta name="twitter:description" content="d" />
    <title>t</title>
  </head>
  <body><script type="module" src="/assets/index-AbCd1234.js"></script></body>
</html>
`;

const YEAR = "public, max-age=31536000, immutable";
let app: ReturnType<(typeof import("../server/app"))["createApp"]>["app"];
let appWithShell: typeof app;
let previousCwd: string;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:9/unused";
  previousCwd = process.cwd();
  const site = mkdtempSync(join(tmpdir(), "asset-cache-"));
  mkdirSync(join(site, "frontend/dist/assets"), { recursive: true });
  writeFileSync(join(site, "frontend/dist/index.html"), SHELL);
  writeFileSync(join(site, "frontend/dist/assets/index-AbCd1234.js"), "1;");
  writeFileSync(join(site, "frontend/dist/logo.png"), "png");
  process.chdir(site);
  const { createApp } = await import("../server/app");
  const { parseHtmlShell } = await import("../server/routes/html-shell");
  app = createApp().app;
  appWithShell = createApp({ htmlShell: parseHtmlShell(SHELL) }).app;
});

afterAll(() => process.chdir(previousCwd));

describe("cache headers of the built site", () => {
  // Production runs with the shell, which goes first; both apps must leave
  // /assets to the static handlers.
  it("keeps a hashed file under /assets a year", async () => {
    for (const a of [app, appWithShell]) {
      const res = await a.request("/assets/index-AbCd1234.js");
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe(YEAR);
    }
  });

  it("answers a missing /assets name with a 404 that nobody keeps", async () => {
    for (const a of [app, appWithShell]) {
      const res = await a.request("/assets/index-Gone9999.js");
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).not.toContain("text/html");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("checks the page again on each visit: / and an app route", async () => {
    for (const a of [app, appWithShell]) {
      for (const path of ["/", "/play"]) {
        const res = await a.request(path);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("/assets/index-AbCd1234.js");
        expect(res.headers.get("Cache-Control")).toBe("no-cache");
      }
    }
  });

  it("leaves a file outside /assets without a long cache", async () => {
    const res = await app.request("/logo.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});
