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
 * Reports stroke and stroke-width as well as fill and geometry. It did not, and
 * on 2026-08-16 that made it blind: adding a stroke to the tee's path produced
 * an EMPTY diff here while the pixels had genuinely moved. A silent instrument
 * is worse than none, because its silence gets quoted as a clean result.
 *
 * IT ALSO GATES ONE THING (board task df2cf5b5): no pixel INSIDE a pillar may be
 * a colour that CANNOT BE A BLEND of that pillar's own wall colours. Every
 * legitimate pixel is one wall colour, or two meeting along an edge, or three or
 * four meeting at the centre - so it is a convex combination of the palette and
 * its distance to that set is zero. A pixel the board has leaked into sits off
 * the set, because the board is not in the palette. It exits non-zero when that
 * fails.
 *
 * AN EARLIER VERSION GATED "darker than the darkest wall colour" AND WAS BLIND
 * to the defect this task is named after: the tee's hairline measured L=84.6
 * while red in the same pillar was L=76.7, so it sat ABOVE the floor and passed.
 * A second version, "darker than two agreeing neighbours", saw the hairline but
 * also flagged the red wedge's own TIP - a legitimate feature one pixel wide.
 * Distance to the palette separates them: the hairline sits about 24 units off
 * the red-blue segment, the wedge tip sits on it exactly.
 *
 * Two exclusions, both by construction rather than by threshold. A pillar that
 * draws ONE shape has no internal boundary for a seam to form in. And the scan
 * insets by a device pixel, because a pillar's own silhouette blends into the
 * board by design.
 *
 * Run the control before believing a pass:
 *   node scripts/browser-harness/crisp-junction-gallery.mjs --inject-dark=2
 * Every applicable configuration must then FAIL. Two things that control caught
 * about ITSELF on 2026-08-19: it first injected at the pillar centre, which is
 * exactly on an end cap's rim and so was never scanned, and the crop origin was
 * not aligned to device pixels, which shifted every reading by up to a device
 * pixel at DPR 1.25 and reported a pillar's own top edge as a seam.
 *
 * Run before and after a change and diff the output:
 *   node scripts/browser-harness/crisp-junction-gallery.mjs > tmp/gallery-before.txt
 * Env: SHOT_TAG names the screenshot, PROBE_THEME picks crisp|default,
 * GALLERY_DPR the device pixel ratio, GALLERY_VIEWPORT the viewport.
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
/**
 * The per-configuration crops are compared byte for byte across builds, and a
 * fix tuned at one DPR says nothing about the others, so the ratio is a knob.
 */
const DPR = Number(process.env.GALLERY_DPR ?? 2);

/** Desktop by default; "393x650" is the short mobile height defects hide in. */
const [VW, VH] = (process.env.GALLERY_VIEWPORT ?? "1280x1000")
  .split("x")
  .map(Number);

/**
 * Paint this many board-coloured pixels inside every pillar before measuring.
 * The seam check must then FAIL everywhere; if it does not, its zero means
 * nothing. Board task df2cf5b5.
 */
const INJECT_DARK = Number(
  (process.argv.find((a) => a.startsWith("--inject-dark=")) ?? "").split(
    "=",
  )[1] ?? 0,
);

/** The dark board colour a seam lets through, measured on this board 2026-08-19. */
const BOARD_DARK = [11, 18, 41];

let seamFailures = 0;

const RED = "Red";
const BLUE = "Blue";
const GREEN = "Green";
const PURPLE = "Purple";

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
    // The same tee turned a quarter: a vertical run with the stem arriving from
    // the west. territoryOf treats the four sides alike, so this SHOULD mirror
    // "tee" exactly - which is the reason to print it rather than assert it.
    name: "tee-vertical",
    walls: [
      ["north", BLUE],
      ["south", BLUE],
      ["west", RED],
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
  {
    // Each colour owns two ADJACENT walls, so the colour that is not the base
    // contributes two territories that share an edge. That is the one case
    // where the nested composition still draws two pieces of one colour side by
    // side, and it is here to prove they fuse into a single shape rather than
    // leaving a join. A cross cannot test it: there the paired walls are
    // opposite, so they meet at a point and never share an edge.
    name: "adjacent-pairs",
    walls: [
      ["north", RED],
      ["east", RED],
      ["south", BLUE],
      ["west", BLUE],
    ],
  },
  {
    // Four colours in one pillar. Not a curiosity: a wall is coloured by STATE
    // as well as by owner, so a placed wall, a staged wall, a premoved wall and
    // an engine suggestion can meet at one junction in ordinary play. With more
    // than two colours the layer under a boundary is not always one of the two
    // colours forming it, and this is what measures whether that matters.
    name: "four-colours",
    walls: [
      ["north", RED],
      ["east", BLUE],
      ["south", GREEN],
      ["west", PURPLE],
    ],
  },
];

/** Every colour any configuration asks for, in a stable order. */
const COLOURS = [...new Set(CONFIGS.flatMap((c) => c.walls.map(([, w]) => w)))];

/**
 * How far every pixel INSIDE a pillar sits from the set of colours that pillar
 * could legitimately show.
 *
 * Each pixel there is one wall colour, or a mix of the ones meeting at that
 * point, so it is a convex combination of the pillar's palette and its distance
 * to that set is zero but for rounding. A pixel the board has leaked into sits
 * off the set, because the board is not in the palette. That distance is the
 * seam defect measured directly, and it needs no knowledge of where the
 * boundaries are.
 *
 * "Inside" is derived from the artwork the board actually drew, not assumed: the
 * base path says whether this pillar is a square, an end cap's half-disc or an
 * elbow's fillet, and the scan insets by a device pixel so a silhouette's own
 * edge - which blends into the board by design - is never counted.
 */
async function measureSeams(page, dataUrl, entry, clip, dpr, injectDark) {
  const fills = [
    ...new Set([...entry.paths, ...entry.polygons].map((p) => p.slice(0, 7))),
  ];
  const baseD =
    entry.clips[0] ??
    entry.paths[0]?.replace(/^[^[]*\[/, "").replace(/\]$/, "") ??
    "";

  // A pillar that draws ONE shape has no internal boundary, so there is nothing
  // here for a seam to form between and the scan would only be measuring the
  // silhouette's own edge - which blends into the board by design. Excluded by
  // construction, not by threshold: at 393x650 and DPR 2 the end cap's arc put
  // a near-board pixel 1.2 device px inside its analytic rim, and loosening the
  // inset until that passed would have been tuning a number to hide a curve.
  const drawn = entry.paths.length + entry.polygons.length;
  if (drawn < 2) {
    return {
      name: entry.name,
      wallColors: fills,
      scanned: 0,
      injected: "",
      bands: new Array(14).fill(0),
      contaminated: 0,
      worstOff: 0,
      offSamples: [],
      verdict: "one shape",
    };
  }
  const numbers = baseD.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];

  let shape = { kind: "square" };
  if (baseD.includes("A 50 50")) {
    // "M x1 y1 A 50 50 0 0 0 x2 y2 Z" - the ends are a diameter.
    shape = {
      kind: "disc",
      cx: (numbers[0] + numbers[7]) / 2,
      cy: (numbers[1] + numbers[8]) / 2,
      r: 50,
    };
  } else if (baseD.includes("A 100 100")) {
    // "M cx cy L .. A 100 100 0 0 s .. Z" - centred on the meeting corner.
    shape = { kind: "disc", cx: numbers[0], cy: numbers[1], r: 100 };
  }

  const result = await page.evaluate(
    async ([url, box, cl, ratio, sh, palette, inject, dark]) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = image.data;
      const W = canvas.width;
      const H = canvas.height;

      const uOf = (i) => ((cl.x + (i + 0.5) / ratio - box.x) / box.width) * 100;
      const vOf = (j) =>
        ((cl.y + (j + 0.5) / ratio - box.y) / box.height) * 100;
      const at = (i, j) => {
        const k = (j * W + i) * 4;
        return [d[k], d[k + 1], d[k + 2]];
      };

      // One device pixel, in the pillar's own units.
      const inset = (1 / ratio / box.height) * 100;
      const inside = (u, v) => {
        if (u < inset || u > 100 - inset || v < inset || v > 100 - inset)
          return false;
        if (sh.kind !== "disc") return true;
        return Math.hypot(u - sh.cx, v - sh.cy) <= sh.r - inset;
      };

      // Every pixel this configuration owns, found before anything is injected
      // or measured.
      const interior = [];
      for (let j = 0; j < H; j += 1) {
        for (let i = 0; i < W; i += 1) {
          if (inside(uOf(i), vOf(j))) interior.push([i, j]);
        }
      }

      // Inject into the MIDDLE of that list rather than at a fixed point. The
      // first attempt used the pillar's centre, which sits exactly on an end
      // cap's rim and so was never scanned - the control reported "ok" for a
      // configuration it had not touched (2026-08-19).
      const injected = [];
      for (let n = 0; n < inject && n < interior.length; n += 1) {
        const [i, j] = interior[Math.floor(interior.length / 2) + n];
        const k = (j * W + i) * 4;
        d[k] = dark[0];
        d[k + 1] = dark[1];
        d[k + 2] = dark[2];
        injected.push(`${uOf(i).toFixed(0)},${vOf(j).toFixed(0)}`);
      }

      const hex = (p) =>
        `#${p.map((c) => c.toString(16).padStart(2, "0")).join("")}`;

      // CONTAMINATION: a pixel whose colour cannot be a blend of this pillar's
      // own wall colours.
      //
      // Every legitimate pixel here is one wall colour, or two meeting along an
      // edge, or three or four meeting at the centre - so it is a convex
      // combination of the palette, and its distance to that set is zero. A
      // pixel the board has leaked into sits OFF that set, because the board is
      // not in the palette. This is the seam defect stated exactly, and it needs
      // no knowledge of where the boundaries are.
      //
      // It replaces two weaker tests. "Darker than the darkest wall colour"
      // could not see the tee's own hairline: that measured L=84.6 while red in
      // the same pillar was L=76.7, so the defect this task is named after sat
      // above the floor and passed. "Darker than two agreeing neighbours" did
      // see it, but also flagged the red wedge's own TIP - a legitimate feature
      // one pixel wide, darker than the blue around it. Distance to the palette
      // separates the two: the hairline sits 24 units off the red-blue segment,
      // the wedge tip sits on it exactly (measured 2026-08-19).
      const rgbPalette = palette.map((h) => [
        parseInt(h.slice(1, 3), 16),
        parseInt(h.slice(3, 5), 16),
        parseInt(h.slice(5, 7), 16),
      ]);
      const mix = (weights) => {
        const out = [0, 0, 0];
        for (let n = 0; n < rgbPalette.length; n += 1)
          for (let c = 0; c < 3; c += 1)
            out[c] += weights[n] * rgbPalette[n][c];
        return out;
      };
      const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      // Distance to the palette's convex hull, by descent on the simplex over
      // ALL the colours at once.
      //
      // Sampling pairs and triples was wrong and Reviewer 3 caught it: four
      // colours in RGB form a tetrahedron, and a pixel in its interior needs all
      // four weights. Any point missed that way is reported as further off than
      // it is, which inflates the count.
      //
      // This is an APPROXIMATION, not an exact projection, and here is exactly
      // what it does and does not establish.
      //
      // The value returned is the distance at a REACHABLE blend, so it can only
      // overstate the true minimum, never understate it. The continuous
      // objective |Aw - p| is convex over a convex simplex and so has no
      // non-global local minimum - but what runs here is a finite LATTICE
      // search, not that continuous descent. It stops when no transfer of the
      // final step, 1/1024 of the total weight, improves the value.
      //
      // IT ESTABLISHES NO BOUND ON HOW FAR THE RESULT SITS FROM THE TRUE
      // PROJECTION. Coordinate-wise locality on a lattice is not that claim, and
      // two earlier versions of this comment asserted it anyway - first as
      // "weights within 1e-3", then by calling one step's 0.43 units a residual
      // and arguing from it that the gate could not move (Reviewer 3,
      // 2026-08-19). Neither followed.
      //
      // What is on the record instead is measured, not argued: halving the final
      // step from 1/512 to 1/1024 left every printed figure unchanged. The clean
      // build's largest distances (2.9, 2.1, 3.0, 3.1, 2.9, 1.8, 2.1, 3.4) and
      // the known-bad's pass and fail counts were identical before and after, at
      // all eight combinations.
      const hullDistance = (p) => {
        const m = rgbPalette.length;
        let weights = new Array(m).fill(1 / m);
        let best = dist(p, mix(weights));
        for (let step = 0.5; step >= 1 / 1024; step /= 2) {
          for (let pass = 0; pass < 40; pass += 1) {
            let moved = false;
            for (let from = 0; from < m; from += 1) {
              if (weights[from] < step) continue;
              for (let to = 0; to < m; to += 1) {
                if (to === from) continue;
                const trial = weights.slice();
                trial[from] -= step;
                trial[to] += step;
                const d2 = dist(p, mix(trial));
                if (d2 < best - 1e-9) {
                  weights = trial;
                  best = d2;
                  moved = true;
                }
              }
            }
            if (!moved) break;
          }
        }
        return best;
      };

      // WHERE THIS NUMBER COMES FROM, and what it does NOT do.
      //
      // It is set from the CLEAN side only. Across all eight combinations
      // (desktop 1280x1000 and 393x650, at DPR 1, 1.25, 1.75 and 2) the largest
      // distance a clean build produced over every scanned pixel was 3.4, and
      // that is 8-bit compositing rounding. 8 leaves a 2.4x margin, so the gate
      // does not fire on correct work.
      //
      // THERE IS NO SEPARATING GAP, and an earlier version of this comment
      // claimed one. Measured on commit 5baa2031, which has the seams, the
      // off-palette pixels form a CONTINUUM from about 3 upward - a corner shows
      // 3,4,5 then 8,9, a cross shows every bucket from 1 to 8 - so no threshold
      // divides clean from contaminated. Any value here trades false failures
      // against pixels it does not count (Reviewer 3, 2026-08-19).
      //
      // What the gate does guarantee is measured on both sides, and it is not
      // total. It stays silent on the clean build at all eight combinations. On
      // the known-bad it fires for every configuration at seven of the eight,
      // because those pillars also carry pixels 13 units or further out, far
      // above any plausible setting - detection rests on that population, not on
      // the marginal pixels.
      //
      // THE ONE IT MISSES, stated so nobody reads a pass as proof: at desktop
      // DPR 1.25 the known-bad's straight seam peaks at 3.5 against a clean
      // ceiling of 3.4 at the same combination. The pillar is only 18 device
      // pixels across there, and its contamination is the same magnitude as
      // compositing rounding, so no threshold separates them without failing
      // correct work. That is a resolution limit of this measurement, not a
      // threshold that could be tuned better.
      //
      // The run prints the full histogram so the next person can check all of
      // this rather than take it from a comment.
      const OFF_PALETTE = 8;
      let contaminated = 0;
      let worstOff = 0;
      const offSamples = [];
      // Where every pixel sits, not just the ones over the line. A threshold is
      // only worth anything if the clean and contaminated populations fall on
      // opposite sides of a GAP, and that is visible here rather than asserted.
      const bands = new Array(14).fill(0);
      for (const [i, j] of interior) {
        const p = at(i, j);
        const off = hullDistance(p);
        bands[Math.min(13, Math.floor(off))] += 1;
        if (off > worstOff) worstOff = off;
        if (off > OFF_PALETTE) {
          contaminated += 1;
          if (offSamples.length < 3)
            offSamples.push(
              `u=${uOf(i).toFixed(0)} v=${vOf(j).toFixed(0)} ${hex(p)} sits ${off.toFixed(1)} off the palette`,
            );
        }
      }

      return {
        bands,
        contaminated,
        worstOff: Number(worstOff.toFixed(1)),
        offSamples,
        scanned: interior.length,
        injected: injected.join(" "),
      };
    },
    [dataUrl, entry.rect, clip, dpr, shape, fills, injectDark, BOARD_DARK],
  );

  return {
    name: entry.name,
    wallColors: fills,
    ...result,
    verdict: result.contaminated > 0 ? "SEAM" : "ok",
  };
}

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
    viewport: { width: VW, height: VH },
    deviceScaleFactor: DPR,
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

  // Spread the configurations out so no two share a wall. Two pillars share one
  // only when they sit in the SAME row or column AND are one pitch apart, so
  // that is exactly what this rejects. Earlier rules were stricter than the
  // requirement and ran out of intersections - first at six configurations,
  // then at eight (2026-08-19).
  // Measured from the board rather than written in pixels: at 393 wide the
  // pitch is about half the desktop one, and fixed thresholds either rejected
  // every intersection or accepted neighbours that share a wall.
  const pitch = Math.min(
    ...points.flatMap((a) =>
      points
        .filter((b) => Math.abs(b.y - a.y) < 2 && b.x > a.x)
        .map((b) => b.x - a.x),
    ),
  );
  const shareAWall = (a, b) =>
    (Math.abs(a.y - b.y) < pitch / 3 && Math.abs(a.x - b.x) < pitch * 1.5) ||
    (Math.abs(a.x - b.x) < pitch / 3 && Math.abs(a.y - b.y) < pitch * 1.5);
  const chosen = [];
  for (const p of points) {
    if (chosen.every((c) => !shareAWall(c, p))) chosen.push(p);
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
  for (const colour of COLOURS) {
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
        const r = hit.getBoundingClientRect();
        return {
          name,
          found: true,
          rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          // The outline the art is bounded by, wherever this build keeps it: a
          // clip path, or the base shape itself. Reading it from the DOM rather
          // than assuming one build's structure is what lets this instrument
          // measure an OLDER build - and measuring the old build is the only
          // control that proves the seam check can see a real seam.
          clips: [...hit.querySelectorAll("clipPath path")].map((el) =>
            el.getAttribute("d"),
          ),
          polygons: [...hit.querySelectorAll("polygon")].map(
            (el) => `${el.getAttribute("fill")} [${el.getAttribute("points")}]`,
          ),
          paths: [...hit.querySelectorAll("path")]
            .filter((el) => el.getAttribute("fill"))
            .map(
              (el) =>
                `${el.getAttribute("fill")} stroke=${el.getAttribute("stroke")}/${el.getAttribute("stroke-width")} [${el.getAttribute("d")}]`,
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

  // One crop per configuration, so "the other four did not move" is a file
  // comparison rather than a reading of the board shot. The SVG report cannot
  // settle it on its own: widening a clip changes an attribute for four
  // configurations whose PIXELS are expected to stay put, and only the pixels
  // answer that. Compare with sha256 across two builds - and check first that
  // two runs of the SAME build agree, or an equal pair proves nothing.
  const PAD = 10;
  const seams = [];
  for (const [index, entry] of report.entries()) {
    if (!entry.found) continue;
    // Scroll this pillar into view and re-read it. At 393x650 the board runs
    // past the fold, and a clip computed from an off-screen rect is not a crop
    // of anything.
    entry.rect = await page.evaluate((armIndex) => {
      const kids = document.querySelector(".grid.w-full.relative").children;
      const arm = kids[armIndex].getBoundingClientRect();
      const x = arm.right;
      const y = (arm.top + arm.bottom) / 2;
      const svg = [...document.querySelectorAll("svg")].find((el) => {
        const host = el.parentElement;
        if (!host || getComputedStyle(host).zIndex !== "12") return false;
        const r = el.getBoundingClientRect();
        return (
          x >= r.left - 2 &&
          x <= r.right + 2 &&
          y >= r.top - 2 &&
          y <= r.bottom + 2
        );
      });
      svg.scrollIntoView({ block: "center", inline: "center" });
      const r = svg.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    }, chosen[index].arms.west.index);
    // Snap the crop to whole DEVICE pixels. Playwright rounds a clip itself, and
    // the seam scan maps image pixels back into the pillar's box using this
    // origin - so an unrounded origin shifts every reading by up to a device
    // pixel. At 393x650 and DPR 1.25 that put the pillar's own top edge a
    // nominal 6 units inside the box and reported it as a seam (2026-08-19).
    const snap = (value) => Math.floor(value * DPR) / DPR;
    const clip = {
      x: snap(entry.rect.x - PAD),
      y: snap(entry.rect.y - PAD),
      width: snap(entry.rect.width + PAD * 2),
      height: snap(entry.rect.height + PAD * 2),
    };
    const file = `${OUT}/${TAG}-${THEME}-dpr${String(DPR).replace(".", "_")}-cfg-${entry.name}.png`;
    const shot = await page.screenshot({ path: file, clip });
    seams.push(
      await measureSeams(
        page,
        `data:image/png;base64,${shot.toString("base64")}`,
        entry,
        clip,
        DPR,
        INJECT_DARK,
      ),
    );
  }

  console.log(
    "\n=== how far each pillar's pixels sit from its own palette ===",
  );
  console.log(
    INJECT_DARK
      ? `CONTROL RUN: ${INJECT_DARK} board-coloured pixel(s) injected inside each pillar. Every configuration must FAIL.`
      : "MEASUREMENT RUN: no injection.",
  );
  for (const s of seams) {
    console.log(
      `\n[${s.name}] ${s.verdict}  scanned ${s.scanned} px, wall colours ${s.wallColors.join(" ")}`,
    );
    console.log(
      `  pixels that cannot be a blend of those colours: ${s.contaminated}` +
        `  (largest distance from the palette: ${s.worstOff}, threshold 8)`,
    );
    console.log(
      `  distance histogram, 1 unit per bucket: ${s.bands
        .map((n, k) => (n ? `${k}${k === 13 ? "+" : ""}:${n}` : null))
        .filter(Boolean)
        .join("  ")}`,
    );
    for (const h of s.offSamples ?? []) console.log(`    ${h}`);
    if (s.injected) console.log(`  injected at ${s.injected}`);
  }
  const applicable = seams.filter((s) => s.verdict !== "one shape");
  const failures = applicable.filter((s) =>
    INJECT_DARK ? s.verdict === "ok" : s.verdict !== "ok",
  );
  console.log(
    `\n${failures.length === 0 ? "SEAM PASS" : "SEAM FAIL"}: ${applicable.length - failures.length}/${applicable.length} configurations with an internal boundary` +
      ` (${seams.length - applicable.length} excluded: one shape, no boundary)`,
  );
  seamFailures = failures.length;

  await page.screenshot({
    path: `${OUT}/${TAG}-${THEME}-board.png`,
    fullPage: false,
  });
  await page.close();
} finally {
  await browser.close();
  await server.stop();
}

process.exit(seamFailures === 0 ? 0 : 1);
