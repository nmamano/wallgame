/**
 * Seam probe: is a wall joint painted a pixel off from the wall it joins?
 *
 * THE INVARIANT. Walk across a continuous wall run, column by column. At each
 * column, compare how bright the run is INSIDE the joint against how bright it
 * is INSIDE the wall a few pixels away. In a correct render those match: it is
 * one continuous band of wall. If the joint sits a device pixel off from its
 * wall, the joint is darker than the wall at that same column, and that
 * difference IS the visible seam.
 *
 * Comparing joint-against-wall at the same column, rather than against a fixed
 * colour, is what makes this robust. Every shape has an antialiased outer edge;
 * an absolute test flags that edge and reports a bug that is not there. Only
 * the DIFFERENCE between the two sides is a defect.
 *
 * Fixtures:
 *   twocolour (default) - study board, two owners' walls sharing one joint
 *   puzzle              - puzzle 1, neutral single-coloured walls
 *
 * Env: PROBE_BASE, PROBE_DPRS, PROBE_THEME, PROBE_FIXTURE
 */
import { chromium } from "playwright-core";

const BASE = process.env.PROBE_BASE ?? "http://127.0.0.1:5175";
const DPRS = (process.env.PROBE_DPRS ?? "1,1.25,1.5,1.75,2,2.5,3")
  .split(",")
  .map(Number);
const THEME = process.env.PROBE_THEME ?? "crisp";
const FIXTURE = process.env.PROBE_FIXTURE ?? "twocolour";
const URL = FIXTURE === "puzzle" ? `${BASE}/puzzles/1` : `${BASE}/study-board`;

/** How much darker the joint may be than its wall before it counts as a seam. */
const TOLERANCE = 14;

async function buildTwoColourFixture(page) {
  const trigger = page
    .locator('label[for="wall-color"]')
    .locator("..")
    .getByRole("combobox")
    .first();
  const pickColour = async (name) => {
    await trigger.click();
    await page.getByRole("option", { name, exact: true }).first().click();
    await page.waitForTimeout(200);
  };

  // Clicks are dispatched on the ELEMENT: the board can sit below the fold and
  // a mouse click at an off-screen coordinate silently does nothing.
  const pair = await page.evaluate(() => {
    const grid = document.querySelector(".grid.w-full.relative");
    const slots = [];
    [...grid.children].forEach((el, index) => {
      if (getComputedStyle(el).zIndex !== "15") return;
      const b = el.getBoundingClientRect();
      if (b.height <= b.width) return; // vertical slots only
      slots.push({ index, x: b.left + b.width / 2, y: b.top, h: b.height });
    });
    slots.sort((a, b) => a.x - b.x || a.y - b.y);
    for (let i = 0; i + 1 < slots.length; i += 1) {
      const a = slots[i];
      const b = slots[i + 1];
      if (Math.abs(a.x - b.x) < 1 && Math.abs(b.y - a.y - a.h) < a.h * 0.6) {
        return [a.index, b.index];
      }
    }
    return null;
  });
  if (!pair) throw new Error("no adjacent vertical wall slots found");

  for (const [colour, idx] of [
    ["Red", pair[0]],
    ["Blue", pair[1]],
  ]) {
    await pickColour(colour);
    await page.evaluate(
      (i) =>
        document.querySelector(".grid.w-full.relative").children[i].click(),
      idx,
    );
    await page.waitForTimeout(250);
  }
}

const collectGeometry = () => {
  const grid = document.querySelector(".grid.w-full.relative");
  if (!grid) return null;
  const walls = [];
  const joints = [];
  for (const el of grid.children) {
    if (el.tagName.toLowerCase() !== "svg") continue;
    if (getComputedStyle(el).zIndex === "12") {
      // Joints are <g transform="translate(x y) scale(sx sy) ..."> in one
      // grid-sized SVG. Read the box off the transform, not off a bounding
      // rect: an intersection with no walls paints nothing and would report a
      // zero-sized rect.
      for (const g of el.querySelectorAll("g[transform]")) {
        const t = g.getAttribute("transform");
        const tr = t.match(/translate\(([-\d.]+) ([-\d.]+)\)/);
        const sc = t.match(/scale\(([-\d.]+) ([-\d.]+)\)/);
        if (!tr || !sc) continue;
        const x = parseFloat(tr[1]);
        const y = parseFloat(tr[2]);
        const w = parseFloat(sc[1]) * 100;
        const h = parseFloat(sc[2]) * 100;
        joints.push({
          left: x,
          top: y,
          width: w,
          height: h,
          right: x + w,
          bottom: y + h,
        });
      }
    } else {
      // Wall layer: rects are already in grid coordinates.
      for (const r of el.querySelectorAll("rect[fill]")) {
        const fill = r.getAttribute("fill");
        if (!fill || fill === "none") continue;
        const x = parseFloat(r.getAttribute("x"));
        const y = parseFloat(r.getAttribute("y"));
        const w = parseFloat(r.getAttribute("width"));
        const h = parseFloat(r.getAttribute("height"));
        walls.push({
          left: x,
          top: y,
          width: w,
          height: h,
          right: x + w,
          bottom: y + h,
        });
      }
    }
  }
  if (walls.length === 0) {
    // Pre-fix DOM: walls were positioned divs and each joint had its own div.
    // Kept so this probe can be pointed at the old code and shown to go RED -
    // a check that has never been observed failing is not evidence.
    const gb = grid.getBoundingClientRect();
    const rel = (el) => {
      const b = el.getBoundingClientRect();
      return {
        left: b.left - gb.left,
        top: b.top - gb.top,
        width: b.width,
        height: b.height,
        right: b.right - gb.left,
        bottom: b.bottom - gb.top,
      };
    };
    for (const el of grid.children) {
      const cs = getComputedStyle(el);
      if (cs.zIndex === "12" && el.querySelector("svg")) {
        joints.push(rel(el));
      } else if (
        typeof el.className === "string" &&
        el.className.includes("shadow-md")
      ) {
        walls.push(rel(el));
      }
    }
  }
  return { walls, joints };
};

const probe = async ([dataUrl, geo, dpr, tolerance]) => {
  const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  const lumAt = (x, y) => {
    const px = Math.min(Math.max(Math.round(x * dpr), 0), c.width - 1);
    const py = Math.min(Math.max(Math.round(y * dpr), 0), c.height - 1);
    const i = (py * c.width + px) * 4;
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  };

  const findings = [];
  const stats = { junctions: 0, columns: 0, worst: 0, worstAt: null };
  const near = (a, b, t) => Math.abs(a - b) <= t;
  const step = 1 / dpr;
  const jointAt = (x, y) =>
    geo.joints.some(
      (j) => x >= j.left && x <= j.right && y >= j.top && y <= j.bottom,
    );

  for (let i = 0; i < geo.walls.length; i += 1) {
    for (let j = i + 1; j < geo.walls.length; j += 1) {
      const a = geo.walls[i];
      const b = geo.walls[j];

      // Vertical run: same x band, stacked in y, a joint filling the gap.
      if (near(a.left, b.left, 1.5) && near(a.width, b.width, 1.5)) {
        const [top, bot] = a.top < b.top ? [a, b] : [b, a];
        const midX = top.left + top.width / 2;
        if (
          bot.top - top.bottom > 0.5 &&
          jointAt(midX, (top.bottom + bot.top) / 2)
        ) {
          stats.junctions += 1;
          for (let x = top.left + step; x <= top.right - step; x += step) {
            // Brightest point of the wall at this column, sampled clear of the
            // joint, versus the darkest point inside the joint at the SAME
            // column. Same x on both sides, so a shared outer edge cancels.
            let wallLum = -Infinity;
            for (let y = top.bottom - 6; y <= top.bottom - 2; y += step) {
              wallLum = Math.max(wallLum, lumAt(x, y));
            }
            let jointLum = Infinity;
            for (let y = top.bottom + step; y <= bot.top - step; y += step) {
              jointLum = Math.min(jointLum, lumAt(x, y));
            }
            stats.columns += 1;
            const deficit = wallLum - jointLum;
            if (deficit > stats.worst) {
              stats.worst = Math.round(deficit);
              stats.worstAt = `x=${x.toFixed(2)} wall=${Math.round(wallLum)} joint=${Math.round(jointLum)}`;
            }
            if (deficit > tolerance) {
              findings.push({
                axis: "vertical",
                x: +x.toFixed(2),
                deficit: Math.round(deficit),
              });
            }
          }
        }
      }

      // Horizontal run: same y band, side by side in x.
      if (near(a.top, b.top, 1.5) && near(a.height, b.height, 1.5)) {
        const [lft, rgt] = a.left < b.left ? [a, b] : [b, a];
        const midY = lft.top + lft.height / 2;
        if (
          rgt.left - lft.right > 0.5 &&
          jointAt((lft.right + rgt.left) / 2, midY)
        ) {
          stats.junctions += 1;
          for (let y = lft.top + step; y <= lft.bottom - step; y += step) {
            let wallLum = -Infinity;
            for (let x = lft.right - 6; x <= lft.right - 2; x += step) {
              wallLum = Math.max(wallLum, lumAt(x, y));
            }
            let jointLum = Infinity;
            for (let x = lft.right + step; x <= rgt.left - step; x += step) {
              jointLum = Math.min(jointLum, lumAt(x, y));
            }
            stats.columns += 1;
            const deficit = wallLum - jointLum;
            if (deficit > stats.worst) {
              stats.worst = Math.round(deficit);
              stats.worstAt = `y=${y.toFixed(2)} wall=${Math.round(wallLum)} joint=${Math.round(jointLum)}`;
            }
            if (deficit > tolerance) {
              findings.push({
                axis: "horizontal",
                y: +y.toFixed(2),
                deficit: Math.round(deficit),
              });
            }
          }
        }
      }
    }
  }
  return { findings, stats };
};

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--no-sandbox"],
});

let totalBad = 0;
for (const dpr of DPRS) {
  const page = await browser.newPage({
    viewport: { width: 900, height: 950 },
    deviceScaleFactor: dpr,
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    (t) => localStorage.setItem("wall-game-board-theme", JSON.stringify(t)),
    THEME,
  );
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".grid.w-full.relative");
  await page.waitForTimeout(1200);

  if (FIXTURE === "twocolour") await buildTwoColourFixture(page);
  await page.waitForTimeout(400);

  const geo = await page.evaluate(collectGeometry);
  const buf = await page.locator(".grid.w-full.relative").first().screenshot();
  const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  const { findings, stats } = await page.evaluate(probe, [
    dataUrl,
    geo,
    dpr,
    TOLERANCE,
  ]);

  totalBad += findings.length;
  console.log(
    `DPR ${dpr}: walls=${geo.walls.length} joints=${geo.joints.length} ` +
      `junctions=${stats.junctions} columns=${stats.columns} ` +
      `SEAM=${findings.length} worstDeficit=${stats.worst} (${stats.worstAt ?? "-"})`,
  );
  await page.close();
}
console.log(
  totalBad === 0 ? "RESULT: CLEAN" : `RESULT: ${totalBad} SEAM COLUMNS`,
);
await browser.close();
