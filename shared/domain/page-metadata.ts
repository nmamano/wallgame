/**
 * What each page is called, and what it says about itself.
 *
 * Both sides need this and they must not disagree. The server renders it into
 * the HTML shell so a crawler sees it in the first response; the client sets it
 * on the document when navigating in-app, because after the first load there is
 * no round-trip to render anything. Two copies would let a crawler and a
 * visitor see different titles for the same URL, and would drift the first time
 * someone edited one of them.
 *
 * Deliberately free of anything browser-hostile: no node imports, no origin, no
 * environment. The origin is a server-side deployment fact and stays in
 * server/routes/seo.ts.
 */

export interface PageMeta {
  title: string;
  description: string;
}

/**
 * The canonical pages, in sitemap order. This tuple is the single source of
 * truth for "which pages do we tell search engines about", so the sitemap and
 * the metadata table cannot drift apart - `PAGE_META` is typed against it, and
 * adding a path without copy is a compile error.
 *
 * Deliberately absent, each for its own reason:
 *
 * - `/game/$id`, `/puzzles/$id` and `/solo-campaign/$id` are per-item URLs. The
 *   first is unbounded. The other two are real content and deserve a sitemap
 *   generated from the database, which is separate work - a hardcoded list of
 *   them would be wrong the day after it was written.
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

const PAGE_META: Record<(typeof CANONICAL_PATHS)[number], PageMeta> = {
  "/": {
    title: "Wall Game - free online strategy board game",
    description:
      "Build walls to trap your opponent and hunt down their mouse. Play free in your browser against a friend, a stranger, or bots with different styles and strengths.",
  },
  "/play": {
    title: "Play Wall Game online - free, no account needed",
    description:
      "Start a game in seconds. Choose a bot to face, invite a friend with a link, or get matched with someone else looking for a game.",
  },
  "/puzzles": {
    title: "Wall Game puzzles and solo campaign",
    description:
      "Sharpen your play on hand-picked positions, and work through the campaign from your first wall to the hard endgames.",
  },
  "/learn": {
    title: "How to play Wall Game - rules and strategy",
    description:
      "Learn the rules in a couple of minutes, and then pick up the walling and chasing patterns that decide most games.",
  },
  "/ranking": {
    title: "Wall Game rankings - the top rated players",
    description:
      "See who is playing best right now, across board sizes, variants and time controls.",
  },
  "/live-games": {
    title: "Live Wall Game matches to watch",
    description:
      "Watch games as they are being played, follow a match move by move, and see how stronger players handle a position.",
  },
  "/past-games": {
    title: "Wall Game replays and game archive",
    description:
      "Browse finished games and replay them move by move, including your own.",
  },
  "/about": {
    title: "About Wall Game",
    description:
      "What Wall Game is, where it came from, and how to get in touch.",
  },
  "/study-board": {
    title: "Wall Game study board - set up any position",
    description:
      "Place pawns and walls by hand to build any position you like, and study what happens next.",
  },
};

/**
 * What a path we have no copy for gets: every game, puzzle and campaign level,
 * plus anything that does not resolve at all. Item-specific metadata for those
 * needs the database and is separate work.
 */
export const DEFAULT_PAGE_META: PageMeta = {
  title: "Wall Game - free online strategy board game",
  description:
    "Board game about building walls and outsmarting your opponents. Play with friends, face the AI, or solve puzzles.",
};

/**
 * A path as it appears in a canonical URL: no trailing slash, so `/play/` and
 * `/play` are one page rather than two competing for the same content. Query
 * and hash are the caller's to strip - the server never sees them on
 * `c.req.path`, and the client passes them separately.
 */
export function normalizePath(path: string): string {
  if (!path.startsWith("/")) return "/";
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * The title and description for a path. Anything not in the canonical list -
 * a game, a puzzle, an unknown URL - gets the generic copy, identically on both
 * sides.
 */
export function pageMetaForPath(path: string): PageMeta {
  return (
    (PAGE_META as Record<string, PageMeta | undefined>)[normalizePath(path)] ??
    DEFAULT_PAGE_META
  );
}
