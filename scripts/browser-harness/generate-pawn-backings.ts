import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dir, "../..");
const SOURCE_ROOT = path.join(ROOT, "frontend/public/pawns");
const OUTPUT_ROOT = path.join(ROOT, "frontend/public/pawn-backings");
const FOREGROUND_OUTPUT_ROOT = path.join(
  ROOT,
  "frontend/public/pawn-foreground-fixes",
);
const PAWN_TYPES = ["cat", "mouse", "home"] as const;
const SIZE = 300;
const OUTLINE_RADIUS = 8;
const ALPHA_THRESHOLD = 24;

type PawnType = (typeof PAWN_TYPES)[number];

type MaskShape =
  | { kind: "ellipse"; x: number; y: number; rx: number; ry: number }
  | { kind: "path"; d: string };

// A few drawings contain intentional gaps in their outer line work. The generic
// outside flood-fill can reach the face or body through those gaps and mistakes
// an interior for background. These small, asset-specific underlays restore only
// the regions confirmed during production review. Coordinates use the 300px
// generation canvas, so this remains deterministic across regenerations.
const MASK_CORRECTIONS: Readonly<Record<string, readonly MaskShape[]>> = {
  cat9: [{ kind: "ellipse", x: 165, y: 143, rx: 36, ry: 32 }],
  cat31: [{ kind: "ellipse", x: 150, y: 143, rx: 12, ry: 10 }],
  cat47: [{ kind: "ellipse", x: 155, y: 151, rx: 11, ry: 9 }],
  cat52: [{ kind: "ellipse", x: 151, y: 176, rx: 14, ry: 11 }],
  cat54: [{ kind: "ellipse", x: 151, y: 157, rx: 12, ry: 9 }],
  cat58: [{ kind: "ellipse", x: 193, y: 176, rx: 15, ry: 12 }],
  cat73: [{ kind: "ellipse", x: 169, y: 151, rx: 36, ry: 31 }],
  cat75: [{ kind: "ellipse", x: 151, y: 160, rx: 12, ry: 9 }],
  cat84: [{ kind: "ellipse", x: 150, y: 240, rx: 18, ry: 12 }],
  cat94: [{ kind: "ellipse", x: 150, y: 160, rx: 14, ry: 11 }],
  cat105: [{ kind: "ellipse", x: 150, y: 157, rx: 12, ry: 9 }],
  cat111: [{ kind: "ellipse", x: 150, y: 207, rx: 18, ry: 12 }],
  cat126: [{ kind: "ellipse", x: 150, y: 160, rx: 12, ry: 9 }],
  cat150: [{ kind: "ellipse", x: 150, y: 161, rx: 12, ry: 9 }],
  cat168: [{ kind: "ellipse", x: 150, y: 164, rx: 12, ry: 9 }],
  cat174: [{ kind: "ellipse", x: 168, y: 153, rx: 12, ry: 9 }],
  cat179: [{ kind: "ellipse", x: 150, y: 164, rx: 12, ry: 9 }],
  cat181: [{ kind: "ellipse", x: 150, y: 174, rx: 14, ry: 11 }],
  cat188: [{ kind: "ellipse", x: 150, y: 157, rx: 13, ry: 10 }],
  cat237: [
    {
      kind: "path",
      d: "M82 252C64 225 55 193 56 157C57 116 77 83 106 58L115 91C130 82 145 76 162 68L160 102C193 116 214 143 215 173C216 208 198 237 181 257Z",
    },
  ],
  cat245: [
    { kind: "ellipse", x: 145, y: 184, rx: 91, ry: 61 },
    { kind: "ellipse", x: 191, y: 121, rx: 48, ry: 42 },
  ],
  mouse4: [
    { kind: "ellipse", x: 140, y: 193, rx: 49, ry: 68 },
    { kind: "ellipse", x: 165, y: 126, rx: 43, ry: 39 },
  ],
  mouse18: [
    { kind: "ellipse", x: 149, y: 199, rx: 43, ry: 65 },
    { kind: "ellipse", x: 160, y: 126, rx: 42, ry: 38 },
  ],
  mouse26: [{ kind: "ellipse", x: 151, y: 145, rx: 17, ry: 13 }],
  mouse33: [
    { kind: "ellipse", x: 143, y: 194, rx: 54, ry: 62 },
    { kind: "ellipse", x: 143, y: 126, rx: 48, ry: 42 },
  ],
  mouse68: [{ kind: "ellipse", x: 139, y: 137, rx: 19, ry: 15 }],
  mouse74: [
    { kind: "ellipse", x: 150, y: 122, rx: 57, ry: 51 },
    { kind: "ellipse", x: 151, y: 208, rx: 57, ry: 66 },
  ],
  home9: [
    {
      kind: "path",
      d: "M58 142L149 45L242 142L224 159V267H77V159Z",
    },
  ],
};

// These roofs have a long, shallow top edge. The global 8px sticker radius is
// visually heavy there, while the sides and base need the standard outline.
const NARROW_TOP_OUTLINE: Readonly<Record<string, number>> = {
  home5: 4,
  home8: 4,
};

// Opaque nose marks in these two source drawings read as holes after the player
// color filter. A tiny same-color foreground patch covers only that mark. The
// patch is rendered above the source and receives the identical CSS filter.
const FOREGROUND_CORRECTIONS: Readonly<
  Record<string, readonly Extract<MaskShape, { kind: "ellipse" }>[]>
> = {
  cat9: [{ kind: "ellipse", x: 193, y: 135, rx: 6, ry: 5 }],
  cat73: [{ kind: "ellipse", x: 105, y: 153, rx: 6, ry: 5 }],
};

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
    const foregroundOutputDir = path.join(FOREGROUND_OUTPUT_ROOT, type);
    await mkdir(outputDir, { recursive: true });
    await mkdir(foregroundOutputDir, { recursive: true });
    const files = (await readdir(sourceDir))
      .filter((name) => name.endsWith(".svg"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    for (const filename of files) {
      const svg = await readFile(path.join(sourceDir, filename), "utf8");
      const pngBase64 = await page.evaluate(
        async ({
          svg,
          size,
          outlineRadius,
          alphaThreshold,
          maskCorrections,
          narrowTopOutline,
        }) => {
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
          maskContext.globalCompositeOperation = "source-over";
          for (const correction of maskCorrections) {
            maskContext.beginPath();
            if (correction.kind === "ellipse") {
              maskContext.ellipse(
                correction.x,
                correction.y,
                correction.rx,
                correction.ry,
                0,
                0,
                Math.PI * 2,
              );
              maskContext.fillStyle = "white";
              maskContext.fill();
            } else {
              maskContext.fillStyle = "white";
              maskContext.fill(new Path2D(correction.d));
            }
          }

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

          if (narrowTopOutline !== null) {
            const narrower = document.createElement("canvas");
            narrower.width = narrower.height = size;
            const narrowerContext = narrower.getContext("2d");
            if (!narrowerContext) throw new Error("Canvas is unavailable");
            for (let step = 0; step < 40; step++) {
              const angle = (step / 40) * Math.PI * 2;
              narrowerContext.drawImage(
                maskCanvas,
                Math.cos(angle) * narrowTopOutline,
                Math.sin(angle) * narrowTopOutline,
              );
            }
            narrowerContext.drawImage(maskCanvas, 0, 0);
            // Only replace the top half. The normal radius remains on the sides
            // and base, and the mask itself makes the seam invisible.
            outputContext.clearRect(0, 0, size, size / 2);
            outputContext.drawImage(
              narrower,
              0,
              0,
              size,
              size / 2,
              0,
              0,
              size,
              size / 2,
            );
          }

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
          maskCorrections:
            MASK_CORRECTIONS[filename.replace(/\.svg$/i, "")] ?? [],
          narrowTopOutline:
            NARROW_TOP_OUTLINE[filename.replace(/\.svg$/i, "")] ?? null,
        },
      );

      const outputName = filename.replace(/\.svg$/i, ".png");
      await writeFile(
        path.join(outputDir, outputName),
        Buffer.from(pngBase64, "base64"),
      );

      const foregroundCorrections =
        FOREGROUND_CORRECTIONS[filename.replace(/\.svg$/i, "")];
      if (foregroundCorrections) {
        const foregroundBase64 = await page.evaluate(
          ({ size, foregroundCorrections }) => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = size;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Canvas is unavailable");
            // White matches the source drawing's interior. PawnImage applies
            // the same player-color filter to both source and correction.
            context.fillStyle = "white";
            for (const correction of foregroundCorrections) {
              context.beginPath();
              context.ellipse(
                correction.x,
                correction.y,
                correction.rx,
                correction.ry,
                0,
                0,
                Math.PI * 2,
              );
              context.fill();
            }
            return canvas.toDataURL("image/png").split(",")[1];
          },
          { size: SIZE, foregroundCorrections },
        );
        await writeFile(
          path.join(foregroundOutputDir, outputName),
          Buffer.from(foregroundBase64, "base64"),
        );
      }
    }
    console.log(`Generated ${files.length} ${type} backings`);
  }
} finally {
  await browser.close();
}
