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
import { CANONICAL_PATHS } from "../../shared/domain/page-metadata";
import { puzzlePath, savedPuzzleSlug } from "../../shared/domain/puzzle-links";

/**
 * Sitemap entries have to be absolute, so the origin is written down once here.
 * Not derived from the request Host: that would make the document depend on who
 * asked for it, and a spoofed Host would produce a sitemap for someone else's
 * domain.
 */
export const SITE_ORIGIN = "https://wallgame.io";

/**
 * How long to ask a crawler to wait after a failed sitemap.
 *
 * A CHOSEN value, not a convention: nothing else in this repo sends
 * Retry-After, so this number is one hour because an hour is a reasonable gap
 * between crawls, and for no deeper reason. Do not read it as a policy that
 * exists elsewhere.
 */
const SITEMAP_RETRY_AFTER_SECONDS = 3600;

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

/**
 * The path of every puzzle a stranger can open, newest numbering and all.
 *
 * `enabled` is the same filter the public listing uses, so a retired puzzle
 * leaves the sitemap for the same reason it leaves the page. The slug is built
 * by `savedPuzzleSlug` rather than from the row id, because that is what the
 * links in the app say, and a sitemap advertising a second address for the
 * same page is the duplicate-content problem it exists to avoid.
 *
 * Worth knowing rather than fixing here: a puzzle link carries its NUMBER, and
 * retiring a puzzle renumbers the survivors, so an indexed URL can later point
 * at a different puzzle. Nil was shown that trade and chose it (2026-08-02);
 * generating this list from the database at request time is what keeps the
 * sitemap honest about the numbering as it stands today.
 */
export async function fetchPuzzleSitemapPaths(): Promise<string[]> {
  // Imported HERE rather than at the top of the file, because server/db opens
  // a Postgres pool at import time and demands DATABASE_URL. A top-level
  // import put that demand on every module that builds the app: four test
  // files that had never needed a database started failing with
  // "DATABASE_URL is required" simply because they construct createApp().
  // Reaching for it inside the one function that queries keeps that cost on
  // the request that asked for it.
  const { db } = await import("../db");
  const { savedPuzzlesTable } = await import("../db/schema/saved-puzzles");
  const { asc, eq } = await import("drizzle-orm");

  const rows = await db
    .select({
      id: savedPuzzlesTable.id,
      displayName: savedPuzzlesTable.displayName,
    })
    .from(savedPuzzlesTable)
    .where(eq(savedPuzzlesTable.enabled, true))
    .orderBy(asc(savedPuzzlesTable.sortIndex));

  return rows.map((row) => puzzlePath("saved", savedPuzzleSlug(row)));
}

/**
 * @param puzzlePaths in-app paths to append after the canonical pages. Passed
 * in rather than read here so this stays a pure function of its input, which
 * is what lets the document be asserted without a database.
 */
export function buildSitemapXml(puzzlePaths: readonly string[] = []): string {
  const entries = [...CANONICAL_PATHS, ...puzzlePaths].map(
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

  /**
   * A sitemap the puzzle query could not fill is not served as a success.
   *
   * The tempting alternative - 200 with the canonical pages and no puzzles -
   * was tried and rejected in review (2026-08-16). A 200 asserts "this is the
   * current set"; during a database fault only "ask again" is true, and a
   * document whose URL count silently drops and returns is the thing that
   * flaps. Withholding does not. The canonical pages stay discoverable through
   * internal links and through the last successful fetch either way, and the
   * showcase route already answers a database throw with a 5xx rather than a
   * fabricated partial success, so this is consistent rather than novel.
   */
  app.get("/sitemap.xml", async (c) => {
    let puzzlePaths: string[];
    try {
      puzzlePaths = await fetchPuzzleSitemapPaths();
    } catch (error) {
      console.error("[seo] sitemap unavailable: puzzle query failed", {
        error,
      });
      return c.body("Sitemap temporarily unavailable.\n", 503, {
        "Content-Type": "text/plain; charset=UTF-8",
        "Retry-After": String(SITEMAP_RETRY_AFTER_SECONDS),
      });
    }
    return c.body(buildSitemapXml(puzzlePaths), 200, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  });
};
