/**
 * Every junction configuration the Crisp theme can draw, in one board.
 *
 * Board task c003ec83 changes which walls decide a pillar's colouring, and the
 * claim that only the TEE moves is a claim about the other four configurations
 * too. "Unchanged by construction" is an argument, not a measurement; this
 * prints the artwork each configuration actually asks for, so a before/after
 * pair settles it.
 *
 * Reads the SVG the board renders rather than the pixels: the chevron is a
 * polygon the artwork requests, so its vertices are the thing that changed.
 * The paired screenshot is for the human judgement no number replaces.
 *
 * INSTRUMENT, not a gate. Run before and after the change and diff the output:
 *   node scripts/browser-harness/crisp-junction-gallery.mjs > tmp/gallery-before.txt
 * Env: SHOT_TAG names the screenshot, PROBE_THEME picks crisp|default.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startStaticDistServer } from "./static-dist-server.mjs";

const DIST = join(import.meta.dirname, "../../frontend/dist");
const PORT = 5183;
const TAG = process.env.SHOT_TAG ?? "gallery";
const THEME = process.env.PROBE_THEME ?? "crisp";
const OUT = "tmp/crisp-junction";

const RED = "Red";
const BLUE = "Blue";

/** Which walls each configuration needs, and in which colour. */
const CONFIGS = [
  { name: "lone-end", walls: [["east", BLUE]] },
  {
    name: "straight-seam",
    walls: [
      ["west", RED],
      ["east", BLUE],
    ],
  },
  {
    name: "corner",
    walls: [
      ["north", RED],
      ["east", BLUE],
    ],
  },
  {
    name: "tee",
    walls: [
      ["west", BLUE],
      ["east", BLUE],
      ["north", RED],
    ],
  },
  {
    name: "cross",
    walls: [
      ["west", BLUE],
      ["east", BLUE],
      ["north", RED],
      ["south", RED],
    ],
  },
];

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
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
    deviceScaleFactor: 2,
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => {
    localStorage.setItem("wall-game-board-theme", JSON.stringify(t));
    localStorage.setItem("wall-game-theme", "dark");
  }, THEME);
  await page.goto(`${BASE}/study-board`, { waitUntil: "networkidle" });
  await page.waitForSelector(".grid.w-full.relative");
  await page.waitForTimeout(800);

  const readSlots = () =>
    page.evaluate(() => {
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

  const slots = await readSlots();
  const horizontal = slots.filter((s) => !s.vertical);
  const vertical = slots.filter((s) => s.vertical);

  // Anchor on the pillar elements themselves rather than on guessed adjacency
  // between wall slots. A pillar IS the gap square (measured 2026-08-16:
  // 12.4 x 14.4 px at 1280 wide), and the click targets align to its edges,
  // whereas slot-to-slot distances are half-gaps that no fixed tolerance
  // matches at every board size.
  const joints = await page.evaluate(() => {
    const grid = document.querySelector(".grid.w-full.relative");
    return [...grid.children].flatMap((el) => {
      if (getComputedStyle(el).zIndex !== "12") return [];
      const r = el.getBoundingClientRect();
      return [{ left: r.left, right: r.right, top: r.top, bottom: r.bottom }];
    });
  });

  const near = (a, b) => Math.abs(a - b) < 4;
  const points = [];
  for (const j of joints) {
    const x = (j.left + j.right) / 2;
    const y = (j.top + j.bottom) / 2;
    const arms = {
      west: horizontal.find((h) => near(h.cy, y) && near(h.right, j.left)),
      east: horizontal.find((h) => near(h.cy, y) && near(h.left, j.right)),
      north: vertical.find((v) => near(v.cx, x) && near(v.bottom, j.top)),
      south: vertical.find((v) => near(v.cx, x) && near(v.top, j.bottom)),
    };
    if (arms.west && arms.east && arms.north && arms.south) {
      points.push({ x, y, arms });
    }
  }
  points.sort((a, b) => a.y - b.y || a.x - b.x);
  if (points.length === 0) {
    throw new Error("no pillar had all four wall slots around it");
  }

  // Spread the configurations out so no two share a wall.
  const chosen = [];
  for (const p of points) {
    if (
      chosen.every((c) => Math.abs(c.x - p.x) > 90 && Math.abs(c.y - p.y) > 90)
    ) {
      chosen.push(p);
    }
    if (chosen.length === CONFIGS.length) break;
  }
  if (chosen.length < CONFIGS.length) {
    throw new Error(`only ${chosen.length} well-separated intersections found`);
  }

  const pick = async (option) => {
    await page
      .locator(`label[for="wall-color"]`)
      .locator("..")
      .getByRole("combobox")
      .first()
      .click();
    await page
      .getByRole("option", { name: option, exact: true })
      .first()
      .click();
    await page.waitForTimeout(120);
  };
  const click = (index) =>
    page.evaluate(
      (k) =>
        document.querySelector(".grid.w-full.relative").children[k].click(),
      index,
    );

  // Place colour by colour: each combobox change is a locator click, which is
  // slow and scrolls, so doing it once per colour rather than once per wall
  // keeps the run short and the page still.
  for (const colour of [BLUE, RED]) {
    await pick(colour);
    for (const [i, config] of CONFIGS.entries()) {
      for (const [side, wantColour] of config.walls) {
        if (wantColour !== colour) continue;
        await click(chosen[i].arms[side].index);
      }
    }
  }
  await page.waitForTimeout(500);

  // Re-read positions: the combobox clicks above scroll the page.
  const report = await page.evaluate(
    ([configNames, indices]) => {
      const kids = document.querySelector(".grid.w-full.relative").children;
      const joints = [...document.querySelectorAll("svg")].filter((svg) => {
        const host = svg.parentElement;
        return host && getComputedStyle(host).zIndex === "12";
      });
      return configNames.map((name, i) => {
        // Recover the intersection from one of its own arms, post-scroll.
        const arm = kids[indices[i]].getBoundingClientRect();
        const x = arm.right;
        const y = (arm.top + arm.bottom) / 2;
        const hit = joints.find((svg) => {
          const r = svg.getBoundingClientRect();
          return (
            x >= r.left - 2 &&
            x <= r.right + 2 &&
            y >= r.top - 2 &&
            y <= r.bottom + 2
          );
        });
        if (!hit) return { name, found: false };
        return {
          name,
          found: true,
          polygons: [...hit.querySelectorAll("polygon")].map(
            (el) => `${el.getAttribute("fill")} [${el.getAttribute("points")}]`,
          ),
          paths: [...hit.querySelectorAll("path")]
            .filter((el) => el.getAttribute("fill"))
            .map(
              (el) => `${el.getAttribute("fill")} [${el.getAttribute("d")}]`,
            ),
        };
      });
    },
    [
      CONFIGS.map((c) => c.name),
      CONFIGS.map((c, i) => chosen[i].arms.west.index),
    ],
  );

  for (const entry of report) {
    console.log(`\n[${entry.name}]`);
    if (!entry.found) {
      console.log("  NOT FOUND");
      continue;
    }
    for (const p of entry.paths) console.log(`  path    ${p}`);
    for (const p of entry.polygons) console.log(`  polygon ${p}`);
  }

  await page.screenshot({
    path: `${OUT}/${TAG}-${THEME}-board.png`,
    fullPage: false,
  });
  await page.close();
} finally {
  await browser.close();
  await server.stop();
}
