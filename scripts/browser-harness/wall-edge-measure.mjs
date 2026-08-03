/**
 * Where exactly does the wall's edge fall, and where does its joint's edge fall?
 *
 * Measured as a sub-pixel crossing rather than by classifying pixels: a wall's
 * neighbour is a CELL and a joint's neighbour is the darker background, so the
 * same geometry produces different-looking pixels on either side and any
 * threshold-based comparison lies. Reading the red channel's 50% crossing
 * between its two plateaus is neighbour-independent.
 */
import { chromium } from "playwright-core";

const DPR = Number(process.env.EDGE_DPR ?? 2);
const b = await chromium.launch({ channel: "chrome", args: ["--no-sandbox"] });
const p = await b.newPage({
  viewport: { width: 900, height: 1400 },
  deviceScaleFactor: DPR,
});
await p.goto("http://127.0.0.1:5175", { waitUntil: "domcontentloaded" });
await p.evaluate(() => {
  localStorage.setItem("wall-game-board-theme", JSON.stringify("crisp"));
  localStorage.setItem("wall-game-theme", "dark");
});
await p.goto("http://127.0.0.1:5175/study-board", { waitUntil: "networkidle" });
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
    (k) => document.querySelector(".grid.w-full.relative").children[k].click(),
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

const geo = await p.evaluate(() => {
  const grid = document.querySelector(".grid.w-full.relative");
  const walls = [];
  const joints = [];
  for (const el of grid.children) {
    if (el.tagName.toLowerCase() !== "svg") continue;
    if (getComputedStyle(el).zIndex === "12") {
      for (const g of el.querySelectorAll("g[transform]")) {
        const t = g.getAttribute("transform");
        const tr = t.match(/translate\(([-\d.]+) ([-\d.]+)\)/);
        const sc = t.match(/scale\(([-\d.]+) ([-\d.]+)\)/);
        if (!tr || !sc || g.children.length === 0) continue;
        joints.push({
          x: parseFloat(tr[1]),
          y: parseFloat(tr[2]),
          w: parseFloat(sc[1]) * 100,
          h: parseFloat(sc[2]) * 100,
        });
      }
    } else {
      for (const r of el.querySelectorAll("rect[fill]")) {
        const f = r.getAttribute("fill");
        if (!f || f === "none") continue;
        walls.push({
          x: parseFloat(r.getAttribute("x")),
          y: parseFloat(r.getAttribute("y")),
          w: parseFloat(r.getAttribute("width")),
          h: parseFloat(r.getAttribute("height")),
          fill: f,
        });
      }
    }
  }
  return { walls, joints };
});

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
    const joint = geo.joints.find(
      (j) => j.y > top.y + top.h - 3 && j.y < bot.y + 3,
    );

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
await b.close();
