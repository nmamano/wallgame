/**
 * Every HTML page carries the Content-Security-Policy (task 3c8fd31c), and
 * the policy allows the shell's inline script by its exact hash.
 *
 * The shell is the real frontend/index.html: its inline script is what the
 * built shell serves (vite copies it as is), so a change of that script
 * changes the hash this test reads, not a copy in the test.
 *
 * Like tests/html-shell.test.ts, this starts no Postgres and binds no port.
 * Importing the server still reads DATABASE_URL, so an inert one is set below.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHtmlShell } from "../server/routes/html-shell";
import { CSP_HEADER } from "../server/content-security-policy";

let createApp: typeof import("../server/app").createApp;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://inert:inert@127.0.0.1:5432/inert";
  ({ createApp } = await import("../server/app"));
});

const template = readFileSync(
  join(import.meta.dir, "../frontend/index.html"),
  "utf8",
);

/** The policy's directives, by name. */
const directives = (policy: string) =>
  Object.fromEntries(
    policy.split(";").map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );

const get = (path: string) =>
  createApp({ htmlShell: parseHtmlShell(template) }).app.request(
    `https://wallgame.io${path}`,
  );

describe("the page policy", () => {
  it("is report-only for now", () => {
    expect(CSP_HEADER).toBe("Content-Security-Policy-Report-Only");
  });

  for (const path of ["/", "/play", "/game/abc123", "/puzzles", "/ranking"]) {
    it(`${path} carries it`, async () => {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toStartWith("text/html");
      expect(res.headers.get(CSP_HEADER)).toBeTruthy();
    });
  }

  it("allows the shell's one inline script by its hash, and no other inline script", async () => {
    const bodies = [
      ...template.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g),
    ].map(([, body]) => body);
    expect(bodies).toHaveLength(1);
    const hash = `'sha256-${createHash("sha256").update(bodies[0]).digest("base64")}'`;

    const policy = directives((await get("/")).headers.get(CSP_HEADER)!);
    expect(policy["script-src"]).toEqual([
      "'self'",
      hash,
      "https://*.googletagmanager.com",
    ]);
    // The gtag loader in that script.
    expect(bodies[0]).toContain("https://www.googletagmanager.com/gtag/js");
  });

  it("names every directive the site needs, and nothing open", async () => {
    const policy = directives((await get("/")).headers.get(CSP_HEADER)!);
    expect(Object.keys(policy).sort()).toEqual(
      [
        "default-src",
        "script-src",
        "connect-src",
        "img-src",
        "style-src",
        "font-src",
        "object-src",
        "base-uri",
        "form-action",
        "frame-ancestors",
      ].sort(),
    );
    expect(policy["default-src"]).toEqual(["'self'"]);
    expect(policy["object-src"]).toEqual(["'none'"]);
    expect(policy["base-uri"]).toEqual(["'self'"]);
    expect(policy["connect-src"]).toContain("wss://wallgame.io");
    expect(policy["form-action"]).toEqual([
      "'self'",
      "https://wallgame.kinde.com",
    ]);
    expect(policy["frame-ancestors"]).toEqual([
      "'self'",
      "https://crazygames.com",
      "https://*.crazygames.com",
    ]);
    for (const sources of Object.values(policy)) {
      expect(sources).not.toContain("*");
      expect(sources).not.toContain("'unsafe-eval'");
    }
    expect(policy["script-src"]).not.toContain("'unsafe-inline'");
  });

  it("the app turns off Zod's eval probe before any other module loads", () => {
    const main = readFileSync(
      join(import.meta.dir, "../frontend/src/main.tsx"),
      "utf8",
    );
    const firstImport = /^import .*$/m.exec(main)?.[0];
    expect(firstImport).toBe('import "./lib/zod-jitless";');
  });

  it("an API answer carries no page policy", async () => {
    const api = await get("/api/no-such-endpoint");
    expect(api.headers.get("content-type")).toStartWith("application/json");
    expect(api.headers.get(CSP_HEADER)).toBeNull();
  });
});
