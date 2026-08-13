import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dir, "../..");
const OUTPUT = path.join(ROOT, "tmp/pawn-backing-review.png");
const pawns = {
  cat: [
    9, 31, 47, 52, 54, 58, 73, 75, 84, 94, 105, 111, 126, 150, 168, 174, 179,
    181, 188, 237, 245,
  ],
  mouse: [4, 18, 26, 33, 68, 74],
  home: [5, 8, 9],
} as const;

await mkdir(path.dirname(OUTPUT), { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 5000 },
    deviceScaleFactor: 1,
  });
  const cards = (
    await Promise.all(
      Object.entries(pawns).flatMap(([type, ids]) =>
        ids.map(async (id) => {
          const stem = `${type}${id}`;
          const source = `data:image/svg+xml;base64,${(await readFile(path.join(ROOT, `frontend/public/pawns/${type}/${stem}.svg`))).toString("base64")}`;
          const backing = `data:image/png;base64,${(await readFile(path.join(ROOT, `frontend/public/pawn-backings/${type}/${stem}.png`))).toString("base64")}`;
          const relativeBacking = `frontend/public/pawn-backings/${type}/${stem}.png`;
          const before = `data:image/png;base64,${execFileSync("git", ["show", `dd25e8df:${relativeBacking}`], { cwd: ROOT }).toString("base64")}`;
          return `<article><b>${type} ${id}</b><div><figure><img src="${source}"><figcaption>source</figcaption></figure><figure class="checker"><img src="${before}"><figcaption>before</figcaption></figure><figure class="checker"><img src="${backing}"><figcaption>corrected</figcaption></figure><figure class="checker stack"><img src="${backing}"><img src="${source}"><figcaption>combined</figcaption></figure></div></article>`;
        }),
      ),
    )
  ).join("");
  await page.setContent(`<!doctype html><style>
    *{box-sizing:border-box}body{margin:12px;font:16px sans-serif;background:#ddd}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}article{background:white;padding:8px;border:1px solid #777}article>div{display:flex;gap:4px}figure{position:relative;margin:0;flex:1;text-align:center}img{display:block;width:100%;aspect-ratio:1;object-fit:contain}.checker{background:repeating-conic-gradient(#bbb 0 25%,#eee 0 50%) 50%/16px 16px}.stack img+img{position:absolute;inset:0}figcaption{position:relative;background:#fff9;font-size:11px}
  </style><main class="grid">${cards}</main>`);
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete),
  );
  const suspectRegions = await page.evaluate(() =>
    [...document.querySelectorAll("article")].map((article) => {
      const images = article.querySelectorAll("img");
      const pixels = [images[1], images[2]].map((image) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 300;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        context.drawImage(image, 0, 0, 300, 300);
        return context.getImageData(0, 0, 300, 300).data;
      });
      const points: [number, number][] = [];
      for (let y = 0; y < 300; y++)
        for (let x = 0; x < 300; x++) {
          const offset = (y * 300 + x) * 4 + 3;
          if (pixels[0][offset] !== pixels[1][offset]) points.push([x, y]);
        }
      if (!points.length) {
        const baseline = pixels[0];
        const seen = new Uint8Array(90000);
        const components: string[] = [];
        for (let start = 0; start < 90000; start++) {
          if (seen[start] || baseline[start * 4 + 3] >= 64) continue;
          const queue = [start];
          seen[start] = 1;
          const region: number[] = [];
          let boundary = false;
          while (queue.length) {
            const index = queue.pop()!;
            region.push(index);
            const x = index % 300,
              y = Math.floor(index / 300);
            if (x === 0 || y === 0 || x === 299 || y === 299) boundary = true;
            for (const next of [
              x ? index - 1 : -1,
              x < 299 ? index + 1 : -1,
              y ? index - 300 : -1,
              y < 299 ? index + 300 : -1,
            ]) {
              if (next >= 0 && !seen[next] && baseline[next * 4 + 3] < 64) {
                seen[next] = 1;
                queue.push(next);
              }
            }
          }
          if (!boundary && region.length >= 3)
            components.push(
              `${region.length}@${Math.min(...region.map((i) => i % 300))},${Math.min(...region.map((i) => Math.floor(i / 300)))}-${Math.max(...region.map((i) => i % 300))},${Math.max(...region.map((i) => Math.floor(i / 300)))}`,
            );
        }
        return `${article.querySelector("b")!.textContent}: unchanged, enclosed ${components.join(" ") || "none"}`;
      }
      return `${article.querySelector("b")!.textContent}: ${points.length}px ${Math.min(...points.map((p) => p[0]))},${Math.min(...points.map((p) => p[1]))}-${Math.max(...points.map((p) => p[0]))},${Math.max(...points.map((p) => p[1]))}`;
    }),
  );
  console.log(suspectRegions.join("\n"));
  await page.screenshot({ path: OUTPUT, fullPage: true });
  console.log(OUTPUT);
} finally {
  await browser.close();
}
