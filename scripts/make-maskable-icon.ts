/**
 * Generates the maskable PWA icon from the existing square logo.
 *
 * Why this is not just the 512px logo with `purpose: "maskable"` bolted on:
 * Android crops a maskable icon to whatever shape the launcher uses, and only
 * guarantees that a circle covering the central 80% survives. Our logo runs
 * edge to edge, so declaring it maskable would shave the outer strokes off the
 * W on every round-icon launcher. A maskable icon has to be drawn with that
 * margin baked in, on an opaque background, or it should not claim the purpose.
 *
 * Why the browser does the drawing: the repo has no raster image dependency
 * (frontend/scripts/normalize-icons.ts is SVG-only via svgson), and the harness already starts
 * a real Chrome. Canvas gives correct downscaling for free rather than through
 * a hand-rolled resampler.
 *
 * Usage: bun scripts/make-maskable-icon.ts
 */
import { launchChrome, connect, wait } from "./browser-harness/cdp";

const SOURCE = "frontend/public/favicon/android-chrome-512x512.png";
const OUTPUT = Bun.argv[3] ?? "frontend/public/favicon/maskable-512x512.png";

/**
 * The plate the logo sits on: the design system's light `--background`.
 *
 * The dark background the app actually paints was the obvious first choice and
 * is wrong - the logo's strokes are black, so on `oklch(0.14 0.04 265)` the
 * outline disappears into the plate and the W reads as loose floating diamonds.
 * Rendered both and looked at them. Pass a CSS colour as the first argument to
 * try another; the default is what ships, so keep them in step.
 *
 * This is only the icon plate. The manifest's `background_color` still matches
 * the dark app, so the launch splash does not flash light before the app paints.
 */
const BACKGROUND_OKLCH = Bun.argv[2] ?? "oklch(0.98 0.01 80)";

const SIZE = 512;
/**
 * Android's guaranteed-visible region is a circle across the central 80% of the
 * icon. The largest square that fits inside that circle has side
 * 0.8 * 512 / sqrt(2) = 289.6, so the art is drawn at 288 and centred.
 */
const ART_BOX = 288;

const sourceBytes = await Bun.file(SOURCE).arrayBuffer();
const sourceDataUrl = `data:image/png;base64,${Buffer.from(sourceBytes).toString("base64")}`;

const browser = await launchChrome();
try {
  const page = await connect();
  // A blank same-origin document; canvas needs somewhere to live.
  await page.navigate("about:blank");
  await wait(300);

  const result = (await page.evaluate(`
    (async () => {
      // Resolve the app's oklch background to the hex a manifest can carry.
      // Not via getComputedStyle: Chrome now echoes oklch() back unchanged, and
      // scraping its three numbers yields "#0000109" - a string that still
      // looks like a colour at a glance. Canvas has to rasterise to sRGB, so
      // reading the painted pixel back is a conversion rather than a guess.
      const swatch = document.createElement("canvas");
      swatch.width = swatch.height = 1;
      const sctx = swatch.getContext("2d");
      sctx.fillStyle = ${JSON.stringify(BACKGROUND_OKLCH)};
      sctx.fillRect(0, 0, 1, 1);
      const [sr, sg, sb] = sctx.getImageData(0, 0, 1, 1).data;
      const hex = "#" + [sr, sg, sb]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("");
      if (!/^#[0-9a-f]{6}$/.test(hex)) {
        throw new Error("background did not resolve to a 6-digit hex: " + hex);
      }

      const img = new Image();
      img.src = ${JSON.stringify(sourceDataUrl)};
      await img.decode();

      // Measure the art's real extent: the logo has transparent margin already,
      // and scaling the full canvas would leave the W smaller than intended.
      const measure = document.createElement("canvas");
      measure.width = img.width;
      measure.height = img.height;
      const mctx = measure.getContext("2d");
      mctx.drawImage(img, 0, 0);
      const { data } = mctx.getImageData(0, 0, img.width, img.height);
      let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          if (data[(y * img.width + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const artW = maxX - minX + 1;
      const artH = maxY - minY + 1;

      const canvas = document.createElement("canvas");
      canvas.width = ${SIZE};
      canvas.height = ${SIZE};
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = hex;
      ctx.fillRect(0, 0, ${SIZE}, ${SIZE});
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      const scale = ${ART_BOX} / Math.max(artW, artH);
      const drawW = artW * scale;
      const drawH = artH * scale;
      ctx.drawImage(
        img,
        minX, minY, artW, artH,
        (${SIZE} - drawW) / 2, (${SIZE} - drawH) / 2, drawW, drawH,
      );

      return {
        hex,
        artBounds: [minX, minY, artW, artH],
        dataUrl: canvas.toDataURL("image/png"),
      };
    })()
  `)) as { hex: string; artBounds: number[]; dataUrl: string };

  const [, , artW, artH] = result.artBounds;
  console.log(`background      ${BACKGROUND_OKLCH} -> ${result.hex}`);
  console.log(`source art      ${artW}x${artH} within ${SIZE}x${SIZE}`);
  console.log(`drawn at        ${ART_BOX}px inside the 80% safe circle`);

  const png = Buffer.from(result.dataUrl.split(",")[1], "base64");
  await Bun.write(OUTPUT, png);
  console.log(`wrote           ${OUTPUT} (${png.length} bytes)`);

  page.close();
} finally {
  browser.stop();
}
