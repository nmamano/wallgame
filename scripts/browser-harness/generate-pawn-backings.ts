import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dir, "../..");
const SOURCE_ROOT = path.join(ROOT, "frontend/public/pawns");
const OUTPUT_ROOT = path.join(ROOT, "frontend/public/pawn-backings");
const PAWN_TYPES = ["cat", "mouse", "home"] as const;
const SIZE = 300;
const OUTLINE_RADIUS = 8;
const ALPHA_THRESHOLD = 24;

type PawnType = (typeof PAWN_TYPES)[number];

const requestedType = process.argv[2];
const selectedTypes: readonly PawnType[] = requestedType
  ? PAWN_TYPES.filter((type) => type === requestedType)
  : PAWN_TYPES;

if (requestedType && selectedTypes.length === 0) {
  throw new Error(`Unknown pawn type: ${requestedType}`);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();

try {
  for (const type of selectedTypes) {
    const sourceDir = path.join(SOURCE_ROOT, type);
    const outputDir = path.join(OUTPUT_ROOT, type);
    await mkdir(outputDir, { recursive: true });
    const files = (await readdir(sourceDir))
      .filter((name) => name.endsWith(".svg"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    for (const filename of files) {
      const svg = await readFile(path.join(sourceDir, filename), "utf8");
      const pngBase64 = await page.evaluate(
        async ({ svg, size, outlineRadius, alphaThreshold }) => {
          const image = new Image();
          image.src = `data:image/svg+xml;base64,${btoa(
            unescape(encodeURIComponent(svg)),
          )}`;
          await image.decode();

          const sourceCanvas = document.createElement("canvas");
          sourceCanvas.width = sourceCanvas.height = size;
          const sourceContext = sourceCanvas.getContext("2d", {
            willReadFrequently: true,
          });
          if (!sourceContext) throw new Error("Canvas is unavailable");
          sourceContext.drawImage(image, 0, 0, size, size);
          const sourcePixels = sourceContext.getImageData(0, 0, size, size);

          const outside = new Uint8Array(size * size);
          const queue = new Int32Array(size * size);
          let head = 0;
          let tail = 0;
          const enqueue = (index: number) => {
            if (
              outside[index] ||
              sourcePixels.data[index * 4 + 3] > alphaThreshold
            ) {
              return;
            }
            outside[index] = 1;
            queue[tail++] = index;
          };

          for (let x = 0; x < size; x++) {
            enqueue(x);
            enqueue((size - 1) * size + x);
          }
          for (let y = 0; y < size; y++) {
            enqueue(y * size);
            enqueue(y * size + size - 1);
          }
          while (head < tail) {
            const index = queue[head++];
            const x = index % size;
            const y = Math.floor(index / size);
            if (x > 0) enqueue(index - 1);
            if (x + 1 < size) enqueue(index + 1);
            if (y > 0) enqueue(index - size);
            if (y + 1 < size) enqueue(index + size);
          }

          const maskCanvas = document.createElement("canvas");
          maskCanvas.width = maskCanvas.height = size;
          const maskContext = maskCanvas.getContext("2d");
          if (!maskContext) throw new Error("Canvas is unavailable");
          maskContext.drawImage(image, 0, 0, size, size);
          maskContext.globalCompositeOperation = "source-in";
          maskContext.fillStyle = "white";
          maskContext.fillRect(0, 0, size, size);

          const outputCanvas = document.createElement("canvas");
          outputCanvas.width = outputCanvas.height = size;
          const outputContext = outputCanvas.getContext("2d");
          if (!outputContext) throw new Error("Canvas is unavailable");
          for (let step = 0; step < 40; step++) {
            const angle = (step / 40) * Math.PI * 2;
            outputContext.drawImage(
              maskCanvas,
              Math.cos(angle) * outlineRadius,
              Math.sin(angle) * outlineRadius,
            );
          }
          outputContext.drawImage(maskCanvas, 0, 0);

          const outputPixels = outputContext.getImageData(0, 0, size, size);
          for (let index = 0; index < size * size; index++) {
            if (
              !outside[index] &&
              sourcePixels.data[index * 4 + 3] <= alphaThreshold
            ) {
              outputPixels.data[index * 4] = 255;
              outputPixels.data[index * 4 + 1] = 255;
              outputPixels.data[index * 4 + 2] = 255;
              outputPixels.data[index * 4 + 3] = 255;
            }
          }
          outputContext.putImageData(outputPixels, 0, 0);
          return outputCanvas.toDataURL("image/png").split(",")[1];
        },
        {
          svg,
          size: SIZE,
          outlineRadius: OUTLINE_RADIUS,
          alphaThreshold: ALPHA_THRESHOLD,
        },
      );

      const outputName = filename.replace(/\.svg$/i, ".png");
      await writeFile(
        path.join(outputDir, outputName),
        Buffer.from(pngBase64, "base64"),
      );
    }
    console.log(`Generated ${files.length} ${type} backings`);
  }
} finally {
  await browser.close();
}
