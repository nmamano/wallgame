import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";

const [sourceRoot, outputRoot] = process.argv.slice(2);
if (!sourceRoot || !outputRoot) {
  throw new Error(
    "usage: bun process-animal-pawns.ts <extracted-root> <output-root>",
  );
}

const SIZE = 1200;
const PADDING_RATIO = 0.08;
const SAFE_ELEMENTS = new Set(["svg", "g", "path"]);
const SAFE_ATTRIBUTES = new Set([
  "d",
  "transform",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "fill-rule",
  "clip-rule",
  "opacity",
]);

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const numeric = (name: string) => Number(/\d+/.exec(name)?.[0]);
const asDataUrl = (content: string | Uint8Array, mime = "image/svg+xml") =>
  `data:${mime};base64,${Buffer.from(content).toString("base64")}`;

const renderedBounds = async (page: Page, svg: string): Promise<Bounds> =>
  page.evaluate(
    async ({ src, size }) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("canvas unavailable");
      const scale = Math.min(
        size / image.naturalWidth,
        size / image.naturalHeight,
      );
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      const offsetX = (size - width) / 2;
      const offsetY = (size - height) / 2;
      context.drawImage(image, offsetX, offsetY, width, height);
      const pixels = context.getImageData(0, 0, size, size).data;
      let minX = size;
      let minY = size;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (pixels[(y * size + x) * 4 + 3] < 16) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      if (maxX < minX || maxY < minY) throw new Error("empty rendered SVG");
      return {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      };
    },
    { src: asDataUrl(svg), size: SIZE },
  );

const squareViewBox = (
  rendered: Bounds,
  sourceViewBox: [number, number, number, number],
): [number, number, number, number] => {
  const [vx, vy, vw, vh] = sourceViewBox;
  const imageScale = Math.min(SIZE / vw, SIZE / vh);
  const offsetX = (SIZE - vw * imageScale) / 2;
  const offsetY = (SIZE - vh * imageScale) / 2;
  const x = vx + (rendered.x - offsetX) / imageScale;
  const y = vy + (rendered.y - offsetY) / imageScale;
  const width = rendered.width / imageScale;
  const height = rendered.height / imageScale;
  const side = Math.max(width, height) * (1 + PADDING_RATIO * 2);
  return [x + width / 2 - side / 2, y + height / 2 - side / 2, side, side];
};

const format = (value: number) => Number(value.toFixed(4)).toString();

const sanitize = async (
  page: Page,
  source: string,
  childIndex?: number,
): Promise<{ svg: string; originalViewBox: string }> =>
  page.evaluate(
    ({ source, childIndex, safeElements, safeAttributes }) => {
      const parser = new DOMParser();
      const parsed = parser.parseFromString(source, "image/svg+xml");
      if (parsed.querySelector("parsererror"))
        throw new Error("invalid SVG XML");
      const root = parsed.documentElement;
      const originalViewBox = root.getAttribute("viewBox");
      if (!originalViewBox) throw new Error("missing viewBox");
      const selected =
        childIndex === undefined
          ? [...root.children].filter((element) =>
              safeElements.includes(element.localName),
            )
          : [
              [...root.children].filter((element) => element.localName === "g")[
                childIndex
              ],
            ];
      if (selected.some((element) => !element))
        throw new Error("missing selected group");

      // Resolve Puppy CSS before removing its shared style block. This is harmless for
      // the potrace packs, whose paths inherit one group-level black fill.
      document.body.append(document.importNode(root, true));
      const renderedRoot = document.body.lastElementChild;
      if (!renderedRoot)
        throw new Error("cannot attach SVG for style resolution");
      const renderedPaths = [...renderedRoot.querySelectorAll("path")];
      const sourcePaths = [...root.querySelectorAll("path")];
      if (renderedPaths.length !== sourcePaths.length) {
        throw new Error("style-resolution path count changed");
      }
      for (const [index, path] of sourcePaths.entries()) {
        path.setAttribute(
          "fill",
          getComputedStyle(renderedPaths[index]).fill || "#000000",
        );
      }
      renderedRoot.remove();

      const output = parsed.implementation.createDocument(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      const outputRoot = output.documentElement;
      outputRoot.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      outputRoot.setAttribute("viewBox", originalViewBox);

      const copy = (element: Element): Element => {
        const name = element.localName;
        if (!safeElements.includes(name))
          throw new Error(`unsafe element ${name}`);
        const clone = output.createElementNS(
          "http://www.w3.org/2000/svg",
          name,
        );
        for (const attribute of [...element.attributes]) {
          if (safeAttributes.includes(attribute.name)) {
            clone.setAttribute(attribute.name, attribute.value);
          }
        }
        for (const child of [...element.children]) clone.append(copy(child));
        return clone;
      };
      for (const element of selected) outputRoot.append(copy(element));
      return {
        svg: new XMLSerializer().serializeToString(outputRoot),
        originalViewBox,
      };
    },
    {
      source,
      childIndex,
      safeElements: [...SAFE_ELEMENTS],
      safeAttributes: [...SAFE_ATTRIBUTES],
    },
  );

const normalizeSvg = async (
  page: Page,
  source: string,
  childIndex?: number,
) => {
  const sanitized = await sanitize(page, source, childIndex);
  const viewBox = sanitized.originalViewBox.split(/\s+/).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  if (
    viewBox.length !== 4 ||
    viewBox.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(`invalid viewBox: ${sanitized.originalViewBox}`);
  }
  const bounds = await renderedBounds(page, sanitized.svg);
  const square = squareViewBox(bounds, viewBox);
  return sanitized.svg.replace(
    /viewBox="[^"]+"/,
    `viewBox="${square.map(format).join(" ")}"`,
  );
};

const maskForImage = async (page: Page, src: string): Promise<number[]> =>
  page.evaluate(async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const source = document.createElement("canvas");
    source.width = image.naturalWidth;
    source.height = image.naturalHeight;
    const sourceContext = source.getContext("2d", { willReadFrequently: true });
    if (!sourceContext) throw new Error("canvas unavailable");
    sourceContext.drawImage(image, 0, 0);
    const data = sourceContext.getImageData(
      0,
      0,
      source.width,
      source.height,
    ).data;
    let minX = source.width;
    let minY = source.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        const index = (y * source.width + x) * 4;
        const alpha = data[index + 3];
        const darkness =
          255 - (data[index] + data[index + 1] + data[index + 2]) / 3;
        if (alpha < 24 || darkness < 24) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (maxX < minX) throw new Error("empty comparison image");
    const target = document.createElement("canvas");
    target.width = target.height = 128;
    const context = target.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("canvas unavailable");
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const scale = 112 / Math.max(width, height);
    context.drawImage(
      source,
      minX,
      minY,
      width,
      height,
      64 - (width * scale) / 2,
      64 - (height * scale) / 2,
      width * scale,
      height * scale,
    );
    const normalized = context.getImageData(0, 0, 128, 128).data;
    const mask: number[] = [];
    for (let index = 0; index < normalized.length; index += 4) {
      const alpha = normalized[index + 3];
      const darkness =
        255 -
        (normalized[index] + normalized[index + 1] + normalized[index + 2]) / 3;
      mask.push(alpha >= 24 && darkness >= 24 ? 1 : 0);
    }
    return mask;
  }, src);

const iou = (left: number[], right: number[]) => {
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < left.length; index++) {
    if (left[index] || right[index]) union++;
    if (left[index] && right[index]) intersection++;
  }
  return intersection / union;
};

await mkdir(outputRoot, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();

try {
  for (const [pack, inputDirectory, prefix] of [
    ["elephant", path.join(sourceRoot, "elephant", "SVG"), "elephant"],
    ["dog-line", path.join(sourceRoot, "dog-line"), "dog-one-line"],
  ] as const) {
    const files = (await readdir(inputDirectory))
      .filter((name) => /^Image-_\d+_\.svg$/.test(name))
      .sort((left, right) => numeric(left) - numeric(right));
    if (files.length !== 25) throw new Error(`${pack}: expected 25 inputs`);
    const directory = path.join(
      outputRoot,
      prefix === "elephant" ? "elephant" : "dog",
    );
    await mkdir(directory, { recursive: true });
    for (const [index, filename] of files.entries()) {
      const source = await readFile(
        path.join(inputDirectory, filename),
        "utf8",
      );
      const normalized = await normalizeSvg(page, source);
      await writeFile(
        path.join(
          directory,
          `${prefix}-${String(index + 1).padStart(2, "0")}.svg`,
        ),
        normalized,
      );
    }
  }

  const puppyRoot = path.join(sourceRoot, "puppy", "Dog_Puppy_Svg");
  const puppySource = await readFile(
    path.join(puppyRoot, "Dog_puppy_svg.svg"),
    "utf8",
  );
  const candidateSvgs: string[] = [];
  const candidateMasks: number[][] = [];
  for (let index = 0; index < 25; index++) {
    const svg = await normalizeSvg(page, puppySource, index);
    candidateSvgs.push(svg);
    candidateMasks.push(await maskForImage(page, asDataUrl(svg)));
  }
  const previewMasks: number[][] = [];
  for (let asset = 1; asset <= 25; asset++) {
    const png = await readFile(
      path.join(puppyRoot, "500ppi", `Asset ${asset}.png`),
    );
    previewMasks.push(await maskForImage(page, asDataUrl(png, "image/png")));
  }

  const scores = candidateMasks.map((candidate) =>
    previewMasks.map((preview) => iou(candidate, preview)),
  );
  const groupMatches = scores.map((row, groupIndex) => {
    const ranked = row
      .map((score, assetIndex) => ({ asset: assetIndex + 1, score }))
      .sort((left, right) => right.score - left.score);
    return {
      group: groupIndex + 1,
      asset: ranked[0].asset,
      score: ranked[0].score,
      second: ranked[1].score,
      margin: ranked[0].score - ranked[1].score,
    };
  });
  if (new Set(groupMatches.map((match) => match.asset)).size !== 25) {
    throw new Error(
      `Puppy comparison is not a bijection: ${JSON.stringify(groupMatches)}`,
    );
  }
  if (groupMatches.some((match) => match.margin <= 0.02)) {
    throw new Error(
      `Puppy comparison margin is ambiguous: ${JSON.stringify(groupMatches)}`,
    );
  }

  const dogDirectory = path.join(outputRoot, "dog");
  for (const match of groupMatches) {
    await writeFile(
      path.join(
        dogDirectory,
        `dog-puppy-${String(match.asset).padStart(2, "0")}.svg`,
      ),
      candidateSvgs[match.group - 1],
    );
  }
  await writeFile(
    path.join(outputRoot, "puppy-mapping.json"),
    `${JSON.stringify(groupMatches, null, 2)}\n`,
  );
} finally {
  await browser.close();
}
