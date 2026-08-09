/**
 * www.wallgame.io is redirected to the apex before any route runs.
 *
 * www served the whole app, but the game socket's origin allowlist holds only
 * the apex and wallgame.fly.dev, so a visitor arriving there got a bot game
 * over HTTP and was then refused the socket - a board that never moves. One
 * canonical host beats a wider allowlist: there is no second origin to keep in
 * sync, and no second copy of every page for crawlers.
 */

import type { Hono, MiddlewareHandler } from "hono";

const CANONICAL_ORIGIN = "https://wallgame.io";
const REDIRECTED_HOST = "www.wallgame.io";

/**
 * The host comes from c.req.url, which Bun builds from the Host header, read
 * the way routes/auth.ts reads a request URL. Not X-Forwarded-Host: Fly does
 * not set it and a client can.
 *
 * `===` on the parsed hostname, never a substring test - includes/startsWith/
 * endsWith would each redirect www.wallgame.io.evil.example, an open redirect
 * wearing our own domain. Parsing also lowercases the host and drops any port.
 *
 * 301 on every method and path, including /api/* and the websocket upgrade
 * paths. Failing an upgrade on www is correct: no page is served from there to
 * open one.
 */
const canonicalHostRedirect: MiddlewareHandler = async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname === REDIRECTED_HOST) {
    return c.redirect(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`, 301);
  }

  await next();
};

export function registerCanonicalHostRedirect(app: Hono): void {
  app.use(canonicalHostRedirect);
}
