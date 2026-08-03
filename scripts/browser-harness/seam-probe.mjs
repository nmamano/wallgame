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
/** "dark" or "light" - a seam bleeds toward whichever the background is. */
const MODE = process.env.PROBE_MODE ?? "dark";
const URL = FIXTURE === "puzzle" ? `${BASE}/puzzles/1` : `${BASE}/study-board`;

/**
 * How much less of the joint may be covered than its wall, as a fraction, at
 * the same column, before it counts as a seam. A one-device-pixel mismatch
 * costs roughly a whole pixel of coverage at that column.
 */
const TOLERANCE = 0.3;

/**
 * How far, in DEVICE pixels, a joint's side edge may sit from its wall's before
 * it counts as a defect. A joint painted WIDER than its wall leaves no hole for
 * the coverage test to find - every pixel inside the run is solid - so this is a
 * genuinely separate failure, and its absence is why an overhanging joint once
 * passed a clean probe run.
 */
const EDGE_TOLERANCE = 0.25;

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
        // Shadow rects carry their colour via style, not the fill attribute,
        // so requiring fill also excludes them.
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
          color: fill,
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
        walls.push({ ...rel(el), color: cs.backgroundColor });
      }
    }
  }
  return { walls, joints };
};

const probe = async ([dataUrl, geo, dpr, tolerance, edgeTolerance]) => {
  const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  const rgbAt = (x, y) => {
    const px = Math.min(Math.max(Math.round(x * dpr), 0), c.width - 1);
    const py = Math.min(Math.max(Math.round(y * dpr), 0), c.height - 1);
    const i = (py * c.width + px) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const parseColour = (str) => {
    if (str.startsWith("#")) {
      const hex =
        str.length === 4
          ? str
              .slice(1)
              .split("")
              .map((ch) => ch + ch)
              .join("")
          : str.slice(1);
      return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    }
    return str.match(/\d+/g).slice(0, 3).map(Number);
  };

  // The board background, sampled at the intersection FARTHEST from any wall.
  // "Outside a wall's rectangle" is not enough: an intersection at the end of a
  // wall paints that wall's end cap, and sampling it would return the wall
  // colour and make every later comparison meaningless.
  let bg = [0, 0, 0];
  let bestGap = -1;
  for (const j of geo.joints) {
    const cx = (j.left + j.right) / 2;
    const cy = (j.top + j.bottom) / 2;
    let nearest = Infinity;
    for (const w of geo.walls) {
      const dx = Math.max(w.left - cx, 0, cx - w.right);
      const dy = Math.max(w.top - cy, 0, cy - w.bottom);
      nearest = Math.min(nearest, Math.hypot(dx, dy));
    }
    if (nearest > bestGap) {
      bestGap = nearest;
      bg = rgbAt(cx, cy);
    }
  }

  /**
   * How much of this pixel is wall rather than background, in 0..1, estimated
   * by projecting the sampled colour onto the line from the background to the
   * nearest wall colour.
   *
   * Coverage, not brightness. A brightness DEFICIT only catches a seam darker
   * than its wall, so on a light board - where the background is the brighter
   * of the two - a real seam would score negative and pass. Coverage falls
   * below 1 whenever a pixel drifts toward the background, whichever direction
   * that is.
   *
   * `colours` is the whole SEGMENT between the two walls' colours, not just its
   * endpoints. Where two owners' walls meet, the joint legitimately blends red
   * into blue, and judging those purple pixels against red-or-blue alone scored
   * them at about half coverage - flagging every column of a correct render.
   * A blend matches some point ON the segment at full coverage; a pixel bleeding
   * toward the background matches none of them, because the segment runs
   * between the two wall colours and nowhere near the board behind them.
   *
   * The residual check is what makes that distinction safe: a candidate is only
   * accepted if the pixel actually reconstructs as "this much of that colour
   * over the background", so an unrelated colour cannot be explained away by
   * picking a convenient point on the segment.
   */
  const coverage = (p, colours) => {
    let best = 0;
    for (const colour of colours) {
      const v = [colour[0] - bg[0], colour[1] - bg[1], colour[2] - bg[2]];
      const len2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
      if (len2 < 1) continue;
      const dot =
        (p[0] - bg[0]) * v[0] + (p[1] - bg[1]) * v[1] + (p[2] - bg[2]) * v[2];
      const alpha = Math.min(1, Math.max(0, dot / len2));
      if (alpha <= best) continue;
      const residual = Math.hypot(
        p[0] - (bg[0] + alpha * v[0]),
        p[1] - (bg[1] + alpha * v[1]),
        p[2] - (bg[2] + alpha * v[2]),
      );
      if (residual < 40) best = alpha;
    }
    return best;
  };

  /** The two wall colours and the blends between them. */
  const colourSegment = (c1, c2) => {
    const out = [];
    for (let t = 0; t <= 1.0001; t += 0.1) {
      out.push([
        c1[0] + (c2[0] - c1[0]) * t,
        c1[1] + (c2[1] - c1[1]) * t,
        c1[2] + (c2[2] - c1[2]) * t,
      ]);
    }
    return out;
  };

  /**
   * Sub-pixel position of a shape's edge along one axis, as the point where
   * the colour has travelled half way from the plateau outside the shape to
   * the plateau inside it. That midpoint is the geometric edge regardless of
   * what the outside happens to be, which matters here: a wall's neighbour is
   * a CELL and a joint's neighbour is the darker background, so any fixed
   * threshold would compare them unfairly.
   */
  const edgeAt = (fixed, from, to, horizontal) => {
    const at = (v) => (horizontal ? rgbAt(v, fixed) : rgbAt(fixed, v));
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    const outside = at(from);
    const full = dist(at(to), outside);
    if (full < 20) return null; // no edge to find here
    const target = full / 2;
    const dir = to > from ? step : -step;
    let prevV = from;
    let prevD = 0;
    for (let v = from; dir > 0 ? v <= to : v >= to; v += dir) {
      const d = dist(at(v), outside);
      if (prevD <= target && d >= target && d !== prevD) {
        return prevV + (v - prevV) * ((target - prevD) / (d - prevD));
      }
      prevV = v;
      prevD = d;
    }
    return null;
  };

  /**
   * Do the wall and its joint agree on where their shared side edge falls?
   *
   * This is a SEPARATE failure from bleed, and the reason it needs its own
   * check: a joint painted slightly wider than its wall leaves no hole for a
   * coverage test to find - every pixel inside the run is solid - yet it reads
   * as the joint overhanging its wall, which is what a player actually sees.
   *
   * Sampled a quarter of the way into the joint, NOT at its centre: where two
   * owners meet, the centre is the colour handover itself, and an edge read
   * across a colour transition understates the offset by more than half.
   */
  const edgeMismatch = (wall, jointCentre, horizontal) => {
    const wallLine = horizontal ? wall.bottom - 3 : wall.right - 3;
    const out = [];
    for (const [name, from, to] of horizontal
      ? [
          ["left", wall.left - 3, wall.left + 3],
          ["right", wall.right + 3, wall.right - 3],
        ]
      : [
          ["top", wall.top - 3, wall.top + 3],
          ["bottom", wall.bottom + 3, wall.bottom - 3],
        ]) {
      const w = edgeAt(wallLine, from, to, horizontal);
      const j = edgeAt(jointCentre, from, to, horizontal);
      if (w !== null && j !== null) {
        out.push({ side: name, delta: Math.abs(w - j) * dpr });
      }
    }
    return out;
  };

  const findings = [];
  const stats = {
    junctions: 0,
    columns: 0,
    worst: 0,
    worstAt: null,
    worstEdge: 0,
    worstEdgeAt: null,
  };
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
          const colours = colourSegment(
            parseColour(a.color),
            parseColour(b.color),
          );
          for (const m of edgeMismatch(
            top,
            top.bottom + (bot.top - top.bottom) * 0.25,
            true,
          )) {
            if (m.delta > stats.worstEdge) {
              stats.worstEdge = +m.delta.toFixed(3);
              stats.worstEdgeAt = `${m.side} edge`;
            }
            if (m.delta > edgeTolerance) {
              findings.push({
                kind: "edge",
                side: m.side,
                deltaDevicePx: +m.delta.toFixed(3),
              });
            }
          }
          // The run's own outer boundary columns are INCLUDED. Both the wall
          // and the joint are partly covered there, and comparing the two at
          // the same column cancels that shared antialiasing - so a real
          // one-device-pixel mismatch confined to the edge still shows up,
          // where simply skipping the edge would have hidden it.
          for (let x = top.left; x <= top.right; x += step) {
            let wallCov = 0;
            for (let y = top.bottom - 6; y <= top.bottom - 2; y += step) {
              wallCov = Math.max(wallCov, coverage(rgbAt(x, y), colours));
            }
            let jointCov = 1;
            for (let y = top.bottom + step; y <= bot.top - step; y += step) {
              jointCov = Math.min(jointCov, coverage(rgbAt(x, y), colours));
            }
            stats.columns += 1;
            const deficit = wallCov - jointCov;
            if (deficit > stats.worst) {
              stats.worst = +deficit.toFixed(3);
              stats.worstAt = `x=${x.toFixed(2)} wall=${wallCov.toFixed(2)} joint=${jointCov.toFixed(2)}`;
            }
            if (deficit > tolerance) {
              findings.push({
                axis: "vertical",
                x: +x.toFixed(2),
                deficit: +deficit.toFixed(3),
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
          const colours = colourSegment(
            parseColour(a.color),
            parseColour(b.color),
          );
          for (const m of edgeMismatch(
            lft,
            lft.right + (rgt.left - lft.right) * 0.25,
            false,
          )) {
            if (m.delta > stats.worstEdge) {
              stats.worstEdge = +m.delta.toFixed(3);
              stats.worstEdgeAt = `${m.side} edge`;
            }
            if (m.delta > edgeTolerance) {
              findings.push({
                kind: "edge",
                side: m.side,
                deltaDevicePx: +m.delta.toFixed(3),
              });
            }
          }
          for (let y = lft.top; y <= lft.bottom; y += step) {
            let wallCov = 0;
            for (let x = lft.right - 6; x <= lft.right - 2; x += step) {
              wallCov = Math.max(wallCov, coverage(rgbAt(x, y), colours));
            }
            let jointCov = 1;
            for (let x = lft.right + step; x <= rgt.left - step; x += step) {
              jointCov = Math.min(jointCov, coverage(rgbAt(x, y), colours));
            }
            stats.columns += 1;
            const deficit = wallCov - jointCov;
            if (deficit > stats.worst) {
              stats.worst = +deficit.toFixed(3);
              stats.worstAt = `y=${y.toFixed(2)} wall=${wallCov.toFixed(2)} joint=${jointCov.toFixed(2)}`;
            }
            if (deficit > tolerance) {
              findings.push({
                axis: "horizontal",
                y: +y.toFixed(2),
                deficit: +deficit.toFixed(3),
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
    ([t, mode]) => {
      localStorage.setItem("wall-game-board-theme", JSON.stringify(t));
      // Light mode matters for more than looks: there the background is
      // BRIGHTER than the walls, so bleed makes a seam lighter rather than
      // darker. A brightness-deficit metric scores that negative and passes it.
      localStorage.setItem("wall-game-theme", mode);
    },
    [THEME, MODE],
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
    EDGE_TOLERANCE,
  ]);

  totalBad += findings.length;
  console.log(
    `DPR ${dpr}: walls=${geo.walls.length} joints=${geo.joints.length} ` +
      `junctions=${stats.junctions} columns=${stats.columns} ` +
      `SEAM=${findings.length} worstDeficit=${stats.worst} ` +
      `worstEdgeOffset=${stats.worstEdge}dp`,
  );
  await page.close();
}
console.log(
  totalBad === 0 ? "RESULT: CLEAN" : `RESULT: ${totalBad} SEAM COLUMNS`,
);
await browser.close();
