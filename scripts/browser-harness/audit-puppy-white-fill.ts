import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dir, "../..");
const BASE_COMMIT = "5770c01e";
const SIZE = 300;
const TOLERANCE = 3;
const WHITE_FLOOR = 245;
const outputRoot = process.argv[2];
if (!outputRoot)
  throw new Error("usage: bun audit-puppy-white-fill.ts <output-directory>");
await mkdir(outputRoot, { recursive: true });

const filters = {
  red: "invert(27%) sepia(51%) saturate(2878%) hue-rotate(346deg) brightness(104%) contrast(97%)",
  blue: "invert(39%) sepia(57%) saturate(1815%) hue-rotate(195deg) brightness(96%) contrast(106%)",
} as const;
const dataUrl = (value: string | Buffer, mime: string) =>
  `data:${mime};base64,${Buffer.from(value).toString("base64")}`;
const readBase = (filename: string): string => {
  const result = Bun.spawnSync(
    ["git", "show", `${BASE_COMMIT}:frontend/public/pawns/dog/${filename}`],
    { cwd: ROOT },
  );
  if (result.exitCode !== 0)
    throw new Error(`Could not read ${filename} at ${BASE_COMMIT}`);
  return result.stdout.toString();
};
const pathTags = (svg: string) =>
  [...svg.matchAll(/<path\b[^>]*\/>/g)].map((match) => match[0]);
const replacePaths = (svg: string, replacement: (tag: string) => string) =>
  svg.replace(/<path\b[^>]*\/>/g, replacement);
const pathData = (tag: string): string | undefined =>
  /d="([^"]+)"/.exec(tag)?.[1];
const pathsWithMarker = (svg: string) =>
  new Set(
    pathTags(svg)
      .filter((tag) => tag.includes('data-pawn-backing-fill="white"'))
      .map(pathData),
  );

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  const results: Record<string, unknown> = {};
  const failures: string[] = [];

  for (let number = 1; number <= 25; number++) {
    const filename = `dog-puppy-${String(number).padStart(2, "0")}.svg`;
    const beforeSvg = readBase(filename);
    const afterSvg = await readFile(
      path.join(ROOT, "frontend/public/pawns/dog", filename),
      "utf8",
    );
    const backing = await readFile(
      path.join(
        ROOT,
        "frontend/public/pawn-backings/dog",
        filename.replace(".svg", ".png"),
      ),
    );
    const markedD = pathsWithMarker(afterSvg);
    const darkOnlySvg = replacePaths(afterSvg, (tag) =>
      markedD.has(pathData(tag))
        ? tag.replace(/fill="[^"]+"/, 'fill="none"')
        : tag,
    );
    const markedOnlySvg = replacePaths(afterSvg, (tag) =>
      markedD.has(pathData(tag))
        ? tag.replace('fill="none"', 'fill="rgb(255, 255, 255)"')
        : tag.replace(/fill="[^"]+"/, 'fill="none"'),
    );
    // Paint ownership in the original document order. White means a marked
    // path is topmost; black means an unmarked detail is topmost. This is
    // equivalent to exact-white BEFORE membership for Puppies 02..25 and also
    // covers Nil's approved tan/off-white classification for Puppy 01.
    const ownershipSvg = replacePaths(afterSvg, (tag) =>
      tag.replace(
        /fill="[^"]+"/,
        markedD.has(pathData(tag))
          ? 'fill="rgb(255, 255, 255)"'
          : 'fill="rgb(0, 0, 0)"',
      ),
    );

    const measurement = await page.evaluate(
      async ({
        beforeSrc,
        afterSrc,
        backingSrc,
        darkSrc,
        markedSrc,
        ownershipSrc,
        filters,
        size,
        tolerance,
        whiteFloor,
      }) => {
        const load = async (src: string) => {
          const image = new Image();
          image.src = src;
          await image.decode();
          return image;
        };
        const [before, after, backing, darkOnly, markedOnly, ownership] =
          await Promise.all([
            load(beforeSrc),
            load(afterSrc),
            load(backingSrc),
            load(darkSrc),
            load(markedSrc),
            load(ownershipSrc),
          ]);
        const pixels = (draw: (context: CanvasRenderingContext2D) => void) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = size;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new Error("canvas unavailable");
          draw(context);
          return context.getImageData(0, 0, size, size).data;
        };
        const darkRaw = pixels((context) =>
          context.drawImage(darkOnly, 0, 0, size, size),
        );
        const markedRaw = pixels((context) =>
          context.drawImage(markedOnly, 0, 0, size, size),
        );
        const ownershipRaw = pixels((context) =>
          context.drawImage(ownership, 0, 0, size, size),
        );
        const afterRaw = pixels((context) => {
          context.drawImage(backing, 0, 0, size, size);
          context.drawImage(after, 0, 0, size, size);
        });
        const total = size * size;
        const darkMask = new Uint8Array(total);
        const markedMask = new Uint8Array(total);
        const whiteTopMask = new Uint8Array(total);
        for (let index = 0; index < total; index++) {
          const offset = index * 4;
          darkMask[index] = darkRaw[offset + 3] > tolerance ? 1 : 0;
          markedMask[index] = markedRaw[offset + 3] > tolerance ? 1 : 0;
          whiteTopMask[index] =
            ownershipRaw[offset] === 255 &&
            ownershipRaw[offset + 1] === 255 &&
            ownershipRaw[offset + 2] === 255 &&
            ownershipRaw[offset + 3] > tolerance
              ? 1
              : 0;
        }
        const dilate = (mask: Uint8Array) => {
          const output = new Uint8Array(total);
          for (let index = 0; index < total; index++) {
            if (!mask[index]) continue;
            const x = index % size;
            const y = Math.floor(index / size);
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx >= 0 && nx < size && ny >= 0 && ny < size)
                  output[ny * size + nx] = 1;
              }
          }
          return output;
        };
        const dilatedMarked = dilate(markedMask);
        const darkEdgeBand = new Uint8Array(total);
        for (let index = 0; index < total; index++) {
          if (!darkMask[index]) continue;
          const x = index % size;
          const y = Math.floor(index / size);
          for (let dy = -1; dy <= 1 && !darkEdgeBand[index]; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (
                nx < 0 ||
                nx >= size ||
                ny < 0 ||
                ny >= size ||
                !darkMask[ny * size + nx]
              ) {
                darkEdgeBand[index] = 1;
                break;
              }
            }
        }
        let revealedRaw = 0,
          revealedOutsideBand = 0,
          markedOutsideDarkNotWhite = 0;
        for (let index = 0; index < total; index++) {
          const offset = index * 4;
          if (darkMask[index] && whiteTopMask[index]) {
            revealedRaw++;
            if (!darkEdgeBand[index]) revealedOutsideBand++;
          }
          if (markedMask[index] && !darkMask[index]) {
            const white =
              afterRaw[offset] >= whiteFloor &&
              afterRaw[offset + 1] >= whiteFloor &&
              afterRaw[offset + 2] >= whiteFloor;
            const transparent = afterRaw[offset + 3] <= tolerance;
            if (!white && !transparent) markedOutsideDarkNotWhite++;
          }
        }
        const filtered: Record<
          string,
          {
            materiallyChanged: number;
            changedToWhiteOrTransparent: number;
            preservedDetail: number;
            outsideDilatedMarked: number;
          }
        > = {};
        for (const [color, filter] of Object.entries(filters)) {
          const render = (foreground: HTMLImageElement) =>
            pixels((context) => {
              context.drawImage(backing, 0, 0, size, size);
              context.filter = filter;
              context.drawImage(foreground, 0, 0, size, size);
            });
          const oldPixels = render(before);
          const newPixels = render(after);
          let materiallyChanged = 0,
            changedToWhiteOrTransparent = 0,
            preservedDetail = 0,
            outsideDilatedMarked = 0;
          for (let index = 0; index < total; index++) {
            const offset = index * 4;
            const delta = Math.max(
              ...[0, 1, 2, 3].map((channel) =>
                Math.abs(
                  oldPixels[offset + channel] - newPixels[offset + channel],
                ),
              ),
            );
            if (delta <= tolerance) continue;
            materiallyChanged++;
            if (!dilatedMarked[index]) outsideDilatedMarked++;
            else if (darkMask[index]) preservedDetail++;
            else {
              const white =
                newPixels[offset] >= whiteFloor &&
                newPixels[offset + 1] >= whiteFloor &&
                newPixels[offset + 2] >= whiteFloor;
              const transparent = newPixels[offset + 3] <= tolerance;
              if (white || transparent) changedToWhiteOrTransparent++;
            }
          }
          filtered[color] = {
            materiallyChanged,
            changedToWhiteOrTransparent,
            preservedDetail,
            outsideDilatedMarked,
          };
        }
        return {
          geometry: {
            darkMaskPixels: darkMask.reduce((sum, value) => sum + value, 0),
            markedMaskPixels: markedMask.reduce((sum, value) => sum + value, 0),
            whiteTopMaskPixels: whiteTopMask.reduce(
              (sum, value) => sum + value,
              0,
            ),
            revealedRaw,
            revealedOutsideBand,
            markedOutsideDarkNotWhite,
          },
          filtered,
        };
      },
      {
        beforeSrc: dataUrl(beforeSvg, "image/svg+xml"),
        afterSrc: dataUrl(afterSvg, "image/svg+xml"),
        backingSrc: dataUrl(backing, "image/png"),
        darkSrc: dataUrl(darkOnlySvg, "image/svg+xml"),
        markedSrc: dataUrl(markedOnlySvg, "image/svg+xml"),
        filters,
        size: SIZE,
        ownershipSrc: dataUrl(ownershipSvg, "image/svg+xml"),
        tolerance: TOLERANCE,
        whiteFloor: WHITE_FLOOR,
      },
    );
    results[filename] = measurement;
    if (measurement.geometry.revealedOutsideBand !== 0)
      failures.push(
        `${filename}: ${measurement.geometry.revealedOutsideBand} revealed pixels outside D edge band`,
      );
    if (measurement.geometry.markedOutsideDarkNotWhite !== 0)
      failures.push(
        `${filename}: ${measurement.geometry.markedOutsideDarkNotWhite} marked/outside-D pixels not white or transparent`,
      );
    for (const [color, counts] of Object.entries(measurement.filtered)) {
      if (counts.changedToWhiteOrTransparent === 0)
        failures.push(
          `${filename}/${color}: zero intended changed-to-white pixels`,
        );
      if (counts.outsideDilatedMarked !== 0)
        failures.push(
          `${filename}/${color}: ${counts.outsideDilatedMarked} changes outside dilated marked mask`,
        );
    }
  }
  const report = {
    baseCommit: BASE_COMMIT,
    canvas: `${SIZE}x${SIZE}`,
    vendorWhite: "exactly rgb(255,255,255)",
    materialChange: `max RGBA channel delta > ${TOLERANCE}`,
    masks:
      "unfiltered renders; D=unmarked-path alpha, Wmask=topmost marked-path ownership painted exact white in original document order, REVEALED=D AND Wmask",
    darkMaskMembership: `unmarked-path alpha > ${TOLERANCE}`,
    edgeRule: "one-pixel 8-neighbour band along D edge",
    afterRule: `inside marked mask and outside D: RGB >= ${WHITE_FLOOR} or alpha <= ${TOLERANCE}`,
    displaySizeProof:
      "This 300x300 differential is a geometry/pixel gate. Exact 30px and 40px behavior is covered by the separate exhaustive visual matrix.",
    failures,
    results,
  };
  await writeFile(
    path.join(outputRoot, "puppy-white-fill-differential.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(
    "All 25 Puppies passed geometric and filtered differential gates",
  );
} finally {
  await browser.close();
}
