/**
 * Does stem colour stop where the Crisp tee's WEDGE says it should?
 *
 * Board task c003ec83. The wedge is the triangle (0,0)-(100,0)-(50,50) in the
 * pillar's own 0..100 box: the arriving wall's colour, apex at the exact centre
 * of the pillar.
 *
 * THIS PROBE GATES TWO THINGS, and only two:
 *
 *  - DEEP. Stem colour goes NO DEEPER than the wedge. That is the 2-pixel spike
 *    class from 8cdadac2, restated for a pillar that now has a wedge in it. The
 *    old probe asked "is there ANY stem colour below the butt face", which the
 *    restored wedge answers "yes" by design; the question that still means
 *    something is whether it goes deeper than the design.
 *  - SPILL. No wall colour outside the pillar and its own arms.
 *
 * IT DOES NOT VERIFY THAT THE WEDGE REACHES THE CENTRE, and an earlier draft of
 * this header claimed it did. What verifies reach is the SVG the artwork asks
 * for, which states the apex exactly and is printed by crisp-junction-gallery.mjs
 * at both tee orientations. Use that.
 *
 * apexDepth below is a DIAGNOSTIC, deliberately not gated. It reports the
 * deepest stem-coloured pixel CENTRE, and that reading is dominated by where the
 * pillar happens to land on the device pixel grid rather than by the apex. It
 * cannot tell a correct wedge from a broken one. Measured 2026-08-19, against a
 * build whose north wedge was deliberately truncated from 50 to 40 - a
 * truncation a person sees at a glance:
 *
 *     correct build   50.4 47.7 45.2 45.2 44.5 43.4 39.7 38.9
 *     truncated       43.7 43.4 38.9 38.2 38.2 36.5 35.7 33.4
 *
 * The ranges OVERLAP. The correct build's floor (38.9, 393x650 at DPR 1.25) sits
 * below the truncated build's ceiling (43.7, desktop at DPR 1.75), and the two
 * agree exactly at 38.9 and at 43.4. No single threshold separates them, so any
 * reach gate here would either fail correct work or pass a visibly short wedge.
 * DO NOT PROMOTE apexDepth TO A GATE without new evidence that it can separate
 * the two; the number looks like a measurement of the apex and is not one.
 *
 * WHY IT MEASURES IN THE PILLAR'S OWN COORDINATES: it reads the pillar's rect
 * from the DOM and maps every device pixel back into the 0..100 box, so the
 * expected depth at each column is min(u, 100-u) exactly. A probe that worked
 * in raw image pixels would need the pillar's size hardcoded, and this board
 * has already been bitten once by a constant that guessed another element's
 * size.
 *
 * THE CONTROL IS PART OF THE RUN, not an afterthought. --inject=N paints N stem
 * -coloured pixels below the apex before the analysis, through the same scan
 * and the same classifier. If DEEP does not then report at least N, the probe
 * is blind and its zero means nothing. 2026-08-16 on this board: an instrument
 * that did not report the property under test returned an empty diff, and the
 * silence was nearly quoted as a clean result.
 *
 * Run it (build first), controls before the measurement:
 *   node scripts/browser-harness/crisp-wedge-probe.mjs --inject=2 --inject-spill=2
 *   node scripts/browser-harness/crisp-wedge-probe.mjs
 * Env: PROBE_DPRS overrides the DPR list, SHOT_TAG names the crops it keeps.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startStaticDistServer } from "./static-dist-server.mjs";

const DIST = join(import.meta.dirname, "../../frontend/dist");
const PORT = 5184;
const OUT = "tmp/crisp-junction";
const TAG = process.env.SHOT_TAG ?? "probe";

const INJECT = Number(
  (process.argv.find((a) => a.startsWith("--inject=")) ?? "").split("=")[1] ??
    0,
);
/** Same idea for the spill count: paint wall colour in a corner that owns none. */
const INJECT_SPILL = Number(
  (process.argv.find((a) => a.startsWith("--inject-spill=")) ?? "").split(
    "=",
  )[1] ?? 0,
);

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 393, height: 650 },
];
const DPRS = (process.env.PROBE_DPRS ?? "1,1.25,1.75,2").split(",").map(Number);

/** How far outside the pillar the crop reaches, in CSS px, to catch spill. */
const PAD = 10;

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

const rows = [];
try {
  for (const viewport of VIEWPORTS) {
    for (const dpr of DPRS) {
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: dpr,
      });
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        localStorage.setItem("wall-game-board-theme", JSON.stringify("crisp"));
        localStorage.setItem("wall-game-theme", "dark");
      });
      await page.goto(`${BASE}/study-board`, { waitUntil: "networkidle" });
      await page.waitForSelector(".grid.w-full.relative");
      await page.waitForTimeout(800);

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
        await page.waitForTimeout(150);
      };
      const click = (index) =>
        page.evaluate(
          (k) =>
            document.querySelector(".grid.w-full.relative").children[k].click(),
          index,
        );

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
      const first = horizontal[Math.floor(horizontal.length / 2)];
      const second = horizontal
        .filter((s) => Math.abs(s.cy - first.cy) < 2 && s.cx > first.cx)
        .sort((a, z) => a.cx - z.cx)[0];
      if (!second) throw new Error("no horizontal neighbour to pair with");
      const guess = { cx: (first.right + second.left) / 2, cy: first.cy };
      const stem = vertical
        .filter((s) => s.bottom <= guess.cy + 2)
        .sort(
          (a, z) =>
            Math.abs(a.cx - guess.cx) - Math.abs(z.cx - guess.cx) ||
            Math.abs(a.bottom - guess.cy) - Math.abs(z.bottom - guess.cy),
        )[0];
      if (!stem) throw new Error("no vertical slot above the junction");

      await pick("Blue");
      await click(first.index);
      await click(second.index);
      await pick("Red");
      await click(stem.index);
      await page.waitForTimeout(400);

      // The pillar's own rect, post-scroll, straight from the element that
      // draws it. Everything below is measured against this box, never against
      // a guessed pillar size.
      const pillar = await page.evaluate(
        ([a, b]) => {
          const kids = document.querySelector(".grid.w-full.relative").children;
          const ra = kids[a].getBoundingClientRect();
          const rb = kids[b].getBoundingClientRect();
          const cx = (ra.right + rb.left) / 2;
          const cy = (ra.top + ra.bottom) / 2;
          const joints = [...document.querySelectorAll("svg")].filter((svg) => {
            const host = svg.parentElement;
            return host && getComputedStyle(host).zIndex === "12";
          });
          const hit = joints.find((svg) => {
            const r = svg.getBoundingClientRect();
            return (
              cx >= r.left - 1 &&
              cx <= r.right + 1 &&
              cy >= r.top - 1 &&
              cy <= r.bottom + 1
            );
          });
          if (!hit) return null;
          hit.scrollIntoView({ block: "center", inline: "center" });
          const r = hit.getBoundingClientRect();
          return {
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
          };
        },
        [first.index, second.index],
      );
      if (!pillar) throw new Error("no joint artwork at the junction");
      await page.waitForTimeout(200);

      const label = `${TAG}-${viewport.name}-dpr${String(dpr).replace(".", "_")}`;
      const clip = {
        x: pillar.left - PAD,
        y: pillar.top - PAD,
        width: pillar.width + PAD * 2,
        height: pillar.height + PAD * 2,
      };
      const shot = await page.screenshot({
        path: `${OUT}/${label}.png`,
        clip,
      });
      const dataUrl = `data:image/png;base64,${shot.toString("base64")}`;

      const result = await page.evaluate(
        async ([url, box, cl, ratio, inject, injectSpill]) => {
          const img = new Image();
          img.src = url;
          await img.decode();
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = image.data;
          const W = canvas.width;
          const H = canvas.height;

          // Device pixel -> the pillar's own 0..100 box.
          const uOf = (i) =>
            ((cl.x + (i + 0.5) / ratio - box.left) / box.width) * 100;
          const vOf = (j) =>
            ((cl.y + (j + 0.5) / ratio - box.top) / box.height) * 100;
          // Inverse, for placing the injected control pixels.
          const iOf = (u) =>
            Math.round((box.left + (u / 100) * box.width - cl.x) * ratio - 0.5);
          const jOf = (v) =>
            Math.round((box.top + (v / 100) * box.height - cl.y) * ratio - 0.5);

          const set = (i, j, rgb) => {
            const k = (j * W + i) * 4;
            data[k] = rgb[0];
            data[k + 1] = rgb[1];
            data[k + 2] = rgb[2];
            data[k + 3] = 255;
          };
          const at = (i, j) => {
            const k = (j * W + i) * 4;
            return [data[k], data[k + 1], data[k + 2]];
          };

          // THE CONTROL. Stem-coloured pixels straight down the pillar's centre
          // line, starting one row below the apex - the exact place and the
          // exact scale of the defect 8cdadac2 had to cover.
          const injected = [];
          for (let n = 0; n < inject; n += 1) {
            const i = iOf(50);
            const j = jOf(50) + 2 + n;
            if (i >= 0 && i < W && j >= 0 && j < H) {
              set(i, j, [220, 38, 38]);
              injected.push(`${uOf(i).toFixed(1)},${vOf(j).toFixed(1)}`);
            }
          }

          // The spill control. A pillar's art owns the square and the walls own
          // their arms; the DIAGONAL corner belongs to neither, so wall colour
          // there is spill by definition and nothing legitimate can put it
          // there.
          const spillInjected = [];
          for (let n = 0; n < injectSpill; n += 1) {
            const i = iOf(-40) + n;
            const j = jOf(-40);
            if (i >= 0 && i < W && j >= 0 && j < H) {
              set(i, j, [220, 38, 38]);
              spillInjected.push(`${uOf(i).toFixed(1)},${vOf(j).toFixed(1)}`);
            }
          }

          // Stem colour is red-dominant, run colour blue-dominant. A lift of 40
          // is far below either pure colour and far above the board's dark
          // background, so a blend counts as present rather than being rounded
          // away - the 2026-08-16 lesson that a "near-pure only" test read a
          // real blended pixel as clean.
          const isStem = (p) => p[0] - p[2] > 40;
          const isRun = (p) => p[2] - p[0] > 40;

          // How far below the ideal diagonal stem colour may legitimately sit.
          //
          // Two terms, both real and both measured rather than chosen to make
          // the run pass. Each territory polygon carries a stroke of 1 unit, so
          // half a unit lands OUTSIDE the triangle - that widening is deliberate
          // (it stops an antialiased hairline between neighbours). And a pixel
          // is scored at its centre, so the deepest pixel the diagonal covers
          // can sit one device pixel below the line.
          //
          // Set to one device pixel alone, the first control run reported ten
          // pixels straight down the wedge edge at desktop DPR 2, all of them
          // pure #dc2626 sitting exactly 3.5 units below a 3.47-unit tolerance.
          // That was the tolerance being wrong, not the artwork.
          const devicePx = (1 / ratio / box.height) * 100;
          // The stroke is half a unit PERPENDICULAR to the edge, and the wedge
          // edge runs at 45 degrees, so vertically it reaches 0.5/cos(45).
          const HALF_STROKE = 0.71;
          const tol = devicePx + HALF_STROKE;
          // The pillar and the wall divs are separate elements, so their edges
          // agree only to within a device pixel or two of antialiasing. Judging
          // "is this pixel part of a wall" on an exact boundary counted the
          // stem's own edge column as spill.
          const edge = devicePx * 2;

          let apex = -Infinity;
          let deep = 0;
          let worstOvershoot = -Infinity;
          let spill = 0;
          const samples = [];
          const spillSamples = [];
          const profile = [];

          for (let i = 0; i < W; i += 1) {
            const u = uOf(i);
            let columnDeepest = null;
            for (let j = 0; j < H; j += 1) {
              const v = vOf(j);
              const p = at(i, j);
              if (!isStem(p) && !isRun(p)) continue;

              // Outside the pillar box. The stem's own wall lives above it
              // (v < 0) inside the pillar's columns, and the run's wall to
              // either side; anything else carrying wall colour is spill.
              const outside =
                u < -tol || u > 100 + tol || v > 100 + tol || v < -tol;
              if (outside) {
                const inStemWall = v < 0 && u > -edge && u < 100 + edge;
                const inRunWall =
                  (u < 0 || u > 100) && v > -edge && v < 100 + edge;
                if (!inStemWall && !inRunWall) {
                  spill += 1;
                  if (spillSamples.length < 6)
                    spillSamples.push(
                      `u=${u.toFixed(1)} v=${v.toFixed(1)} rgb=${p.join(",")}`,
                    );
                }
                continue;
              }
              if (!isStem(p)) continue;
              if (columnDeepest === null || v > columnDeepest)
                columnDeepest = v;

              const design = Math.min(u, 100 - u);
              const overshoot = v - design;
              if (overshoot > worstOvershoot) worstOvershoot = overshoot;
              if (overshoot > tol) {
                deep += 1;
                if (samples.length < 6)
                  samples.push(
                    `u=${u.toFixed(1)} v=${v.toFixed(1)} design=${design.toFixed(1)} rgb=${p.join(",")}`,
                  );
              }
            }
            if (columnDeepest !== null) {
              profile.push(`${u.toFixed(0)}:${columnDeepest.toFixed(0)}`);
              if (columnDeepest > apex) apex = columnDeepest;
            }
          }

          return {
            pillarCss: `${box.width.toFixed(2)}x${box.height.toFixed(2)}`,
            tolUnits: Number(tol.toFixed(2)),
            apexDepth: apex === -Infinity ? null : Number(apex.toFixed(1)),
            worstOvershoot:
              worstOvershoot === -Infinity
                ? null
                : Number(worstOvershoot.toFixed(1)),
            deep,
            spill,
            injected,
            spillInjected,
            samples,
            spillSamples,
            profile: profile.join(" "),
          };
        },
        [dataUrl, pillar, clip, dpr, INJECT, INJECT_SPILL],
      );

      rows.push({ label, ...result });
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.stop();
}

const controls = [];
if (INJECT)
  controls.push(
    `${INJECT} stem-coloured pixel(s) below the apex - DEEP must be >= ${INJECT}`,
  );
if (INJECT_SPILL)
  controls.push(
    `${INJECT_SPILL} stem-coloured pixel(s) in a diagonal corner - spill must be >= ${INJECT_SPILL}`,
  );
console.log(
  controls.length
    ? `CONTROL RUN: ${controls.join("; ")}, at every combination.`
    : "MEASUREMENT RUN: no injection.",
);
for (const r of rows) {
  console.log(
    `\n[${r.label}] pillar ${r.pillarCss} css px, depth tolerance ${r.tolUnits} units`,
  );
  console.log(
    `  DEEP=${r.deep}  spill=${r.spill}  [diagnostic only: apexDepth=${r.apexDepth}, worstOvershoot=${r.worstOvershoot}]`,
  );
  if (r.injected.length) console.log(`  injected at ${r.injected.join(" ")}`);
  if (r.spillInjected.length)
    console.log(`  spill injected at ${r.spillInjected.join(" ")}`);
  for (const s of r.samples) console.log(`    deep  ${s}`);
  for (const s of r.spillSamples) console.log(`    spill ${s}`);
  console.log(`  depth profile u:v  ${r.profile}`);
}

const failed = rows.filter((r) => {
  if (INJECT || INJECT_SPILL) return r.deep < INJECT || r.spill < INJECT_SPILL;
  return r.deep > 0 || r.spill > 0;
});
console.log(
  `\n${failed.length === 0 ? "PASS" : "FAIL"}: ${rows.length - failed.length}/${rows.length} combinations`,
);
process.exit(failed.length === 0 ? 0 : 1);
