import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dir, "../..");
const OUTPUT = path.join(ROOT, "tmp/pawn-foreground-fix-review.png");
await mkdir(path.dirname(OUTPUT), { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 600 },
    deviceScaleFactor: 2,
  });
  const cards = await Promise.all(
    [9, 73].map(async (id) => {
      const source = `data:image/svg+xml;base64,${(
        await readFile(
          path.join(ROOT, `frontend/public/pawns/cat/cat${id}.svg`),
        )
      ).toString("base64")}`;
      const correction = `data:image/png;base64,${(
        await readFile(
          path.join(
            ROOT,
            `frontend/public/pawn-foreground-fixes/cat/cat${id}.png`,
          ),
        )
      ).toString("base64")}`;
      return `<article><h2>Cat ${id}</h2><div><figure><img src="${source}"><figcaption>before</figcaption></figure><figure class="stack"><img src="${source}"><img src="${correction}"><figcaption>corrected</figcaption></figure></div></article>`;
    }),
  );
  await page.setContent(`<!doctype html><style>
    *{box-sizing:border-box}body{margin:20px;background:#ddd;font-family:sans-serif;display:flex;gap:20px}article{width:460px;background:white;padding:12px}article>div{display:flex;gap:12px}figure{position:relative;margin:0;width:212px;text-align:center;overflow:hidden}img{display:block;width:100%;transform:scale(2.4);transform-origin:50% 52%}.stack img+img{position:absolute;inset:0}figcaption{position:relative;margin-top:65px;background:white;font-weight:bold}
  </style>${cards.join("")}`);
  await page.waitForFunction(() =>
    [...document.images].every((i) => i.complete),
  );
  await page.screenshot({ path: OUTPUT });
  console.log(OUTPUT);
} finally {
  await browser.close();
}
