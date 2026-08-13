import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dir, "../..");
const output = process.argv[2];
if (!output)
  throw new Error(
    "usage: bun render-puppy-visual-matrix.ts <output-directory>",
  );
await mkdir(output, { recursive: true });

const filters = {
  red: "invert(27%) sepia(51%) saturate(2878%) hue-rotate(346deg) brightness(104%) contrast(97%)",
  blue: "invert(39%) sepia(57%) saturate(1815%) hue-rotate(195deg) brightness(96%) contrast(106%)",
};
const themes = {
  light: {
    // Exact default-board classes resolved over a white page. The former
    // evidence labels were inverted: amber-300/45 is the visually darker cell.
    darker: "rgb(254, 235, 175)",
    lighter: "rgb(254, 242, 196)",
  },
  dark: {
    // Browser canvas resolution of shipped CSS: --muted oklch(0.3 0.05 270),
    // and that same color at 50% over --card oklch(0.2 0.05 270).
    muted: "rgb(36, 44, 71)",
    muted50OverCard: "rgb(24, 32, 58)",
  },
} as const;
const dataUrl = (value: string | Buffer, mime: string) =>
  `data:${mime};base64,${Buffer.from(value).toString("base64")}`;

const assets = await Promise.all(
  Array.from({ length: 25 }, async (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return {
      number,
      foreground: dataUrl(
        await readFile(
          path.join(ROOT, `frontend/public/pawns/dog/dog-puppy-${number}.svg`),
        ),
        "image/svg+xml",
      ),
      backing: dataUrl(
        await readFile(
          path.join(
            ROOT,
            `frontend/public/pawn-backings/dog/dog-puppy-${number}.png`,
          ),
        ),
        "image/png",
      ),
    };
  }),
);

const cells = (asset: (typeof assets)[number], theme: keyof typeof themes) =>
  ([30, 40] as const)
    .flatMap((size) =>
      Object.entries(themes[theme]).flatMap(([square, background]) =>
        Object.entries(filters).map(
          ([color, filter]) => `<figure>
          <div class="tile" style="width:${size}px;height:${size}px;background:${background}">
            <img src="${asset.backing}" alt="" aria-hidden="true">
            <img src="${asset.foreground}" alt="Puppy ${asset.number}, ${theme} theme, ${size}px, ${square} square, ${color}" style="filter:${filter}">
          </div>
          <figcaption>${size}px · ${square} · ${color}</figcaption>
        </figure>`,
        ),
      ),
    )
    .join("");

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1180, height: 900 },
  });
  await page.setContent(`<!doctype html><style>
    *{box-sizing:border-box}body{margin:0;padding:22px;background:#0f172a;color:#f8fafc;font:13px system-ui}
    h1{margin:0 0 5px}.note{color:#cbd5e1;margin:0 0 18px}.asset{border:1px solid #475569;border-radius:9px;padding:10px;margin:10px 0;break-inside:avoid}
    h2{font-size:15px;margin:0 0 8px}.pending{color:#fbbf24}.row{display:grid;grid-template-columns:repeat(8,1fr);gap:8px}
    figure{margin:0;text-align:center}.tile{position:relative;margin:auto}.tile img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
    figcaption{margin-top:4px;font-size:10px;color:#e2e8f0;white-space:nowrap}
  </style><h1>All 25 Puppies - exact display-size matrix</h1>
  <p class="note">Every asset at exact 30px and 40px, default-board light/dark squares, production red/blue filters. Puppy 01 uses Nil’s approved Option B.</p>
  ${Object.keys(themes)
    .map(
      (theme) =>
        `<h1>${theme === "light" ? "LIGHT THEME - 200 tiles" : "DEFAULT DARK THEME - 200 tiles"}</h1>${assets.map((asset) => `<section class="asset"><h2>Puppy ${asset.number}${asset.number === "01" ? " - NIL OPTION B" : ""}</h2><div class="row">${cells(asset, theme as keyof typeof themes)}</div></section>`).join("")}`,
    )
    .join("")}`);
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete),
  );
  const failures = await page
    .locator("img")
    .evaluateAll(
      (images) =>
        images.filter(
          (image) =>
            !(image as HTMLImageElement).complete ||
            (image as HTMLImageElement).naturalWidth === 0,
        ).length,
    );
  if (failures) throw new Error(`${failures} matrix images failed to load`);
  await page.screenshot({
    path: path.join(output, "puppy-25-exhaustive-30-40.png"),
    fullPage: true,
  });
  await writeFile(
    path.join(output, "puppy-25-exhaustive-30-40.json"),
    `${JSON.stringify({ assets: 25, sizes: [30, 40], themes, darkResolutionMethod: "Chromium canvas: bg-muted from --muted oklch(0.3 0.05 270); bg-muted/50 composited at alpha 0.5 over --card oklch(0.2 0.05 270). Board container is rgb(13,20,44) from dark:bg-card.", colors: Object.keys(filters), tilesPerTheme: 200, renderedTiles: 400, puppy01: "Nil-approved Option B", crispTheme: "No extra coverage: changes wall joints, not square colors.", failedImages: failures }, null, 2)}\n`,
  );
} finally {
  await browser.close();
}
