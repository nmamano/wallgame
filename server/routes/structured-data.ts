/**
 * schema.org structured data (JSON-LD) in the first HTTP response.
 *
 * Scope (board 456de365, Wall Game PM 2026-11-26): two pages carry it.
 *
 * - `/` gets a WebSite and a VideoGame, a fixed block with no database read.
 *   Its description is the home page's meta description, so the two cannot
 *   disagree; that copy belongs to Growth (shared/domain/page-metadata.ts).
 * - `/puzzles/$id` gets a BreadcrumbList - Wall Game > Puzzles > Puzzle 7.
 *
 * Every other page gets nothing, so its bytes stay exactly as they were.
 *
 * Deliberately not here:
 *
 * - A SearchAction on the WebSite. It promises a search URL, and the site has
 *   none.
 * - A type for the puzzle itself. schema.org has no Puzzle type, and calling a
 *   puzzle position a `Game` would claim something it is not.
 * - Ratings or reviews, on any page. The like counts are not reviews, and
 *   marking them up as such is the kind of markup search engines penalise.
 * - `/puzzles` (the listing) and `/puzzle/game/...`: a one-step breadcrumb says
 *   nothing, and a replay of one game is not a page we want described.
 */

import {
  normalizePath,
  pageMetaForPath,
} from "../../shared/domain/page-metadata";
import {
  puzzlePath,
  resolveSavedPuzzle,
  savedPuzzleSlug,
  type SavedPuzzleRef,
} from "../../shared/domain/puzzle-links";
import { fetchEnabledSavedPuzzles, SITE_ORIGIN } from "./seo";

/** The names match the visible navigation (frontend/src/components/navigation.tsx). */
const HOME_CRUMB = { name: "Wall Game", path: "/" };
const PUZZLES_CRUMB = { name: "Puzzles", path: "/puzzles" };

/**
 * What the home page says about the site and the game. Every field is a fact a
 * visitor can check on the site: it is free (no paid feature exists,
 * 2026-11-26), it runs in a browser, and it is played alone (bots, puzzles) or
 * against other people.
 */
export function homeStructuredData() {
  const url = `${SITE_ORIGIN}/`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${url}#website`,
        name: HOME_CRUMB.name,
        url,
      },
      {
        "@type": "VideoGame",
        "@id": `${url}#game`,
        name: HOME_CRUMB.name,
        url,
        description: pageMetaForPath("/").description,
        genre: "Strategy",
        gamePlatform: "Web browser",
        applicationCategory: "GameApplication",
        operatingSystem: "Any",
        playMode: ["SinglePlayer", "MultiPlayer"],
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      },
    ],
  };
}

/** The `$id` segment of a per-puzzle page, or null for any other path. */
function puzzlePageParam(path: string): string | null {
  const match = /^\/puzzles\/([^/]+)$/.exec(normalizePath(path));
  return match ? match[1] : null;
}

export function puzzleBreadcrumbList(puzzle: SavedPuzzleRef) {
  const crumbs = [
    HOME_CRUMB,
    PUZZLES_CRUMB,
    // The canonical slug, not the segment the visitor typed: a link by row id
    // and a link by number are the same page, and the breadcrumb names the
    // address the app itself hands out.
    {
      name: puzzle.displayName,
      path: puzzlePath("saved", savedPuzzleSlug(puzzle)),
    },
  ];

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: `${SITE_ORIGIN}${crumb.path}`,
    })),
  };
}

/**
 * JSON for the inside of a `<script type="application/ld+json">`.
 *
 * The browser ends the element at the first `</script` whatever the JSON
 * means, so a display name containing one would close it early and the rest
 * would be parsed as HTML. Escaping every `<` as `\u003c` keeps the JSON
 * identical in meaning and leaves no `<` for the HTML parser to see; it also
 * covers `<!--`, which changes how the script element is tokenised.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * How long a puzzle page waits for its structured data. A CHOSEN value: long
 * enough for the query on a healthy database (36 rows, 2026-11-26), short
 * enough that a stalled pool delays the page by at most this much.
 */
const PUZZLE_LOOKUP_TIMEOUT_MS = 1000;

/**
 * The JSON-LD for a page, or undefined when the page carries none.
 *
 * Fails OPEN, unlike the sitemap: the page is the product and the markup is a
 * hint to search engines. A database error costs the hint, and a stalled
 * database costs the hint after `timeoutMs`; neither costs the page. Only a
 * per-puzzle path ever calls `loadPuzzles`, so no other page waits on the
 * database; the home page's block is fixed.
 *
 * @param loadPuzzles the enabled puzzles. A parameter so a test can make it
 * throw or hang; production uses the sitemap's query.
 */
export async function structuredDataForPath(
  path: string,
  loadPuzzles: () => Promise<SavedPuzzleRef[]> = fetchEnabledSavedPuzzles,
  timeoutMs: number = PUZZLE_LOOKUP_TIMEOUT_MS,
): Promise<string | undefined> {
  if (normalizePath(path) === "/") {
    return serializeJsonLd(homeStructuredData());
  }

  const param = puzzlePageParam(path);
  if (param === null) return undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let puzzles: SavedPuzzleRef[];
  try {
    puzzles = await Promise.race([
      loadPuzzles(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer in ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    console.error("[seo] puzzle structured data skipped: query failed", {
      path,
      error,
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }

  const puzzle = resolveSavedPuzzle(puzzles, param);
  return puzzle ? serializeJsonLd(puzzleBreadcrumbList(puzzle)) : undefined;
}
