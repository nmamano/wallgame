/**
 * Per-route metadata in the FIRST HTTP response.
 *
 * Every page used to serve the identical `<title>Wall Game</title>` and the
 * identical description, and the Open Graph and Twitter tags were all hardcoded
 * to the homepage - so a link to /puzzles previewed as the front page, pointing
 * at the front page. Search engines and link unfurlers read the bytes we send
 * before any JavaScript runs, so this happens on the server.
 *
 * Scope note: this is the first response only. After that the app navigates
 * client-side with no round-trip, so the browser tab keeps whatever title it
 * was given on load. Updating it during client-side navigation belongs with the
 * analytics work, which needs the same router subscription and should not add a
 * second one.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Hono } from "hono";
import { CANONICAL_PATHS, SITE_ORIGIN } from "./seo";

const SHELL_FILE = "./frontend/dist/index.html";

export interface PageMeta {
  title: string;
  description: string;
}

/**
 * Copy for every indexable page. Typed against the sitemap's path list rather
 * than repeating it, so adding a page to one and forgetting the other is a
 * compile error instead of a page that quietly inherits the generic title.
 */
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
const DEFAULT_META: PageMeta = {
  title: "Wall Game - free online strategy board game",
  description:
    "Board game about building walls and outsmarting your opponents. Play with friends, face the AI, or solve puzzles.",
};

/**
 * A path as it will appear in a canonical URL: no query, no hash - Hono's
 * `c.req.path` has already dropped both - and no trailing slash, so /play/ and
 * /play are one page rather than two competing for the same content.
 */
export function normalizePath(path: string): string {
  if (!path.startsWith("/")) return "/";
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function metaForPath(path: string): PageMeta & { url: string } {
  const normalized = normalizePath(path);
  const meta =
    (PAGE_META as Record<string, PageMeta | undefined>)[normalized] ??
    DEFAULT_META;

  return {
    ...meta,
    url: `${SITE_ORIGIN}${normalized === "/" ? "/" : normalized}`,
  };
}

/** Between tags, where only these three characters can end the text node. */
function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Inside a double-quoted attribute, which additionally must not be closed. */
function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

type SlotValue = "title" | "description" | "url";

interface Slot {
  /** Offsets of the value itself in the template, exclusive of its delimiters. */
  start: number;
  end: number;
  value: SlotValue;
  escape: (value: string) => string;
}

/**
 * The template split around the nine values we rewrite. Splitting once at
 * startup means a request is a join over constant strings rather than nine
 * regex passes over 4KB, and it makes the "exactly one of each marker" check
 * a parse-time guarantee rather than a per-request hope.
 */
export interface HtmlShell {
  pieces: string[];
  values: { value: SlotValue; escape: (value: string) => string }[];
}

/**
 * Finds the one tag matching `pattern` and returns where its `attribute` value
 * sits in the template.
 *
 * `pattern` must be bounded by `[^>]*` rather than `[\s\S]*?`: the built shell
 * is not minified, so tags span several lines, and a lazy any-character match
 * would happily run from one tag's opening into a later tag's attribute. `[^>]`
 * crosses newlines but cannot cross a tag boundary.
 *
 * Attribute order does not matter. The pattern allows anything but `>` on
 * either side of the identifying attribute, and the value is then located
 * inside the matched tag rather than by position, so
 * `<meta content="..." name="description">` parses exactly like the other way
 * round. There is a test for it.
 */
function locateAttributeValue(
  template: string,
  label: string,
  pattern: RegExp,
  attribute: string,
): { start: number; end: number } {
  const matches = [...template.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `HTML shell: expected exactly one ${label} in ${SHELL_FILE}, found ${matches.length}. ` +
        `Someone changed the template without updating server/routes/html-shell.ts.`,
    );
  }

  const [tag] = matches[0];
  const opening = new RegExp(`\\s${attribute}="`).exec(tag);
  if (!opening) {
    throw new Error(
      `HTML shell: the ${label} in ${SHELL_FILE} has no ${attribute} attribute.`,
    );
  }

  const start = matches[0].index + opening.index + opening[0].length;
  const end = template.indexOf('"', start);
  if (end === -1) {
    throw new Error(
      `HTML shell: the ${label} in ${SHELL_FILE} has an unterminated ${attribute} attribute.`,
    );
  }

  return { start, end };
}

function locateTitleText(template: string): { start: number; end: number } {
  const matches = [...template.matchAll(/<title>[^<]*<\/title>/g)];
  if (matches.length !== 1) {
    throw new Error(
      `HTML shell: expected exactly one <title> in ${SHELL_FILE}, found ${matches.length}.`,
    );
  }

  const start = matches[0].index + "<title>".length;
  return {
    start,
    end: start + matches[0][0].length - "<title></title>".length,
  };
}

function metaPattern(attribute: string, value: string): RegExp {
  return new RegExp(`<meta[^>]*\\s${attribute}="${value}"[^>]*>`, "g");
}

/**
 * The eight `<meta>` tags whose content is per-page, and which PageMeta value
 * each one carries. `<title>` and the canonical link are handled separately
 * because one substitutes element text and the other an href.
 */
const META_MARKERS: { label: string; pattern: RegExp; value: SlotValue }[] = [
  {
    label: "description",
    pattern: metaPattern("name", "description"),
    value: "description",
  },
  {
    label: "og:title",
    pattern: metaPattern("property", "og:title"),
    value: "title",
  },
  {
    label: "og:description",
    pattern: metaPattern("property", "og:description"),
    value: "description",
  },
  {
    label: "og:url",
    pattern: metaPattern("property", "og:url"),
    value: "url",
  },
  {
    label: "twitter:title",
    pattern: metaPattern("name", "twitter:title"),
    value: "title",
  },
  {
    label: "twitter:description",
    pattern: metaPattern("name", "twitter:description"),
    value: "description",
  },
  {
    label: "twitter:url",
    pattern: metaPattern("name", "twitter:url"),
    value: "url",
  },
];

export function parseHtmlShell(template: string): HtmlShell {
  const slots: Slot[] = [
    {
      ...locateTitleText(template),
      value: "title",
      escape: escapeHtmlText,
    },
    ...META_MARKERS.map(({ label, pattern, value }) => ({
      ...locateAttributeValue(template, `<meta ${label}>`, pattern, "content"),
      value,
      escape: escapeHtmlAttribute,
    })),
    {
      ...locateAttributeValue(
        template,
        "<link rel=canonical>",
        /<link[^>]*\srel="canonical"[^>]*>/g,
        "href",
      ),
      value: "url",
      escape: escapeHtmlAttribute,
    },
  ];

  // Annotated above and sorted here rather than chained: a contextual type does
  // not flow through .sort(), so `value` would widen from SlotValue to string.
  slots.sort((a, b) => a.start - b.start);

  const pieces: string[] = [];
  let cursor = 0;
  for (const slot of slots) {
    pieces.push(template.slice(cursor, slot.start));
    cursor = slot.end;
  }
  pieces.push(template.slice(cursor));

  return {
    pieces,
    values: slots.map(({ value, escape }) => ({ value, escape })),
  };
}

export function renderPageShell(shell: HtmlShell, path: string): string {
  const meta = metaForPath(path);

  let html = shell.pieces[0];
  shell.values.forEach(({ value, escape }, index) => {
    html += escape(meta[value]) + shell.pieces[index + 1];
  });

  return html;
}

/**
 * Reads and validates the built shell, or explains why there is nothing to
 * read.
 *
 * The two ways the file can be missing are not the same thing. In development
 * vite serves the frontend and this process never answers with HTML at all, so
 * there is nothing to load - FRONTEND_URL, which only the `dev` script sets, is
 * what says so. In production a missing dist is a broken build artifact, and
 * failing to start is much better than serving a site with no metadata and no
 * complaint.
 */
export function loadHtmlShell(): HtmlShell | undefined {
  if (process.env.FRONTEND_URL) return undefined;

  if (!existsSync(SHELL_FILE)) {
    throw new Error(
      `HTML shell: ${SHELL_FILE} does not exist. The frontend was not built, ` +
        `so there is nothing to serve. Run 'bun run build'.`,
    );
  }

  return parseHtmlShell(readFileSync(SHELL_FILE, "utf8"));
}

/**
 * Whether a path is a page a visitor navigates to, as opposed to a file the
 * page then asks for. Every app route is extensionless and every asset has an
 * extension, so the last path segment answers it.
 *
 * This exists because of a bug the unit tests structurally cannot catch. The
 * handler originally sat after the static-file handler, on the reasoning that
 * real files should win - but Hono's static handler resolves `/` to
 * `dist/index.html` as a directory index, so the homepage, the single most
 * important page on the site, was served untransformed. No test saw it: the
 * suite runs before the build, so in a test there is no dist for the static
 * handler to find and everything falls through correctly. It took serving the
 * real built site to see it.
 */
export function isNavigablePath(path: string): boolean {
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  return !lastSegment.includes(".");
}

export const registerHtmlShell = (app: Hono, shell: HtmlShell) => {
  app.get("*", async (c, next) => {
    if (!isNavigablePath(c.req.path)) return next();

    return c.body(renderPageShell(shell, c.req.path), 200, {
      "Content-Type": "text/html; charset=UTF-8",
    });
  });
};
