/**
 * Does the SVG shadow construction in wall-layer.tsx match the CSS box-shadow
 * the wall divs used to carry?
 *
 * Renders both side by side on a blank page - a div with the real box-shadow,
 * and the SVG construction (shadow geometry inflated by `spread`, blurred with
 * a Gaussian of blur/2, painted behind) - then walks outward from each shape's
 * edge and reports how far the shadow is still visible and how strong it is at
 * each distance. Two independent implementations of the same spec should agree
 * to within antialiasing.
 *
 * This exists because CSS drop-shadow() has NO spread parameter, so the first
 * attempt at the last-wall glow silently rendered a smaller effect than the
 * `0 0 8px 3px` it replaced.
 *
 * Usage: bun scripts/browser-harness/shadow-equivalence.mjs
 */
import { chromium } from "playwright-core";

/** The shadows the wall divs carried, as [dx, dy, blur, spread, colour]. */
const CASES = [
  {
    name: "last-wall glow (inline box-shadow, overrode shadow-md)",
    layers: [
      { dx: 0, dy: 0, blur: 8, spread: 3, color: "rgb(230 150 40 / 0.85)" },
    ],
  },
  {
    name: "shadow-md (Tailwind class)",
    layers: [
      { dx: 0, dy: 4, blur: 6, spread: -1, color: "rgb(0 0 0 / 0.1)" },
      { dx: 0, dy: 2, blur: 4, spread: -2, color: "rgb(0 0 0 / 0.1)" },
    ],
  },
  {
    // A calculated wall. CSS opacity fades the whole element AS A UNIT -
    // background and box-shadow together - so the SVG side has to carry the
    // opacity on the group, not on the body rect. Getting that wrong leaves a
    // 50% wall wearing a 100% shadow, which this case exists to catch.
    name: "shadow-md at opacity 0.5 (calculated wall)",
    opacity: 0.5,
    layers: [
      { dx: 0, dy: 4, blur: 6, spread: -1, color: "rgb(0 0 0 / 0.1)" },
      { dx: 0, dy: 2, blur: 4, spread: -2, color: "rgb(0 0 0 / 0.1)" },
    ],
  },
];

const W = 60;
const H = 16;
const PAD = 40;

const page_html = (layers, opacity = 1) => {
  const css = layers
    .map((l) => `${l.dx}px ${l.dy}px ${l.blur}px ${l.spread}px ${l.color}`)
    .join(", ");
  const svgShadows = layers
    .map((l) => {
      const w = W + 2 * l.spread;
      const h = H + 2 * l.spread;
      if (w <= 0 || h <= 0) return "";
      return `<rect x="${PAD - l.spread + l.dx}" y="${PAD - l.spread + l.dy}" width="${w}" height="${h}" style="fill:${l.color};filter:blur(${l.blur / 2}px)"/>`;
    })
    .join("");
  return `<!doctype html><html><body style="margin:0;background:#0b1020">
<div id="css" style="position:absolute;left:${PAD}px;top:${PAD}px;width:${W}px;height:${H}px;background:#dc2626;box-shadow:${css};opacity:${opacity}"></div>
<svg id="svg" style="position:absolute;left:0;top:${PAD * 2 + H}px;overflow:visible" width="${PAD * 2 + W}" height="${PAD * 2 + H}">
  <g opacity="${opacity}">
    ${svgShadows}
    <rect x="${PAD}" y="${PAD}" width="${W}" height="${H}" fill="#dc2626"/>
  </g>
</svg>
</body></html>`;
};

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--no-sandbox"],
});

let worstGap = 0;
let extentMismatch = 0;
for (const testCase of CASES) {
  const page = await browser.newPage({
    viewport: { width: PAD * 2 + W + 20, height: (PAD * 2 + H) * 2 + 40 },
    deviceScaleFactor: 1,
  });
  await page.setContent(page_html(testCase.layers, testCase.opacity ?? 1));
  await page.waitForTimeout(300);
  const buf = await page.screenshot();

  const profile = await page.evaluate(
    async ([dataUrl, w, h, pad]) => {
      const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const px = (x, y) => {
        const i = (Math.round(y) * c.width + Math.round(x)) * 4;
        return [d[i], d[i + 1], d[i + 2]];
      };
      const bg = px(2, 2);
      const diff = (p) =>
        Math.max(
          Math.abs(p[0] - bg[0]),
          Math.abs(p[1] - bg[1]),
          Math.abs(p[2] - bg[2]),
        );
      // Walk DOWN from each shape's bottom edge; the glow is symmetric and
      // shadow-md is offset downward, so this row sees both.
      const midX = pad + w / 2;
      const walk = (topY) => {
        const out = [];
        for (let k = 1; k <= 20; k += 1) out.push(diff(px(midX, topY + h + k)));
        return out;
      };
      return { css: walk(pad), svg: walk(pad * 2 + h + pad), bg };
    },
    [`data:image/png;base64,${buf.toString("base64")}`, W, H, PAD],
  );

  const extent = (arr) => arr.filter((v) => v > 2).length;
  const gaps = profile.css.map((v, i) => Math.abs(v - profile.svg[i]));
  const gap = Math.max(...gaps);
  worstGap = Math.max(worstGap, gap);
  // Compare visible EXTENT as well as per-pixel strength. A faint shadow (10%
  // black) can be rendered at DOUBLE strength and still differ by only 2/255,
  // which sails under any per-pixel threshold loose enough to tolerate
  // antialiasing - but it reaches visibly further, and that is what a player
  // sees. Verified: with opacity applied to the body rect instead of the
  // group, per-pixel gap is 2 (passes) while extent is 0px vs 3px (fails).
  const extentGap = Math.abs(extent(profile.css) - extent(profile.svg));
  extentMismatch = Math.max(extentMismatch, extentGap);

  console.log(`\n${testCase.name}`);
  console.log(
    `  distance px : ${[...Array(10)].map((_, i) => String(i + 1).padStart(4)).join("")}`,
  );
  console.log(
    `  CSS         : ${profile.css
      .slice(0, 10)
      .map((v) => String(v).padStart(4))
      .join("")}`,
  );
  console.log(
    `  SVG         : ${profile.svg
      .slice(0, 10)
      .map((v) => String(v).padStart(4))
      .join("")}`,
  );
  console.log(
    `  visible extent: CSS ${extent(profile.css)}px, SVG ${extent(profile.svg)}px, worst per-pixel gap ${gap}`,
  );
  await page.close();
}

const equivalent = worstGap <= 6 && extentMismatch <= 1;
console.log(
  `\nWorst per-pixel disagreement: ${worstGap} (0-255 scale). ` +
    `Worst visible-extent disagreement: ${extentMismatch}px. ` +
    (equivalent ? "EQUIVALENT" : "NOT EQUIVALENT"),
);
if (!equivalent) process.exitCode = 1;
await browser.close();
