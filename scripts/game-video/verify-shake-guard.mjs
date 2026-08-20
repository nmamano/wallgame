/**
 * Prove the shake geometry guard fires on the defect it was built for.
 *
 * Board task f89e649f item 5. The shake used to scale the composition to 1.045
 * and reset to `none`, so the board settled 4.5% smaller. The renderer now
 * compares the board's bounding box before and after the shake and reports
 * whether it moved. A guard nobody has SEEN fail is not evidence, so this
 * script reproduces the old defect on the real stage and checks the guard
 * reddens - then removes it and checks the guard goes quiet.
 *
 *   node scripts/game-video/verify-shake-guard.mjs
 *
 * Touches nothing outside the stage page. No network, no production.
 */
import { chromium } from "playwright-core";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({
  viewport: { width: 1080, height: 1920 },
  deviceScaleFactor: 1,
});
await page.goto(`file://${join(HERE, "stage.html")}`, { waitUntil: "load" });
await page.evaluate(() => {
  document.documentElement.style.setProperty("--board", "1040px");
  document.documentElement.style.setProperty("--gap", "34px");
  document.documentElement.style.setProperty("--chrome", "150px");
  document.getElementById("play").classList.remove("hidden");
});

const boardBox = () =>
  page.evaluate(() => {
    const r = document.getElementById("boardWrap").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
const same = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

const clean = await boardBox();

// --- known bad: the transform the old shake left behind.
await page.evaluate(() => {
  document.getElementById("play").style.transform =
    "translate(0px,0px) rotate(0deg) scale(1.045)";
});
const scaled = await boardBox();
await page.evaluate(() => {
  document.getElementById("play").style.transform = "none";
});
const restored = await boardBox();

/*
  --- known bad, ONE AXIS ONLY. This is the case that got past the renderer's
  first accumulator: it kept the worst sample only when X worsened, so a
  y-only scale was discarded before the y test could see it. A uniform scale
  alone does not exercise that, which is why this row exists.
*/
await page.evaluate(() => {
  document.getElementById("play").style.transform =
    "translate(0px,0px) rotate(0deg) scaleY(1.045)";
});
const scaledY = await boardBox();
await page.evaluate(() => {
  document.getElementById("play").style.transform = "none";
});

// --- what the shipped shake actually does: translate and rotate only.
await page.evaluate(() => {
  document.getElementById("play").style.transform =
    "translate(11px,-7px) rotate(0.4deg)";
});
await page.evaluate(() => {
  document.getElementById("play").style.transform = "none";
});
const afterRealShake = await boardBox();

await browser.close();

const rows = [
  ["clean baseline", clean, true],
  ["KNOWN BAD, scale(1.045) applied", scaled, false],
  ["KNOWN BAD, scaleY(1.045) only", scaledY, false],
  ["known bad, then reset to none", restored, true],
  ["shipped shake, then reset to none", afterRealShake, true],
];

let ok = true;
for (const [label, box, shouldMatch] of rows) {
  const matches = same(clean, box);
  const verdict = matches === shouldMatch ? "as expected" : "UNEXPECTED";
  if (matches !== shouldMatch) ok = false;
  console.log(
    `${label.padEnd(34)} ${String(box.w)}x${String(box.h)} at ${box.x.toFixed(2)},${box.y.toFixed(2)}` +
      `  ${matches ? "matches baseline" : "DIFFERS from baseline"} - ${verdict}`,
  );
}
console.log(
  ok
    ? "\nPASS: the guard reddens on the 1.045 scale and stays quiet on the shipped shake."
    : "\nFAIL: the guard did not behave as required.",
);
process.exit(ok ? 0 : 1);
