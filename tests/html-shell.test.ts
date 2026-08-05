/**
 * Per-route metadata in the first HTTP response.
 *
 * Like tests/seo-endpoints.test.ts this needs no database and no port. It also
 * needs no built frontend: the shell is parsed from fixture strings here, which
 * is the whole reason `createApp` takes a pre-parsed shell rather than reading
 * a file itself.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import {
  parseHtmlShell,
  renderPageShell,
  metaForPath,
  isNavigablePath,
} from "../server/routes/html-shell";
// Path normalisation moved to shared/ when the client began needing the same
// titles; the server composes it with the origin rather than owning it.
import { normalizePath } from "../shared/domain/page-metadata";

let createApp: typeof import("../server/index").createApp;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://inert:inert@127.0.0.1:5432/inert";
  ({ createApp } = await import("../server/index"));
});

/**
 * Shaped like the real frontend/index.html, including the multi-line tags -
 * vite does not minify, so the built shell keeps prettier's line breaks and a
 * parser that assumed one line per tag would match nothing in production while
 * passing against a tidier fixture.
 */
const FIXTURE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="description"
      content="Original description."
    />
    <link rel="canonical" href="https://wallgame.io/" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://wallgame.io/" />
    <meta property="og:title" content="Original social title" />
    <meta
      property="og:description"
      content="Original description."
    />
    <meta name="twitter:url" content="https://wallgame.io/" />
    <meta name="twitter:title" content="Original social title" />
    <meta
      name="twitter:description"
      content="Original description."
    />
    <title>Original title</title>
  </head>
  <body></body>
</html>
`;

/** Every value the shell rewrites, read back out of a rendered document. */
function readMetadata(html: string) {
  const attribute = (pattern: RegExp) => pattern.exec(html)?.[1];

  return {
    title: /<title>([^<]*)<\/title>/.exec(html)?.[1],
    description: attribute(
      /<meta[^>]*\sname="description"[^>]*content="([^"]*)"/,
    ),
    canonical: attribute(/<link[^>]*\srel="canonical"[^>]*href="([^"]*)"/),
    ogTitle: attribute(/<meta[^>]*\sproperty="og:title"[^>]*content="([^"]*)"/),
    ogDescription: attribute(
      /<meta[^>]*\sproperty="og:description"[^>]*content="([^"]*)"/,
    ),
    ogUrl: attribute(/<meta[^>]*\sproperty="og:url"[^>]*content="([^"]*)"/),
    twitterTitle: attribute(
      /<meta[^>]*\sname="twitter:title"[^>]*content="([^"]*)"/,
    ),
    twitterDescription: attribute(
      /<meta[^>]*\sname="twitter:description"[^>]*content="([^"]*)"/,
    ),
    twitterUrl: attribute(
      /<meta[^>]*\sname="twitter:url"[^>]*content="([^"]*)"/,
    ),
  };
}

describe("normalizePath", () => {
  it("treats a trailing slash as the same page", () => {
    expect(normalizePath("/play/")).toBe("/play");
    expect(normalizePath("/play")).toBe("/play");
    expect(normalizePath("/play///")).toBe("/play");
  });

  it("keeps the root as a single slash", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
  });
});

describe("isNavigablePath", () => {
  it("claims the homepage", () => {
    // The regression that motivated this function: the static handler resolves
    // "/" to dist/index.html as a directory index, so if the shell handler does
    // not take "/" first, the most important page keeps the generic title. The
    // suite runs before the build, so no dist-free test can observe that - this
    // assertion is the only place it is pinned down.
    expect(isNavigablePath("/")).toBe(true);
  });

  it("claims app routes and leaves assets to the static handler", () => {
    for (const path of [
      "/play",
      "/puzzles",
      "/game/abc123",
      "/solo-campaign",
    ]) {
      expect(isNavigablePath(path)).toBe(true);
    }

    for (const path of [
      "/assets/index-a1b2c3.js",
      "/assets/index-a1b2c3.css",
      "/favicon/favicon.ico",
      "/favicon/site.webmanifest",
      "/og-image.png",
    ]) {
      expect(isNavigablePath(path)).toBe(false);
    }
  });
});

describe("metaForPath", () => {
  it("gives every indexable page its own title and description", () => {
    const paths = [
      "/",
      "/play",
      "/puzzles",
      "/learn",
      "/ranking",
      "/live-games",
      "/past-games",
      "/about",
      "/study-board",
    ];

    const titles = paths.map((path) => metaForPath(path).title);
    const descriptions = paths.map((path) => metaForPath(path).description);

    // The bug being fixed was nine identical titles, so uniqueness is the
    // assertion that matters, not any particular wording.
    expect(new Set(titles).size).toBe(paths.length);
    expect(new Set(descriptions).size).toBe(paths.length);
  });

  it("builds absolute, query-free URLs from the site origin", () => {
    expect(metaForPath("/").url).toBe("https://wallgame.io/");
    expect(metaForPath("/puzzles").url).toBe("https://wallgame.io/puzzles");
    expect(metaForPath("/puzzles/").url).toBe("https://wallgame.io/puzzles");
  });

  it("falls back to generic copy for the dynamic path families", () => {
    const fallback = metaForPath("/definitely-not-a-route");

    for (const path of [
      "/game/abc123",
      "/puzzles/S-42",
      "/solo-campaign/7",
      "/profile",
    ]) {
      expect(metaForPath(path).title).toBe(fallback.title);
      expect(metaForPath(path).description).toBe(fallback.description);
    }
  });

  it("still points a dynamic page's canonical URL at itself", () => {
    expect(metaForPath("/game/abc123").url).toBe(
      "https://wallgame.io/game/abc123",
    );
  });
});

/**
 * Every marker the parser requires, one entry per substituted value. Deleting
 * each in turn is what catches a typo in an individual selector: a pattern that
 * matches nothing looks identical to a healthy one until the tag it is supposed
 * to find goes missing and nobody complains.
 */
const ALL_MARKERS: { label: string; pattern: RegExp }[] = [
  { label: "title", pattern: /<title>[^<]*<\/title>/ },
  { label: "description", pattern: /<meta[^>]*\sname="description"[^>]*>/ },
  { label: "canonical", pattern: /<link[^>]*\srel="canonical"[^>]*>/ },
  { label: "og:title", pattern: /<meta[^>]*\sproperty="og:title"[^>]*>/ },
  {
    label: "og:description",
    pattern: /<meta[^>]*\sproperty="og:description"[^>]*>/,
  },
  { label: "og:url", pattern: /<meta[^>]*\sproperty="og:url"[^>]*>/ },
  {
    label: "twitter:title",
    pattern: /<meta[^>]*\sname="twitter:title"[^>]*>/,
  },
  {
    label: "twitter:description",
    pattern: /<meta[^>]*\sname="twitter:description"[^>]*>/,
  },
  { label: "twitter:url", pattern: /<meta[^>]*\sname="twitter:url"[^>]*>/ },
];

describe("parseHtmlShell", () => {
  for (const { label, pattern } of ALL_MARKERS) {
    it(`refuses a template with no ${label}`, () => {
      const without = FIXTURE.replace(pattern, "");

      // Guards the guard: if the pattern matched nothing the template would be
      // unchanged, parsing would succeed, and this test would pass for the
      // wrong reason.
      expect(without).not.toBe(FIXTURE);
      expect(() => parseHtmlShell(without)).toThrow(/expected exactly one/);
    });
  }

  it("does not care what order a tag's attributes are in", () => {
    // The identifying attribute after the value one, everywhere. The real
    // template does not look like this, but nothing should depend on that.
    const reordered = `<html><head>
<meta content="Original description." name="description" />
<link href="https://wallgame.io/" rel="canonical" />
<meta content="Original social title" property="og:title" />
<meta content="Original description." property="og:description" />
<meta content="https://wallgame.io/" property="og:url" />
<meta content="Original social title" name="twitter:title" />
<meta content="Original description." name="twitter:description" />
<meta content="https://wallgame.io/" name="twitter:url" />
<title>Original title</title></head></html>`;

    const html = renderPageShell(parseHtmlShell(reordered), "/puzzles");

    // Asserted against the raw bytes rather than through readMetadata, whose
    // own patterns expect the identifying attribute first - which is the point.
    expect(html).toContain(`<title>${metaForPath("/puzzles").title}</title>`);
    expect(html).toContain(
      'href="https://wallgame.io/puzzles" rel="canonical"',
    );
    expect(html).toContain(
      'content="https://wallgame.io/puzzles" name="twitter:url"',
    );
  });

  it("rejects a template with a duplicated marker", () => {
    const duplicated = FIXTURE.replace(
      '<link rel="canonical" href="https://wallgame.io/" />',
      '<link rel="canonical" href="https://wallgame.io/" />\n    <link rel="canonical" href="https://wallgame.io/x" />',
    );

    expect(() => parseHtmlShell(duplicated)).toThrow(/expected exactly one/);
  });

  it("names the marker it could not find", () => {
    const withoutCanonical = FIXTURE.replace(
      '<link rel="canonical" href="https://wallgame.io/" />',
      "",
    );

    expect(() => parseHtmlShell(withoutCanonical)).toThrow(/canonical/);
  });
});

describe("renderPageShell", () => {
  it("rewrites all nine values for a known page", () => {
    const shell = parseHtmlShell(FIXTURE);

    const metadata = readMetadata(renderPageShell(shell, "/puzzles"));
    const expected = metaForPath("/puzzles");

    expect(metadata.title).toBe(expected.title);
    expect(metadata.description).toBe(expected.description);
    expect(metadata.canonical).toBe("https://wallgame.io/puzzles");
    expect(metadata.ogTitle).toBe(expected.title);
    expect(metadata.ogDescription).toBe(expected.description);
    expect(metadata.ogUrl).toBe("https://wallgame.io/puzzles");
    expect(metadata.twitterTitle).toBe(expected.title);
    expect(metadata.twitterDescription).toBe(expected.description);
    expect(metadata.twitterUrl).toBe("https://wallgame.io/puzzles");
  });

  it("leaves the rest of the document alone", () => {
    const shell = parseHtmlShell(FIXTURE);

    const html = renderPageShell(shell, "/play");

    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain('<meta property="og:type" content="website" />');
    expect(html).toContain('<meta charset="UTF-8" />');
    expect(html.length).toBeGreaterThan(200);
  });

  it("escapes a title as text and an attribute as an attribute", () => {
    // A crafted template proves the escaping without waiting for copy to
    // contain an apostrophe: the marker values are irrelevant, only the slots.
    const shell = parseHtmlShell(FIXTURE);
    const hostile = {
      title: `Tom & Jerry's <b>"chase"</b>`,
      description: `Walls & traps: "don't" <script>`,
    };

    // Render through the real slot machinery by substituting the meta lookup.
    const html = shell.pieces.reduce((accumulated, piece, index) => {
      if (index === 0) return piece;
      const slot = shell.values[index - 1];
      const value =
        slot.value === "title"
          ? hostile.title
          : slot.value === "description"
            ? hostile.description
            : "https://wallgame.io/?a=1&b=2";
      return accumulated + slot.escape(value) + piece;
    }, "");

    // Inside the title element: the three text-node characters, and nothing
    // more - a quote there is legal and escaping it would be noise.
    expect(html).toContain(
      '<title>Tom &amp; Jerry\'s &lt;b&gt;"chase"&lt;/b&gt;</title>',
    );
    // Inside attributes: quotes and apostrophes too, or the attribute ends early.
    expect(html).toContain(
      'content="Walls &amp; traps: &quot;don&#39;t&quot; &lt;script&gt;"',
    );
    expect(html).toContain('href="https://wallgame.io/?a=1&amp;b=2"');
    // The smoking gun for a broken escape: a stray unescaped quote or bracket
    // would have produced a second, unintended tag.
    expect(html).not.toContain("<script>");
  });
});

describe("the served document", () => {
  it("gives each route its own title in the first response", async () => {
    const { app } = createApp({ htmlShell: parseHtmlShell(FIXTURE) });

    const titles = await Promise.all(
      ["/", "/play", "/puzzles", "/ranking", "/learn", "/about"].map(
        async (path) =>
          readMetadata(await (await app.request(path)).text()).title,
      ),
    );

    // Precisely the production symptom: six routes, one title.
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("serves it as HTML", async () => {
    const { app } = createApp({ htmlShell: parseHtmlShell(FIXTURE) });

    const response = await app.request("/puzzles");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html\b/);
  });

  it("carries the canonical and social URLs for the page asked for", async () => {
    const { app } = createApp({ htmlShell: parseHtmlShell(FIXTURE) });

    const metadata = readMetadata(
      await (await app.request("/live-games")).text(),
    );

    expect(metadata.canonical).toBe("https://wallgame.io/live-games");
    expect(metadata.ogUrl).toBe("https://wallgame.io/live-games");
    expect(metadata.twitterUrl).toBe("https://wallgame.io/live-games");
  });

  it("serves the generic copy on a dynamic path", async () => {
    const { app } = createApp({ htmlShell: parseHtmlShell(FIXTURE) });

    const metadata = readMetadata(
      await (await app.request("/game/abc123")).text(),
    );

    expect(metadata.title).toBe(metaForPath("/game/abc123").title);
    expect(metadata.canonical).toBe("https://wallgame.io/game/abc123");
  });

  it("does not intercept the crawler endpoints", async () => {
    const { app } = createApp({ htmlShell: parseHtmlShell(FIXTURE) });

    const robots = await app.request("/robots.txt");

    expect(robots.headers.get("content-type")).toMatch(/^text\/plain\b/);
  });
});
