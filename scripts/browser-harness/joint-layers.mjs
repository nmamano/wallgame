/**
 * Which layer is the "pillar shifted off its wall" artifact actually in?
 *
 * Three quantities can disagree, and lumping them together is how the last
 * attempt at this ended up rewriting the rasterizer:
 *   1. where the CSS grid really put the CELL edge
 *   2. where the pillar's wrapper DIV box sits
 *   3. where the pillar's SVG artwork is actually PAINTED
 * Layers 1-2 come from the DOM. Layer 3 has to come from pixels.
 *
 * The diagnostic that separates geometry from artwork: paint the wrapper a
 * solid colour. If its painted edge lands where the wall's does while the SVG
 * art does not, the geometry is fine and the artwork is short - which is a
 * much smaller fix than moving coordinates.
 *
 * HOW TO RUN. This drives the SOURCE through a dev server, not `dist`, because
 * it asks about pixels and needs to flip themes and DPRs quickly. Start one
 * first, in another shell:
 *
 *   cd frontend && bun run dev -- --port 5175 --host 127.0.0.1
 *
 * then, from the repo root:
 *
 *   PROBE_THEME=default EDGE_DPR=1.25 node scripts/browser-harness/joint-layers.mjs
 *
 * Env: PROBE_BASE (default http://127.0.0.1:5175) if your dev server landed on
 * another port - vite silently picks the next free one when 5175 is taken.
 * EDGE_DPR sets the device pixel ratio, PROBE_THEME picks crisp|default.
 *
 * This is an INSTRUMENT, not a gate. Nothing here asserts and no CI runs it.
 */
import { chromium } from "playwright-core";

const BASE = process.env.PROBE_BASE ?? "http://127.0.0.1:5175";
const DPR = Number(process.env.EDGE_DPR ?? 2);
const THEME = process.env.PROBE_THEME ?? "crisp";
const b = await chromium.launch({ channel: "chrome", args: ["--no-sandbox"] });

// Chrome must not outlive a failed run. A selector that matches nothing or
// an evaluate that throws would otherwise leave a browser process behind, and
// on this box there is no safe way to clean that up later: killing Chrome by
// matching its command line has taken down the office server before.
try {
  const p = await b.newPage({
    viewport: { width: 900, height: 1400 },
    deviceScaleFactor: DPR,
  });
  await p.goto(BASE, { waitUntil: "domcontentloaded" });
  await p.evaluate((t) => {
    localStorage.setItem("wall-game-board-theme", JSON.stringify(t));
    localStorage.setItem("wall-game-theme", "dark");
  }, THEME);
  await p.goto(`${BASE}/study-board`, { waitUntil: "networkidle" });
  await p.waitForSelector(".grid.w-full.relative");
  await p.waitForTimeout(1000);

  const pick = async (l, n) => {
    await p
      .locator(`label[for="${l}"]`)
      .locator("..")
      .getByRole("combobox")
      .first()
      .click();
    await p.getByRole("option", { name: n, exact: true }).first().click();
    await p.waitForTimeout(200);
  };
  const slots = await p.evaluate(() => {
    const g = document.querySelector(".grid.w-full.relative");
    return [...g.children].flatMap((el, index) => {
      if (getComputedStyle(el).zIndex !== "15") return [];
      const r = el.getBoundingClientRect();
      return [{ index, x: r.left, y: r.top, vertical: r.height > r.width }];
    });
  });
  const vert = slots
    .filter((s) => s.vertical)
    .sort((a, z) => a.x - z.x || a.y - z.y);
  await pick("wall-color", "Red");
  await p.evaluate(
    (k) => document.querySelector(".grid.w-full.relative").children[k].click(),
    vert[10].index,
  );
  await pick("wall-color", "Blue");
  await p.evaluate(
    (k) => document.querySelector(".grid.w-full.relative").children[k].click(),
    vert[11].index,
  );
  await p.waitForTimeout(400);

  const dom = await p.evaluate(() => {
    const g = document.querySelector(".grid.w-full.relative");
    const o = g.getBoundingClientRect();
    const rel = (r) => ({
      left: r.left - o.left,
      right: r.right - o.left,
      top: r.top - o.top,
      bottom: r.bottom - o.top,
    });
    const kids = [...g.children];
    const cells = kids
      .filter((c) => getComputedStyle(c).position !== "absolute")
      .map((c) => rel(c.getBoundingClientRect()));
    const walls = kids
      .filter((c) => (c.getAttribute("class") || "").includes("shadow-md"))
      .map((c) => rel(c.getBoundingClientRect()));
    const joints = kids
      .filter((c) => getComputedStyle(c).zIndex === "12")
      .map((c) => rel(c.getBoundingClientRect()));
    const wall = walls.sort((a, z) => a.top - z.top)[0];
    const joint = joints.find(
      (j) => Math.abs(j.left - wall.left) < 1 && j.top > wall.bottom - 3,
    );
    // the cell edge this wall is supposed to hug
    const cell = cells.reduce(
      (best, c) =>
        Math.abs(c.right - wall.left) < Math.abs(best.right - wall.left)
          ? c
          : best,
      cells[0],
    );
    return { wall, joint, cellRight: cell.right };
  });

  /** Sub-pixel x where the painted colour crosses halfway, scanned outward-in. */
  const paintedEdges = async (row) => {
    const buf = await p.locator(".grid.w-full.relative").first().screenshot();
    return p.evaluate(
      async ([url, geo, dpr, py]) => {
        const img = await createImageBitmap(await (await fetch(url)).blob());
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const at = (x) => d[(py * c.width + x) * 4];
        const cross = (from, to) => {
          const dir = to > from ? 1 : -1;
          const mid = (at(from) + at(to)) / 2;
          for (let x = from; x !== to; x += dir) {
            const a = at(x),
              n = at(x + dir);
            if ((a - mid) * (n - mid) <= 0 && a !== n)
              return x + dir * ((mid - a) / (n - a));
          }
          return null;
        };
        const px = (v) => Math.round(v * dpr);
        const L = px(geo.left) - 5,
          R = px(geo.right) + 5;
        return {
          left: cross(L, px(geo.left) + 3),
          right: cross(R, px(geo.right) - 3),
        };
      },
      [`data:image/png;base64,${buf.toString("base64")}`, dom.wall, DPR, row],
    );
  };

  const px = (v) => Math.round(v * DPR);
  const wallRow = px(dom.wall.bottom - 4);
  const jointRow = px(
    dom.joint.top + (dom.joint.bottom - dom.joint.top) * 0.25,
  );

  const wallPaint = await paintedEdges(wallRow);
  const jointPaint = await paintedEdges(jointRow);
  await p.evaluate(() => {
    for (const el of document.querySelector(".grid.w-full.relative").children)
      if (getComputedStyle(el).zIndex === "12") el.style.background = "#ff0000";
  });
  await p.waitForTimeout(200);
  const wrapperPaint = await paintedEdges(jointRow);

  const f = (n) => (n == null ? "  n/a  " : n.toFixed(3).padStart(9));
  console.log(`\nDPR ${DPR}  theme ${THEME}   (device px unless noted)`);
  console.log(
    `layer 1  grid CELL right edge (DOM, css px) : ${dom.cellRight.toFixed(4)}`,
  );
  console.log(
    `layer 2  wall box  (DOM, css px)            : ${dom.wall.left.toFixed(4)} .. ${dom.wall.right.toFixed(4)}`,
  );
  console.log(
    `layer 2  joint box (DOM, css px)            : ${dom.joint.left.toFixed(4)} .. ${dom.joint.right.toFixed(4)}`,
  );
  console.log(
    `         box disagreement (css px)          : ${(dom.joint.left - dom.wall.left).toFixed(4)} / ${(dom.joint.right - dom.wall.right).toFixed(4)}`,
  );
  console.log(
    `layer 3  wall PAINTED                       : ${f(wallPaint.left)} ..${f(wallPaint.right)}`,
  );
  console.log(
    `layer 3  joint ART PAINTED                  : ${f(jointPaint.left)} ..${f(jointPaint.right)}`,
  );
  console.log(
    `layer 3  joint WRAPPER painted (diagnostic) : ${f(wrapperPaint.left)} ..${f(wrapperPaint.right)}`,
  );
  const d1 =
    jointPaint.left != null && wallPaint.left != null
      ? jointPaint.left - wallPaint.left
      : null;
  const d2 =
    jointPaint.right != null && wallPaint.right != null
      ? jointPaint.right - wallPaint.right
      : null;
  const w1 =
    wrapperPaint.left != null && wallPaint.left != null
      ? wrapperPaint.left - wallPaint.left
      : null;
  const w2 =
    wrapperPaint.right != null && wallPaint.right != null
      ? wrapperPaint.right - wallPaint.right
      : null;
  console.log(`=> ART   vs wall: left ${f(d1)}  right ${f(d2)}`);
  console.log(`=> WRAPPER vs wall: left ${f(w1)}  right ${f(w2)}`);
} finally {
  await b.close();
}
