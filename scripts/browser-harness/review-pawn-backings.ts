import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dir, "../..");
const OUTPUT = path.join(ROOT, "tmp/home-backing-aspect-review.png");
const pawns = {
  home: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
} as const;
const backgrounds = ["#d7c4a3", "#8e704d"];

await mkdir(path.dirname(OUTPUT), { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1540, height: 5000 },
  });
  const cards = (
    await Promise.all(
      Object.entries(pawns).flatMap(([type, ids]) =>
        ids.map(async (id) => {
          const stem = `${type}${id}`;
          const source = `data:image/svg+xml;base64,${(await readFile(path.join(ROOT, `frontend/public/pawns/${type}/${stem}.svg`))).toString("base64")}`;
          const relativeBacking = `frontend/public/pawn-backings/${type}/${stem}.png`;
          const backing = `data:image/png;base64,${(await readFile(path.join(ROOT, relativeBacking))).toString("base64")}`;
          const before = `data:image/png;base64,${execFileSync("git", ["show", `018601ac:${relativeBacking}`], { cwd: ROOT }).toString("base64")}`;
          const pair = (bg: string) => `<section style="--board:${bg}">
            <figure><div class="piece"><img class="backing" src="${before}"><img class="pawn" src="${source}"></div><figcaption>BEFORE · ${bg}</figcaption></figure>
            <figure><div class="piece"><img class="backing" src="${backing}"><img class="pawn" src="${source}"></div><figcaption>CORRECTED · ${bg}</figcaption></figure>
          </section>`;
          return `<article><h2>${type} ${id}</h2><div class="pairs">${backgrounds.map(pair).join("")}</div></article>`;
        }),
      ),
    )
  ).join("");
  await page.setContent(`<!doctype html><style>
    *{box-sizing:border-box}body{margin:16px;background:#222;color:#fff;font:16px Arial,sans-serif}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}article{padding:12px;background:#333;border:1px solid #666}h2{margin:0 0 8px;font-size:22px}.pairs{display:grid;gap:8px}section{display:grid;grid-template-columns:1fr 1fr;gap:8px}figure{margin:0}.piece{position:relative;width:100%;aspect-ratio:1;background:var(--board)}img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.pawn{filter:brightness(0) saturate(100%) invert(17%) sepia(98%) saturate(6940%) hue-rotate(359deg) brightness(95%) contrast(121%)}figcaption{padding:4px;background:#111;font-size:12px;text-align:center}
  </style><main class="grid">${cards}</main>`);
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete),
  );
  await page.screenshot({ path: OUTPUT, fullPage: true });
  console.log(OUTPUT);
} finally {
  await browser.close();
}
