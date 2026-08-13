import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dir, "../..");
const NEW_PACK_SOLIDITY_FLOOR = 0.95;
// Every omitted new-pack asset has an accepted baseline of exactly 1. The
// exceptions retain their measured value, so the audit catches per-asset
// degradation even when an asset remains above the pack-wide floor. This gate
// is deliberately not applied to Cat, Mouse or Home: their enclosed negative
// space is part of the art and can produce legitimate lower solidity.
const NEW_PACK_SOLIDITY_EXCEPTIONS: Readonly<Record<string, number>> = {
  "dog/dog-one-line-11.png": 0.9775163462239616,
  "dog/dog-one-line-15.png": 0.9990029661756276,
  "dog/dog-one-line-17.png": 0.9998507399036206,
  "dog/dog-one-line-23.png": 0.9925984763692819,
  "dog/dog-puppy-06.png": 0.9999741695510668,
  "dog/dog-puppy-09.png": 0.9941759004226152,
  "dog/dog-puppy-17.png": 0.9999761045664174,
  "dog/dog-puppy-24.png": 0.9982036275134728,
  "elephant/elephant-15.png": 0.9996337305947651,
  "elephant/elephant-20.png": 0.9995026030440693,
};
const [proofRoot] = process.argv.slice(2);
if (!proofRoot) {
  throw new Error("usage: bun audit-animal-pawn-backings.ts <proof-root>");
}

const dataUrl = async (filename: string, mime: string) =>
  `data:${mime};base64,${(await readFile(filename)).toString("base64")}`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  const measure = async (
    _foregroundFilename: string,
    backingFilename: string,
  ) =>
    page.evaluate(
      async ({ backingSrc }) => {
        const backing = new Image();
        backing.src = backingSrc;
        await backing.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 300;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("canvas unavailable");
        const drawContained = (image: HTMLImageElement) => {
          const scale = Math.min(
            300 / image.naturalWidth,
            300 / image.naturalHeight,
          );
          const width = image.naturalWidth * scale;
          const height = image.naturalHeight * scale;
          context.clearRect(0, 0, 300, 300);
          context.drawImage(
            image,
            (300 - width) / 2,
            (300 - height) / 2,
            width,
            height,
          );
          return context.getImageData(0, 0, 300, 300).data;
        };
        const backingPixels = drawContained(backing);
        let backingArea = 0;
        for (let index = 3; index < backingPixels.length; index += 4) {
          if (backingPixels[index] >= 24) backingArea++;
        }
        const outside = new Uint8Array(300 * 300);
        const queue = new Int32Array(300 * 300);
        let head = 0;
        let tail = 0;
        const enqueue = (index: number) => {
          if (outside[index] || backingPixels[index * 4 + 3] >= 24) return;
          outside[index] = 1;
          queue[tail++] = index;
        };
        for (let coordinate = 0; coordinate < 300; coordinate++) {
          enqueue(coordinate);
          enqueue(299 * 300 + coordinate);
          enqueue(coordinate * 300);
          enqueue(coordinate * 300 + 299);
        }
        while (head < tail) {
          const index = queue[head++];
          const x = index % 300;
          const y = Math.floor(index / 300);
          if (x > 0) enqueue(index - 1);
          if (x < 299) enqueue(index + 1);
          if (y > 0) enqueue(index - 300);
          if (y < 299) enqueue(index + 300);
        }
        let enclosedTransparent = 0;
        for (let index = 0; index < outside.length; index++) {
          if (!outside[index] && backingPixels[index * 4 + 3] < 24)
            enclosedTransparent++;
        }
        return {
          backingArea,
          enclosedTransparent,
          solidity: backingArea / (backingArea + enclosedTransparent),
        };
      },
      {
        backingSrc: await dataUrl(backingFilename, "image/png"),
      },
    );

  const results: Record<string, Awaited<ReturnType<typeof measure>>> = {};
  for (const type of ["dog", "cat", "mouse", "elephant", "home"] as const) {
    const backingDirectory = path.join(
      ROOT,
      "frontend/public/pawn-backings",
      type,
    );
    const foregroundDirectory = path.join(ROOT, "frontend/public/pawns", type);
    for (const name of (await readdir(backingDirectory))
      .filter((item) => item.endsWith(".png"))
      .sort()) {
      const stem = name.replace(/\.png$/, "");
      results[`${type}/${name}`] = await measure(
        path.join(foregroundDirectory, `${stem}.svg`),
        path.join(backingDirectory, name),
      );
    }
  }
  const sortedDistribution = Object.entries(results)
    .map(([name, result]) => ({ name, ...result }))
    .sort(
      (left, right) =>
        left.solidity - right.solidity || left.name.localeCompare(right.name),
    );
  const newPackResults = Object.entries(results).filter(([name]) =>
    /^(dog|elephant)\//.test(name),
  );
  if (newPackResults.length !== 74) {
    throw new Error(
      `Expected 74 approved new-pack backings, found ${newPackResults.length}`,
    );
  }
  const failures = newPackResults.flatMap(([name, result]) => {
    const baseline = NEW_PACK_SOLIDITY_EXCEPTIONS[name] ?? 1;
    const reasons = [];
    if (result.solidity < NEW_PACK_SOLIDITY_FLOOR) {
      reasons.push(`below ${NEW_PACK_SOLIDITY_FLOOR}`);
    }
    if (result.solidity + 1e-12 < baseline) {
      reasons.push(`below accepted per-asset baseline ${baseline}`);
    }
    return reasons.map((reason) => `${name}: ${result.solidity} ${reason}`);
  });
  await writeFile(
    path.join(proofRoot, "backing-coverage.json"),
    `${JSON.stringify({ metric: "opaque backing area / (opaque backing area + transparent pixels enclosed by backing own outer contour) at 300px", scope: "the 75 Dog and Elephant designs only; existing Cat, Mouse and Home art may contain intentional enclosed negative space", threshold: NEW_PACK_SOLIDITY_FLOOR, failures, sortedDistribution, results }, null, 2)}\n`,
  );
  if (failures.length > 0) {
    throw new Error(`Animal backing regression:\n${failures.join("\n")}`);
  }

  const puppyNames = [
    "dog-puppy-05",
    "dog-puppy-06",
    "dog-puppy-07",
    "dog-puppy-10",
    "dog-one-line-11",
    "dog-one-line-15",
    "dog-one-line-20",
    "dog-one-line-23",
  ];
  const cards = (
    await Promise.all(
      puppyNames.map(async (stem) => {
        const foreground = await dataUrl(
          path.join(ROOT, "frontend/public/pawns/dog", `${stem}.svg`),
          "image/svg+xml",
        );
        const backing = await dataUrl(
          path.join(ROOT, "frontend/public/pawn-backings/dog", `${stem}.png`),
          "image/png",
        );
        return `<article><h2>${stem}</h2><div class="row">
          <figure><div class="checker"><img src="${foreground}"></div><figcaption>300px foreground only</figcaption></figure>
          <figure><div class="checker"><img src="${backing}"></div><figcaption>300px backing only</figcaption></figure>
          <figure><div class="checker stack"><img src="${backing}"><img class="red" src="${foreground}"></div><figcaption>300px actual stack</figcaption></figure>
        </div></article>`;
      }),
    )
  ).join("");
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.setContent(`<!doctype html><style>
    *{box-sizing:border-box}body{margin:0;padding:24px;background:#111827;color:#f8fafc;font:15px system-ui}article{border:1px solid #475569;border-radius:12px;padding:12px;margin:14px 0}.row{display:flex;gap:24px}figure{margin:0;text-align:center}.checker{position:relative;width:300px;height:300px;background:repeating-conic-gradient(#334155 0 25%,#cbd5e1 0 50%) 50%/30px 30px}.checker img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.red{filter:invert(27%) sepia(51%) saturate(2878%) hue-rotate(346deg) brightness(104%) contrast(97%)}figcaption{margin-top:6px;font-weight:700}
  </style><h1>Puppy generator-resolution diagnostics</h1>${cards}`);
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete),
  );
  await page.screenshot({
    path: path.join(proofRoot, "animal-backing-diagnostics.png"),
    fullPage: true,
  });
} finally {
  await browser.close();
}
