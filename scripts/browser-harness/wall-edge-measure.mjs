/**
 * Where exactly does the wall's edge fall, and where does its joint's edge fall?
 *
 * Measured as a sub-pixel crossing rather than by classifying pixels: a wall's
 * neighbour is a CELL and a joint's neighbour is the darker background, so the
 * same geometry produces different-looking pixels on either side and any
 * threshold-based comparison lies. Reading the red channel's 50% crossing
 * between its two plateaus is neighbour-independent.
 *
 * HOW TO RUN. This drives the SOURCE through a dev server, not `dist`, because
 * it asks about pixels and needs to flip themes and DPRs quickly. Start one
 * first, in another shell:
 *
 *   cd frontend && bun run dev -- --port 5175 --host 127.0.0.1
 *
 * then, from the repo root:
 *
 *   EDGE_DPR=1.25 node scripts/browser-harness/wall-edge-measure.mjs
 *
 * Env: PROBE_BASE (default http://127.0.0.1:5175) if your dev server landed on
 * another port - vite silently picks the next free one when 5175 is taken.
 * EDGE_DPR sets the device pixel ratio.
 *
 * This is an INSTRUMENT, not a gate. Nothing here asserts and no CI runs it.
 */
import { chromium } from "playwright-core";

const BASE = process.env.PROBE_BASE ?? "http://127.0.0.1:5175";
const DPR = Number(process.env.EDGE_DPR ?? 2);
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
  await p.evaluate(() => {
    localStorage.setItem("wall-game-board-theme", JSON.stringify("crisp"));
    localStorage.setItem("wall-game-theme", "dark");
  });
  await p.goto(`${BASE}/study-board`, { waitUntil: "networkidle" });
  await p.waitForSelector(".grid.w-full.relative");
  await p.waitForTimeout(1200);

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
    const o = [];
    [...g.children].forEach((el, index) => {
      if (getComputedStyle(el).zIndex !== "15") return;
      const r = el.getBoundingClientRect();
      o.push({ index, x: r.left, y: r.top, vertical: r.height > r.width });
    });
    return o;
  });
  const click = (i) =>
    p.evaluate(
      (k) =>
        document.querySelector(".grid.w-full.relative").children[k].click(),
      i,
    );
  const vert = slots
    .filter((s) => s.vertical)
    .sort((a, z) => a.x - z.x || a.y - z.y);
  await pick("wall-color", "Red");
  await click(vert[10].index);
  await pick("wall-color", "Blue");
  await click(vert[11].index);
  await p.waitForTimeout(400);

  /**
   * Geometry, read from the DIV-based board.
   *
   * This originally read SVG <rect>/<g transform> attributes, because it was
   * written against the SVG wall rasterizer. That work was reverted (d07a8f9),
   * so walls are positioned divs again and joints are divs wrapping an <svg>.
   * Rects come from getBoundingClientRect relative to the grid, which is the
   * same quantity the old attribute-reading produced.
   */
  const geo = await p.evaluate(() => {
    const grid = document.querySelector(".grid.w-full.relative");
    const origin = grid.getBoundingClientRect();
    const rectOf = (el) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.left - origin.left,
        y: r.top - origin.top,
        w: r.width,
        h: r.height,
      };
    };
    const walls = [];
    const joints = [];
    for (const el of grid.children) {
      if (el.tagName.toLowerCase() !== "div") continue;
      const style = getComputedStyle(el);
      if (style.position !== "absolute") continue;
      if (style.zIndex === "12") joints.push(rectOf(el));
      else if ((el.getAttribute("class") || "").includes("shadow-md")) {
        walls.push({ ...rectOf(el), fill: style.backgroundColor });
      }
    }
    return { walls, joints };
  });
  if (geo.walls.length < 2) {
    throw new Error(`expected 2 placed walls, found ${geo.walls.length}`);
  }

  const buf = await p.locator(".grid.w-full.relative").first().screenshot();
  const res = await p.evaluate(
    async ([dataUrl, geo, dpr]) => {
      const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const chan = (px, py, k) => d[(py * c.width + px) * 4 + k];

      const walls = geo.walls.slice().sort((a, b) => a.y - b.y);
      const [top, bot] = walls;
      // Match on x AS WELL AS y. Filtering by row alone was harmless while only
      // joints carrying artwork were collected, but every intersection is a div
      // in this DOM, so the row filter returns the leftmost column's joint and
      // the printed "declared joint x" then describes a joint 60px from the wall
      // being measured. The scan window is derived from the wall, so the numbers
      // stayed right and only the label lied - which is the kind of thing that
      // makes a later reading impossible to trust.
      const joint = geo.joints.find(
        (j) =>
          j.y > top.y + top.h - 3 &&
          j.y < bot.y + 3 &&
          Math.abs(j.x - top.x) < top.w,
      );
      if (!joint) throw new Error("no joint found between the two walls");

      /**
       * Sub-pixel x where `channel` crosses halfway between the plateau outside
       * the shape and the plateau inside it, scanning outward-to-inward.
       */
      const crossing = (py, channel, fromX, toX) => {
        const dir = toX > fromX ? 1 : -1;
        const outside = chan(fromX, py, channel);
        const inside = chan(toX, py, channel);
        const mid = (outside + inside) / 2;
        for (let x = fromX; x !== toX; x += dir) {
          const a = chan(x, py, channel);
          const bb = chan(x + dir, py, channel);
          if ((a - mid) * (bb - mid) <= 0 && a !== bb) {
            return x + dir * ((mid - a) / (bb - a));
          }
        }
        return null;
      };

      const px = (v) => Math.round(v * dpr);
      // A row well inside the top wall, and a row well inside the joint.
      const wallRow = px(top.y + top.h - 4);
      const jointRow = px(joint.y + joint.h * 0.25);
      const L = px(top.x) - 5;
      const R = px(top.x + top.w) + 5;
      const inL = px(top.x + 3);
      const inR = px(top.x + top.w - 3);

      const out = {};
      for (const [name, row] of [
        ["wall", wallRow],
        ["joint", jointRow],
      ]) {
        out[name] = {
          left: crossing(row, 0, L, inL),
          right: crossing(row, 0, R, inR),
        };
      }
      // And the boundary ACROSS the run: where the red wall hands over to the
      // joint, and the joint to the blue wall. Scanned down the run's centre.
      const midCol = px(top.x + top.w / 2);
      const colScan = (fromY, toY, channel) => {
        const dir = toY > fromY ? 1 : -1;
        const a0 = chan(midCol, fromY, channel);
        const b0 = chan(midCol, toY, channel);
        const mid = (a0 + b0) / 2;
        for (let y = fromY; y !== toY; y += dir) {
          const a = chan(midCol, y, channel);
          const bb = chan(midCol, y + dir, channel);
          if ((a - mid) * (bb - mid) <= 0 && a !== bb) {
            return y + dir * ((mid - a) / (bb - a));
          }
        }
        return null;
      };
      out.runProfile = [];
      for (let y = px(top.y + top.h - 3); y <= px(bot.y + 3); y += 1) {
        out.runProfile.push({
          y: +(y / dpr).toFixed(2),
          rgb: [0, 1, 2].map((k) => chan(midCol, y, k)),
        });
      }
      out.redToBlue = colScan(px(top.y + top.h - 2), px(bot.y + 2), 2);
      out.geo = { top, bot, joint, dpr };
      return out;
    },
    [`data:image/png;base64,${buf.toString("base64")}`, geo, DPR],
  );

  const { top, joint } = res.geo;
  console.log(`DPR ${DPR}`);
  console.log(
    `declared wall  x: ${top.x.toFixed(4)} .. ${(top.x + top.w).toFixed(4)}`,
  );
  console.log(
    `declared joint x: ${joint.x.toFixed(4)} .. ${(joint.x + joint.w).toFixed(4)}`,
  );
  console.log("");
  console.log("MEASURED EDGES (device px, sub-pixel):");
  console.log(
    `  wall  left ${res.wall.left?.toFixed(3)}   right ${res.wall.right?.toFixed(3)}`,
  );
  console.log(
    `  joint left ${res.joint.left?.toFixed(3)}   right ${res.joint.right?.toFixed(3)}`,
  );
  const dl = Math.abs(res.wall.left - res.joint.left);
  const dr = Math.abs(res.wall.right - res.joint.right);
  console.log(
    `  disagreement: left ${dl.toFixed(3)} px, right ${dr.toFixed(3)} px` +
      (Math.max(dl, dr) < 0.25 ? "  -> ALIGNED" : "  -> MISALIGNED"),
  );
  console.log("\nDOWN THE RUN'S CENTRE (looking for a seam at the handover):");
  for (const s of res.runProfile)
    console.log(`  y=${String(s.y).padStart(7)}  rgb=${s.rgb}`);
} finally {
  await b.close();
}
