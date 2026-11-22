/**
 * After a log-in or a sign-up the player goes back to the page they left
 * (task B), never to another site.
 *
 * No database and no Kinde call: /api/login and /api/register only build the
 * Kinde URL (see logout.test.ts for the same harness). The callback itself
 * needs a real Kinde code, so its one new line is covered through
 * `takeReturnPath` on a bare Hono app.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { SIGNUP_GUEST_GAMES_COOKIE } from "../shared/contracts/user";
import {
  RETURN_COOKIE,
  safeReturnPath,
  takeReturnPath,
} from "../server/routes/auth-return";

let createApp: typeof import("../server/app").createApp;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://inert:inert@127.0.0.1:5432/inert";
  process.env.KINDE_DOMAIN ??= "https://example.kinde.com";
  process.env.KINDE_CLIENT_ID ??= "test-client-id";
  process.env.KINDE_REDIRECT_URI ??= "http://localhost:5173/api/callback";
  ({ createApp } = await import("../server/app"));
});

/** The return cookie a response sets, or "cleared", or null if untouched. */
const returnCookie = (response: Response): string | null => {
  const cookie = response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${RETURN_COOKIE}=`));
  if (!cookie) return null;
  if (/max-age=0/i.test(cookie)) return "cleared";
  return cookie;
};

describe("safeReturnPath", () => {
  it("keeps a page of this site, with its query", () => {
    expect(safeReturnPath("/game/abc")).toBe("/game/abc");
    expect(safeReturnPath("/puzzle/game/EDP5pYum/38?utm_source=video")).toBe(
      "/puzzle/game/EDP5pYum/38?utm_source=video",
    );
    expect(safeReturnPath("/")).toBe("/");
  });

  it("refuses anything that could leave the site", () => {
    for (const raw of [
      "https://evil.example/",
      "//evil.example/x",
      "/\\evil.example",
      "\\\\evil.example",
      "/%0a//evil.example".replace("%0a", "\n"),
      "evil.example",
      "javascript:alert(1)",
      "",
      null,
      undefined,
      `/${"a".repeat(600)}`,
    ]) {
      expect(safeReturnPath(raw)).toBeNull();
    }
  });

  it("refuses the auth routes themselves (no second round trip)", () => {
    expect(safeReturnPath("/api/login")).toBeNull();
    expect(safeReturnPath("/api/register?return=/")).toBeNull();
    expect(safeReturnPath("/api")).toBeNull();
    // A page whose name only starts with "api" is a page.
    expect(safeReturnPath("/apiary")).toBe("/apiary");
  });
});

describe("/api/register and /api/login keep the return path", () => {
  for (const route of ["/api/register", "/api/login"]) {
    it(`${route}?return=<site page> keeps it for 30 minutes`, async () => {
      const response = await createApp().app.request(
        `${route}?return=${encodeURIComponent("/game/abc?x=1")}`,
      );
      expect(response.status).toBe(302);
      const cookie = returnCookie(response);
      expect(cookie).toContain(
        `${RETURN_COOKIE}=${encodeURIComponent("/game/abc?x=1")}`,
      );
      expect(cookie).toMatch(/Max-Age=1800/);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);
    });

    it(`${route} with no or a foreign return clears an old one`, async () => {
      for (const query of ["", "?return=%2F%2Fevil.example"]) {
        const response = await createApp().app.request(`${route}${query}`, {
          headers: { cookie: `${RETURN_COOKIE}=%2Fold` },
        });
        expect(response.status).toBe(302);
        expect(returnCookie(response)).toBe("cleared");
      }
    });
  }
});

describe("the sign-up mark (the guest-game link)", () => {
  const signupCookie = (response: Response) =>
    response.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${SIGNUP_GUEST_GAMES_COOKIE}=`));

  it("/api/register sets it, readable by the page, for 30 minutes", async () => {
    const response = await createApp().app.request("/api/register");
    const cookie = signupCookie(response);
    expect(cookie).toContain(`${SIGNUP_GUEST_GAMES_COOKIE}=1`);
    expect(cookie).toMatch(/Max-Age=1800/);
    expect(cookie).not.toMatch(/HttpOnly/);
  });

  it("/api/login clears it: a log-in links nothing", async () => {
    const response = await createApp().app.request("/api/login", {
      headers: { cookie: `${SIGNUP_GUEST_GAMES_COOKIE}=1` },
    });
    expect(signupCookie(response)).toMatch(/Max-Age=0/i);
  });
});

describe("the callback's destination", () => {
  const app = new Hono().get("/cb", (c) => c.redirect(takeReturnPath(c)));
  const callback = (cookie?: string) =>
    app.request("/cb", cookie ? { headers: { cookie } } : {});

  it("goes to the kept page, once", async () => {
    const response = await callback(
      `${RETURN_COOKIE}=${encodeURIComponent("/game/abc")}`,
    );
    expect(response.headers.get("location")).toBe("/game/abc");
    expect(returnCookie(response)).toBe("cleared");
  });

  it("goes home with no cookie, or with a cookie that leaves the site", async () => {
    expect((await callback()).headers.get("location")).toBe("/");
    const forged = await callback(
      `${RETURN_COOKIE}=${encodeURIComponent("//evil.example")}`,
    );
    expect(forged.headers.get("location")).toBe("/");
  });
});
