import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dir, "../..");
const PROOF_ROOT = process.argv[2];
if (!PROOF_ROOT)
  throw new Error("usage: bun review-animal-pawns.ts <proof-root>");

const output = path.join(PROOF_ROOT, "visual-proof");
await Bun.$`mkdir -p ${output}`;

const dataUrl = async (filename: string, mime: string) =>
  `data:${mime};base64,${(await readFile(filename)).toString("base64")}`;

const piece = (
  foreground: string,
  backing: string | null,
  color: "red" | "blue",
  size: 30 | 40,
) => {
  const filter =
    color === "red"
      ? "invert(27%) sepia(51%) saturate(2878%) hue-rotate(346deg) brightness(104%) contrast(97%)"
      : "invert(39%) sepia(57%) saturate(1815%) hue-rotate(195deg) brightness(96%) contrast(106%)";
  return `<span class="piece" style="width:${size}px;height:${size}px">${
    backing ? `<img src="${backing}" alt="">` : ""
  }<img src="${foreground}" alt="" style="filter:${filter}"></span>`;
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const dogNames = (await readdir(path.join(ROOT, "frontend/public/pawns/dog")))
    .filter((name) => name.endsWith(".svg"))
    .sort((left, right) => {
      const pack = (name: string) => (name.startsWith("dog-one-line-") ? 0 : 1);
      return (
        pack(left) - pack(right) ||
        left.localeCompare(right, undefined, { numeric: true })
      );
    });
  const elephantNames = (
    await readdir(path.join(ROOT, "frontend/public/pawns/elephant"))
  )
    .filter((name) => name.endsWith(".svg"))
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    );

  const entries = [
    {
      label: "CURRENT TEMPORARY DOG DEFAULT · unbacked · rejected silhouette",
      foreground: await dataUrl(
        path.join(ROOT, "frontend/public/pawns/animal-cycle/dog.svg"),
        "image/svg+xml",
      ),
      backing: null,
      temporary: true,
    },
    ...(await Promise.all(
      dogNames.map(async (name) => ({
        label: name.startsWith("dog-one-line-")
          ? `Dog · One Line ${/\d+/.exec(name)?.[0]}`
          : `Dog · Puppy ${/\d+/.exec(name)?.[0]}`,
        foreground: await dataUrl(
          path.join(ROOT, "frontend/public/pawns/dog", name),
          "image/svg+xml",
        ),
        backing: await dataUrl(
          path.join(
            ROOT,
            "frontend/public/pawn-backings/dog",
            name.replace(".svg", ".png"),
          ),
          "image/png",
        ),
        temporary: false,
      })),
    )),
    {
      label:
        "CURRENT TEMPORARY ELEPHANT DEFAULT · unbacked · rejected silhouette",
      foreground: await dataUrl(
        path.join(ROOT, "frontend/public/pawns/animal-cycle/elephant.svg"),
        "image/svg+xml",
      ),
      backing: null,
      temporary: true,
    },
    ...(await Promise.all(
      elephantNames.map(async (name) => ({
        label: `Elephant ${/\d+/.exec(name)?.[0]}`,
        foreground: await dataUrl(
          path.join(ROOT, "frontend/public/pawns/elephant", name),
          "image/svg+xml",
        ),
        backing: await dataUrl(
          path.join(
            ROOT,
            "frontend/public/pawn-backings/elephant",
            name.replace(".svg", ".png"),
          ),
          "image/png",
        ),
        temporary: false,
      })),
    )),
  ];

  const cards = entries
    .map(
      (entry) => `<article class="card${entry.temporary ? " temporary" : ""}">
        <div class="label">${entry.label}</div>
        <div class="samples">
          <span class="cell light">${piece(entry.foreground, entry.backing, "red", 30)}</span>
          <span class="cell dark">${piece(entry.foreground, entry.backing, "blue", 30)}</span>
          <span class="cell light">${piece(entry.foreground, entry.backing, "red", 40)}</span>
          <span class="cell dark">${piece(entry.foreground, entry.backing, "blue", 40)}</span>
        </div>
        <div class="legend">30px red · 30px blue · 40px red · 40px blue</div>
      </article>`,
    )
    .join("");

  const page = await browser.newPage({
    viewport: { width: 1600, height: 1200 },
    deviceScaleFactor: 1,
  });
  await page.setContent(`<!doctype html><style>
    *{box-sizing:border-box} body{margin:0;padding:28px;background:#111827;color:#f9fafb;font:14px system-ui}
    h1{font-size:24px;margin:0 0 6px}.sub{color:#cbd5e1;margin-bottom:22px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
    .card{background:#1f2937;border:1px solid #475569;border-radius:10px;padding:10px}.temporary{border:3px solid #f59e0b;background:#422006}
    .label{font-weight:700;height:38px}.samples{display:flex;align-items:center;gap:8px}.cell{width:58px;height:58px;display:grid;place-items:center;border:1px solid #64748b}
    /* Exact composited colors from the current board's amber utility classes. */
    .light{background:#fde3a0}.dark{background:#374151}.piece{position:relative;display:block}.piece img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
    .legend{font-size:10px;color:#94a3b8;margin-top:6px}
  </style><h1>Animal pawn full-pack contact sheet</h1>
  <div class="sub">Shipped grouped order: Dog One Line 01-25, Puppy 01-25, Elephant 01-25. Current defaults are temporary, rejected, and unbacked. Purchased options use the generated white backing plus team-color foreground.</div>
  <main class="grid">${cards}</main>`);
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete),
  );
  const failures = await page.evaluate(() =>
    [...document.images]
      .filter((image) => image.naturalWidth === 0)
      .map((image) => image.src.slice(0, 80)),
  );
  if (failures.length)
    throw new Error(`failed contact images: ${JSON.stringify(failures)}`);
  await page.screenshot({
    path: path.join(output, "all-75-contact-sheet.png"),
    fullPage: true,
  });

  const samples = [
    {
      label: "Elephant 01 · Y-flip and pt/viewBox check",
      before: path.join(PROOF_ROOT, "elephant/SVG/Image-_1_.svg"),
      after: path.join(ROOT, "frontend/public/pawns/elephant/elephant-01.svg"),
    },
    {
      label: "Dog One Line 01 · Y-flip and pt/viewBox check",
      before: path.join(PROOF_ROOT, "dog-line/Image-_1_.svg"),
      after: path.join(ROOT, "frontend/public/pawns/dog/dog-one-line-01.svg"),
    },
  ];
  const previewCards = (
    await Promise.all(
      samples.map(async ({ label, before, after }) => {
        const beforeSrc = await dataUrl(before, "image/svg+xml");
        const afterSrc = await dataUrl(after, "image/svg+xml");
        return `<article><h2>${label}</h2><div class="pair"><figure><img src="${beforeSrc}"><figcaption>SOURCE RENDER<br>ancestor translate + negative-Y scale; pt dimensions + unitless viewBox</figcaption></figure><div class="arrow">→</div><figure><img src="${afterSrc}"><figcaption>NORMALIZED RENDER<br>upright, square padded viewBox, aspect preserved</figcaption></figure></div></article>`;
      }),
    )
  ).join("");
  await page.setContent(`<!doctype html><style>
    *{box-sizing:border-box}body{margin:0;padding:40px;background:#f8fafc;color:#111827;font:16px system-ui}h1{margin-top:0}article{margin:28px 0;padding:22px;background:white;border:1px solid #cbd5e1;border-radius:12px}.pair{display:flex;align-items:center;justify-content:center;gap:30px}figure{margin:0;text-align:center;width:420px;height:480px;display:flex;flex-direction:column}img{height:400px;width:400px;object-fit:contain;background:repeating-conic-gradient(#e2e8f0 0 25%,white 0 50%) 50%/24px 24px;border:1px solid #94a3b8}figcaption{font-weight:700;margin-top:10px}.arrow{font-size:52px;color:#2563eb}
  </style><h1>Transform-aware normalization preview</h1><p>Visual equality checks the load-bearing negative Y transform and point-dimension versus unitless-viewBox handling before the 50-file batch is accepted.</p>${previewCards}`);
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete),
  );
  const previewFailures = await page.evaluate(
    () =>
      [...document.images].filter((image) => image.naturalWidth === 0).length,
  );
  if (previewFailures)
    throw new Error(`${previewFailures} preview images failed`);
  await page.screenshot({
    path: path.join(output, "transform-before-after.png"),
    fullPage: true,
  });
} finally {
  await browser.close();
}
