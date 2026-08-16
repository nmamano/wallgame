/**
 * What SHAPE does the Crisp theme draw where a wall meets a wall run?
 *
 * Board task c003ec83. Nil, 2026-08-03: a red wall meeting a blue horizontal
 * run draws a chevron - a V of red poking down into the blue - instead of
 * anything that reads as a tee.
 *
 * This is an INSTRUMENT for the artwork question only. It does not touch
 * geometry, the rasterizer, or wall/joint unification, all three of which are
 * answered on that board and must stay answered. For "which layer is a mismatch
 * in", use joint-layers.mjs instead; that is a different question.
 *
 * Two kinds of evidence, because neither is enough alone:
 *
 *  - SCREENSHOTS, so a human can judge whether it reads as a tee. That is the
 *    actual acceptance criterion and no number replaces it.
 *  - The stem wall's POLYGON POINTS, read from the DOM. The chevron is not a
 *    paint artifact - it is a polygon the artwork asks for - so its vertices
 *    are the exact thing that changed, quotable to four decimals and immune to
 *    "the screenshots look similar to me".
 *
 * Serves the BUILT bundle through the harness stub server, so nothing depends
 * on a dev server surviving between commands.
 *
 * Run it (build first - `bun run build`, which needs the shared build lock):
 *   node scripts/browser-harness/crisp-junction-shots.mjs
 * Env: SHOT_TAG (default "shot") names the output files, PROBE_THEME
 * (default "crisp") picks the theme.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startStaticDistServer } from "./static-dist-server.mjs";

const DIST = join(import.meta.dirname, "../../frontend/dist");
const PORT = 5182;
const TAG = process.env.SHOT_TAG ?? "shot";
const THEME = process.env.PROBE_THEME ?? "crisp";
const OUT = "tmp/crisp-junction";

/** Desktop, then the SHORT mobile height - 393x852 hides several board defects. */
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 393, height: 650 },
];
const DPRS = [1, 2];

const server = await startStaticDistServer(DIST, {
  port: PORT,
  routes: { "/api/me": () => ({ user: null }) },
});
const BASE = server.url;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  args: ["--no-sandbox"],
});

try {
  for (const viewport of VIEWPORTS) {
    for (const dpr of DPRS) {
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: dpr,
      });

      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.evaluate((t) => {
        localStorage.setItem("wall-game-board-theme", JSON.stringify(t));
        localStorage.setItem("wall-game-theme", "dark");
      }, THEME);
      await page.goto(`${BASE}/study-board`, { waitUntil: "networkidle" });
      await page.waitForSelector(".grid.w-full.relative");
      await page.waitForTimeout(800);

      const pick = async (label, option) => {
        await page
          .locator(`label[for="${label}"]`)
          .locator("..")
          .getByRole("combobox")
          .first()
          .click();
        await page
          .getByRole("option", { name: option, exact: true })
          .first()
          .click();
        await page.waitForTimeout(150);
      };

      // Every clickable wall slot, with the orientation the board gave it.
      const slots = await page.evaluate(() => {
        const grid = document.querySelector(".grid.w-full.relative");
        return [...grid.children].flatMap((el, index) => {
          if (getComputedStyle(el).zIndex !== "15") return [];
          const r = el.getBoundingClientRect();
          return [
            {
              index,
              left: r.left,
              top: r.top,
              right: r.right,
              bottom: r.bottom,
              cx: (r.left + r.right) / 2,
              cy: (r.top + r.bottom) / 2,
              vertical: r.height > r.width,
            },
          ];
        });
      });

      const horizontal = slots
        .filter((s) => !s.vertical)
        .sort((a, z) => a.cy - z.cy || a.cx - z.cx);
      const vertical = slots.filter((s) => s.vertical);

      // A horizontal pair sharing one pillar, somewhere near the middle of the
      // board so the crop has room around it.
      const first = horizontal[Math.floor(horizontal.length / 2)];
      const second = horizontal
        .filter((s) => Math.abs(s.cy - first.cy) < 2 && s.cx > first.cx)
        .sort((a, z) => a.cx - z.cx)[0];
      if (!second) throw new Error("no horizontal neighbour to pair with");

      // The pillar between them, and the vertical slot that comes down into it.
      const pillar = { cx: (first.right + second.left) / 2, cy: first.cy };
      const stem = vertical
        .filter((s) => s.bottom <= pillar.cy + 2)
        .sort(
          (a, z) =>
            Math.abs(a.cx - pillar.cx) - Math.abs(z.cx - pillar.cx) ||
            Math.abs(a.bottom - pillar.cy) - Math.abs(z.bottom - pillar.cy),
        )[0];
      if (!stem) throw new Error("no vertical slot above the junction");

      const click = (index) =>
        page.evaluate(
          (k) =>
            document.querySelector(".grid.w-full.relative").children[k].click(),
          index,
        );

      await pick("wall-color", "Blue");
      await click(first.index);
      await click(second.index);
      await pick("wall-color", "Red");
      await click(stem.index);
      await page.waitForTimeout(400);

      // Re-read the junction's position from the same two slots. The combobox
      // interactions above are Playwright locator clicks, which scroll the
      // element into view, so every coordinate captured before them is stale -
      // on a 393x650 viewport that scroll is what put the junction somewhere
      // other than where the pre-placement rects said it was.
      const placed = await page.evaluate(
        ([a, b]) => {
          const kids = document.querySelector(".grid.w-full.relative").children;
          const ra = kids[a].getBoundingClientRect();
          const rb = kids[b].getBoundingClientRect();
          return { cx: (ra.right + rb.left) / 2, cy: (ra.top + ra.bottom) / 2 };
        },
        [first.index, second.index],
      );
      pillar.cx = placed.cx;
      pillar.cy = placed.cy;

      // What the artwork actually asks to be drawn at that pillar. A pillar
      // with more than one colour renders one <polygon> per wall territory;
      // the chevron IS the stem's polygon, so its absence is the fix.
      // Scrolls the junction into view before reporting its rect. At 393x650
      // the board runs past the fold, and a clip computed from pre-scroll
      // coordinates lands outside the image entirely.
      const artwork = await page.evaluate((p) => {
        const joints = [...document.querySelectorAll("svg")].filter((svg) => {
          const host = svg.parentElement;
          return host && getComputedStyle(host).zIndex === "12";
        });
        const hit = joints.find((svg) => {
          const r = svg.getBoundingClientRect();
          return (
            p.cx >= r.left - 1 &&
            p.cx <= r.right + 1 &&
            p.cy >= r.top - 1 &&
            p.cy <= r.bottom + 1
          );
        });
        if (!hit) return { found: false };
        hit.scrollIntoView({ block: "center", inline: "center" });
        const rect = hit.getBoundingClientRect();
        return {
          found: true,
          rect: {
            cx: (rect.left + rect.right) / 2,
            cy: (rect.top + rect.bottom) / 2,
          },
          polygons: [...hit.querySelectorAll("polygon")].map((el) => ({
            fill: el.getAttribute("fill"),
            points: el.getAttribute("points"),
          })),
          paths: [...hit.querySelectorAll("path")]
            .filter((el) => el.getAttribute("fill"))
            .map((el) => ({
              fill: el.getAttribute("fill"),
              d: el.getAttribute("d"),
            })),
        };
      }, pillar);
      if (!artwork.found) throw new Error("no joint artwork at the junction");
      await page.waitForTimeout(200);

      const label = `${TAG}-${THEME}-${viewport.name}-dpr${dpr}`;
      console.log(
        `\n[${label}] junction at ${artwork.rect.cx.toFixed(1)},${artwork.rect.cy.toFixed(1)}`,
      );
      console.log(
        JSON.stringify(
          { polygons: artwork.polygons, paths: artwork.paths },
          null,
          2,
        ),
      );

      // Tight crop around the junction, so the shape is legible at a glance.
      const pad = 46;
      await page.screenshot({
        path: `${OUT}/${label}.png`,
        clip: {
          x: Math.max(0, artwork.rect.cx - pad),
          y: Math.max(0, artwork.rect.cy - pad),
          width: pad * 2,
          height: pad * 2,
        },
      });
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.stop();
}

console.log(`\nscreenshots: ${OUT}`);
