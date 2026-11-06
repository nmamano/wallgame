import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { DEFAULT_PAWN_STYLES } from "../../shared/domain/pawn-styles";
import {
  builtInLayerUrl,
  composeLayers,
  inlineLayer,
  isBuiltInSkin,
  newComposePage,
  scrubOffSiteSkins,
} from "./pawn-layers.mjs";

/** The message a promise rejects with, or null when it resolves. */
const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return (err as Error).message;
  }
  return null;
};

const PUBLIC = join(import.meta.dir, "../../frontend/public");
const ORIGIN = "https://wallgame.io";
const INJECTION = `x" onerror="document.title='pwn'" x="`;

/** Every file the site ships in a pawn folder, as "folder/type/name". */
const siteFiles = ["pawns", "pawn-backings", "pawn-foreground-fixes"].flatMap(
  (folder) =>
    readdirSync(join(PUBLIC, folder)).flatMap((type) =>
      statSync(join(PUBLIC, folder, type)).isDirectory()
        ? readdirSync(join(PUBLIC, folder, type)).map(
            (name) => `${folder}/${type}/${name}`,
          )
        : [],
    ),
);

const OFF_SITE = [
  "https://attacker.example/pawns/cat/x.svg",
  "http://attacker.example/pawns/cat/x.svg",
  "//attacker.example/pawns/cat/x.svg",
  "data:image/svg+xml;base64,PHN2Zy8+",
  "javascript:alert(1)",
  "../../api/x.svg",
  "/pawns/cat/../../api/x.svg",
  INJECTION,
];

describe("skins", () => {
  test("every skin the site ships is built in, by name and by path", () => {
    const pawns = siteFiles.filter((f) => f.startsWith("pawns/"));
    expect(pawns.length).toBeGreaterThan(400);
    const refused = pawns.flatMap((f) => {
      const name = f.split("/").at(-1)!;
      return [name, name.replace(/\.svg$/, ""), f, `/${f}`].filter(
        (v) => !isBuiltInSkin(v),
      );
    });
    expect(refused).toEqual([]);
    expect(
      ["default", ...Object.values(DEFAULT_PAWN_STYLES)].every(isBuiltInSkin),
    ).toBe(true);
  });

  test("an off-site or odd skin is not built in", () => {
    expect(OFF_SITE.filter(isBuiltInSkin)).toEqual([]);
  });

  test("the replay's off-site skins become the default; built-in ones stay", () => {
    const body = {
      matchStatus: {
        players: [
          {
            playerId: 1,
            appearance: {
              pawnColor: "red",
              catSkin: OFF_SITE[0],
              mouseSkin: "mouse20.svg",
            },
          },
          {
            playerId: 2,
            appearance: { catSkin: "default", homeSkin: INJECTION },
          },
        ],
      },
    };
    expect(scrubOffSiteSkins(body)).toEqual([
      "player 1 catSkin",
      "player 2 homeSkin",
    ]);
    expect(body.matchStatus.players[0].appearance).toEqual({
      pawnColor: "red",
      catSkin: "default",
      mouseSkin: "mouse20.svg",
    });
    expect(body.matchStatus.players[1].appearance.homeSkin).toBe("default");
  });
});

describe("layers", () => {
  test("every pawn file of the site is a layer the render may fetch", () => {
    expect(
      siteFiles.filter((f) => !builtInLayerUrl(`${ORIGIN}/${f}`, ORIGIN)),
    ).toEqual([]);
  });

  test("a layer of another host, folder or form is refused", () => {
    const refused = [
      "https://attacker.example/pawns/cat/x.svg",
      "http://wallgame.io/pawns/cat/cat3.svg",
      "https://wallgame.io.attacker.example/pawns/cat/cat3.svg",
      "https://user@wallgame.io/pawns/cat/cat3.svg",
      "https://wallgame.io/pawns/cat/cat3.svg?x=1",
      "https://wallgame.io/api/games/x",
      "https://wallgame.io/pawns/cat/cat3.js",
      "data:image/svg+xml;base64,PHN2Zy8+",
      "not a url",
    ];
    expect(refused.filter((s) => builtInLayerUrl(s, ORIGIN))).toEqual([]);
  });

  const reply =
    (type: string, size = 10) =>
    () =>
      Promise.resolve(
        new Response(new Uint8Array(size), {
          headers: { "content-type": type },
        }),
      );

  test("an off-site layer is refused before any fetch", async () => {
    let fetched = 0;
    const fetchImpl = () => {
      fetched += 1;
      return reply("image/svg+xml")();
    };
    expect(
      await errorOf(inlineLayer(OFF_SITE[0], ORIGIN, fetchImpl)),
    ).toStartWith("refused a pawn layer");
    expect(fetched).toBe(0);
  });

  test("only an SVG or PNG reply of a pawn's size is inlined", async () => {
    const src = `${ORIGIN}/pawns/cat/cat3.svg`;
    expect(
      await inlineLayer(src, ORIGIN, reply("image/svg+xml; charset=utf-8")),
    ).toStartWith("data:image/svg+xml;base64,");
    expect(await inlineLayer(src, ORIGIN, reply("image/png"))).toStartWith(
      "data:image/png;base64,",
    );
    for (const type of [INJECTION, "text/html", 'image/svg+xml" x="']) {
      expect(await errorOf(inlineLayer(src, ORIGIN, reply(type)))).toContain(
        "its type is not",
      );
    }
    expect(
      await errorOf(
        inlineLayer(src, ORIGIN, reply("image/png", 2 * 1024 * 1024)),
      ),
    ).toContain("bytes");
  });

  test("the fetch follows no redirect", async () => {
    let init: RequestInit | undefined;
    await inlineLayer(
      `${ORIGIN}/pawns/cat/cat3.svg`,
      ORIGIN,
      (_url: string, i: RequestInit) => {
        init = i;
        return reply("image/svg+xml")();
      },
    );
    expect(init?.redirect).toBe("error");
  });
});

/*
  The audit's own case (b2a19d62), in a real Chromium: a server whose
  Content-Type closes the src attribute and adds onerror. The site's
  storyboard runs this Chrome on auntie; a box without it skips.
*/
const CHROME = "/usr/bin/google-chrome";
describe.skipIf(!existsSync(CHROME))("composeLayers in Chromium", () => {
  const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';

  const withPage = async (
    headers: Record<string, string>,
    run: (
      page: import("playwright").Page,
      origin: string,
      out: string,
    ) => Promise<void>,
  ) => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(SVG, { headers }),
    });
    const browser = await chromium.launch({ executablePath: CHROME });
    const dir = mkdtempSync(join(tmpdir(), "pawn-layers-"));
    try {
      const page = await browser.newPage({
        viewport: { width: 30, height: 30 },
      });
      await page.setContent("<title>clean</title>");
      await run(page, `http://127.0.0.1:${server.port}`, join(dir, "out.png"));
      expect(await page.title()).not.toBe("pwn");
    } finally {
      await browser.close();
      void server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("a hostile Content-Type stops the render; no script runs", async () => {
    await withPage({ "content-type": INJECTION }, async (page, origin, out) => {
      expect(
        await errorOf(
          composeLayers(
            page,
            [{ src: `${origin}/pawns/cat/x.svg`, filter: "none" }],
            out,
            {
              origin,
              size: 30,
            },
          ),
        ),
      ).toContain("its type is not");
      expect(existsSync(out)).toBe(false);
    });
  }, 30000);

  test("a hostile filter is a style value, not markup", async () => {
    await withPage(
      { "content-type": "image/svg+xml" },
      async (page, origin, out) => {
        await composeLayers(
          page,
          [{ src: `${origin}/pawns/cat/x.svg`, filter: INJECTION }],
          out,
          { origin, size: 30 },
        );
        expect(existsSync(out)).toBe(true);
        expect(await page.locator("img").count()).toBe(1);
        expect(await page.locator("img[onerror]").count()).toBe(0);
      },
    );
  }, 30000);

  test("the compose page makes no request: a filter's url() is aborted", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        if (new URL(req.url).pathname !== "/pawns/cat/x.svg") hits += 1;
        return new Response(SVG, {
          headers: { "content-type": "image/svg+xml" },
        });
      },
    });
    const browser = await chromium.launch({ executablePath: CHROME });
    const dir = mkdtempSync(join(tmpdir(), "pawn-layers-"));
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const page = await newComposePage(browser, {
        viewport: { width: 30, height: 30 },
      });
      await composeLayers(
        page,
        [
          {
            src: `${origin}/pawns/cat/x.svg`,
            filter: `url(${origin}/leak.svg#f)`,
          },
        ],
        join(dir, "out.png"),
        { origin, size: 30 },
      );
      await page.waitForTimeout(300);
      expect(hits).toBe(0);
    } finally {
      await browser.close();
      void server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

/*
  Chromium's own sandbox stays on where the render opens a public page or
  composes a pawn (b2a19d62): Playwright passes --no-sandbox unless
  chromiumSandbox is true.
*/
test("the render's Chromium keeps its sandbox", () => {
  for (const file of ["render-game-video.mjs", "verify-shake-guard.mjs"]) {
    const src = readFileSync(join(import.meta.dir, file), "utf8");
    expect(src).not.toContain("--no-sandbox");
    expect(src).toContain("chromiumSandbox: true");
  }
});
