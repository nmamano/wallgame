/**
 * /api/logout clears the session, so only a deliberate logout from the site
 * may reach it: a POST from one of the site's own origins.
 *
 * No database: `app.request()` against the real `createApp()` is the whole
 * harness. DATABASE_URL is set to an inert URL that is never dialled (see
 * seo-endpoints.test.ts), and the Kinde settings are placeholders: logout only
 * builds the Kinde logout URL, it does not call Kinde.
 */

import { describe, it, expect, beforeAll } from "bun:test";

let createApp: typeof import("../server/app").createApp;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://inert:inert@127.0.0.1:5432/inert";
  process.env.KINDE_DOMAIN ??= "https://example.kinde.com";
  process.env.KINDE_CLIENT_ID ??= "test-client-id";
  process.env.KINDE_REDIRECT_URI ??= "http://localhost:5173/api/callback";
  ({ createApp } = await import("../server/app"));
});

// Outside production, the site's origin is the Vite dev server.
const SITE_ORIGIN = "http://localhost:5173";
const SESSION_COOKIES = "access_token=a; id_token=b; refresh_token=c; user=d";

function logoutRequest(method: string, origin?: string) {
  const headers: Record<string, string> = { cookie: SESSION_COOKIES };
  if (origin) headers.origin = origin;
  return createApp().app.request("/api/logout", { method, headers });
}

/** The cookie names the response clears (Max-Age=0). */
function clearedCookies(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .filter((cookie) => /max-age=0/i.test(cookie))
    .map((cookie) => cookie.split("=")[0])
    .sort();
}

describe("/api/logout", () => {
  it("does not log out on a GET", async () => {
    const response = await logoutRequest("GET");

    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("refuses a POST from another origin", async () => {
    const response = await logoutRequest("POST", "https://evil.example");

    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('refuses a POST with "Origin: null" (a sandboxed iframe or a data: page)', async () => {
    const response = await logoutRequest("POST", "null");

    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("logs out on a POST from the site and sends the browser to Kinde", async () => {
    const response = await logoutRequest("POST", SITE_ORIGIN);

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe(new URL(process.env.KINDE_DOMAIN!).origin);
    expect(location.pathname).toBe("/logout");
    expect(clearedCookies(response)).toEqual([
      "access_token",
      "id_token",
      "refresh_token",
      "user",
    ]);
  });
});
