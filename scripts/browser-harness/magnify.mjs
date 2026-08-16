/**
 * Nearest-neighbour magnifier for board captures.
 *
 * Board task c003ec83, 2026-08-16: a Crisp junction was reported clean, twice,
 * off 1x screenshots. Nil magnified the same file 3x and found two defects
 * still in it - a red sliver piercing the run and a shade step in the blue -
 * which had been invisible to me, to Reviewer 3 and to him at 1x. Magnifying
 * every claimed-clean junction capture is now an acceptance step, not a nicety.
 *
 * `image-rendering: pixelated` is the whole point: a smooth upscale invents
 * gradients and would hide a one-pixel seam exactly like the 1x view did.
 *
 * Run it:
 *   node scripts/browser-harness/magnify.mjs <scale> <file.png> [more.png...]
 * Writes <name>-x<scale>.png beside each input.
 */
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

const [scaleArg, ...files] = process.argv.slice(2);
const SCALE = Number(scaleArg);
if (!Number.isFinite(SCALE) || SCALE < 1 || files.length === 0) {
  console.error(
    "usage: node scripts/browser-harness/magnify.mjs <scale> <file.png> [...]",
  );
  process.exit(2);
}

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--no-sandbox"],
});
let status = 0;
try {
  const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
  for (const file of files) {
    const path = resolve(file);
    const bytes = await readFile(path);
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;

    const size = await page.evaluate(async (url) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight };
    }, dataUrl);

    const width = Math.round(size.width * SCALE);
    const height = Math.round(size.height * SCALE);
    await page.setViewportSize({ width, height });
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:#000}
       img{width:${width}px;height:${height}px;image-rendering:pixelated;display:block}</style>
       <img src="${dataUrl}">`,
    );
    await page.waitForTimeout(120);

    const out = join(
      dirname(path),
      `${basename(path, extname(path))}-x${SCALE}${extname(path)}`,
    );
    await page.screenshot({ path: out });
    console.log(`${out}  (${size.width}x${size.height} -> ${width}x${height})`);
  }
} catch (error) {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  status = 1;
} finally {
  await browser.close();
}
process.exit(status);
