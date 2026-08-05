/**
 * The two documents crawlers ask for by name.
 *
 * Both used to return the SPA shell with a 200, because `createApp()` ends in
 * two `serveStatic` catch-alls on `*` and anything unmatched falls through to
 * index.html. That is worse than a 404: a crawler asking for robots.txt got a
 * cheerful success containing HTML, and silently ignored it.
 *
 * They are routes rather than files in frontend/public/ for two reasons. The
 * sitemap's URL list belongs next to a comment explaining what is deliberately
 * missing from it, which a static asset cannot carry; and the test suite runs
 * before the frontend build, so a route is reachable from `app.request()` while
 * a built asset is not.
 */

import { Hono } from "hono";

/**
 * Sitemap entries have to be absolute, so the origin is written down once here.
 * Not derived from the request Host: that would make the document depend on who
 * asked for it, and a spoofed Host would produce a sitemap for someone else's
 * domain.
 */
export const SITE_ORIGIN = "https://wallgame.io";

/**
 * The canonical pages, and the only URLs the sitemap advertises.
 *
 * Deliberately absent, each for its own reason:
 *
 * - `/game/$id`, `/puzzles/$id` and `/solo-campaign/$id` are per-item URLs. The
 *   first is unbounded. The other two are real content and deserve a sitemap
 *   generated from the database, which is a separate piece of work - a
 *   hardcoded list of them would be wrong the day after it was written.
 * - `/solo-campaign` and `/generated-candidates` are legacy URLs whose routes
 *   redirect to `/puzzles` client-side. Sending a crawler there buys an empty
 *   shell and a JavaScript hop to a page already listed below.
 * - `/profile` and `/settings` are per-visitor and worthless in an index. They
 *   stay crawlable on purpose - see `buildRobotsTxt`.
 */
export const CANONICAL_PATHS = [
  "/",
  "/play",
  "/puzzles",
  "/learn",
  "/ranking",
  "/live-games",
  "/past-games",
  "/about",
  "/study-board",
] as const;

/**
 * Every URL under `/game/` is one specific game, live or finished. There are
 * unboundedly many, nobody searches for one, and a crawler spending its budget
 * there is a crawler not reading the pages above.
 *
 * It is the only entry, and the per-visitor and legacy-redirect pages are
 * pointedly not here. `Disallow` is not `noindex` - it stops a crawler reading
 * a page without stopping it indexing the URL, so disallowing a redirect would
 * freeze it in the index with no way for anyone to discover where it points.
 */
const DISALLOWED_PREFIXES = ["/game/"] as const;

/**
 * Escapes the five XML metacharacters. Every value passed through today is a
 * constant from the list above, so this changes nothing now - it is here for
 * the moment the list starts coming from the database, where a puzzle slug
 * containing an ampersand would otherwise produce a malformed document.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildRobotsTxt(): string {
  return [
    "User-agent: *",
    "Allow: /",
    ...DISALLOWED_PREFIXES.map((prefix) => `Disallow: ${prefix}`),
    "",
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");
}

export function buildSitemapXml(): string {
  const entries = CANONICAL_PATHS.map(
    (path) => `  <url><loc>${escapeXml(`${SITE_ORIGIN}${path}`)}</loc></url>`,
  );

  // No lastmod, changefreq or priority. Google ignores the last two, and a
  // lastmod we cannot derive from anything real would just be a date that lies.
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    "</urlset>",
    "",
  ].join("\n");
}

/**
 * Both content types are set explicitly. `c.text()` looks like it would do it,
 * but on this Hono version it returns the body with no Content-Type header at
 * all - measured, not assumed - which leaves a crawler sniffing. Being explicit
 * also means neither response depends on a framework default that could change
 * under us.
 */
export const registerSeoRoutes = (app: Hono) => {
  app.get("/robots.txt", (c) =>
    c.body(buildRobotsTxt(), 200, {
      "Content-Type": "text/plain; charset=UTF-8",
    }),
  );

  app.get("/sitemap.xml", (c) =>
    c.body(buildSitemapXml(), 200, {
      "Content-Type": "application/xml; charset=UTF-8",
    }),
  );
};
