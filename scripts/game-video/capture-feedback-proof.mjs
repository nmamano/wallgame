import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { captureFeedbackPlan } from "./capture-feedback.mjs";

const repo = resolve(import.meta.dir, "../..");
const output = join(repo, "tmp/task-833f483a-video-capture-proof");
const board = `file://${join(repo, "tmp/task-833f483a-game-page-feedback/desktop.png")}`;
const stageFile = `file://${join(import.meta.dir, "stage.html")}`;
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 } });
await page.goto(stageFile, { waitUntil: "load" });

const player = (name, hex) => ({
  name,
  portrait: board,
  sub: "player",
  hex,
  soft: "rgba(255,255,255,0.12)",
});
const base = {
  segment: "play",
  board,
  top: player("Also You", "#60a5fa"),
  bottom: player("You", "#f97316"),
};

const capture = captureFeedbackPlan({
  isFinalPly: true,
  resultReason: "capture",
});
const resignation = captureFeedbackPlan({
  isFinalPly: true,
  resultReason: "resignation",
});

const render = async (name, shake) => {
  const transform = await page.evaluate(
    (state) => {
      window.__stage(state);
      return document.getElementById("play").style.transform;
    },
    { ...base, shake, shakePhase: 1 },
  );
  await page.screenshot({ path: join(output, `${name}.png`) });
  return transform;
};

const captureTransform = await render(
  "capture-one-stage-shake",
  capture.stageShakeCount,
);
const settledTransform = await render("capture-settled", 0);
const nonCaptureTransform = await render(
  "resignation-zero-shake",
  resignation.stageShakeCount,
);

if (capture.stageShakeCount !== 1 || capture.appShakeCount !== 0) {
  throw new Error(
    "capture does not have exactly one stage shake and zero app shakes",
  );
}
if (resignation.stageShakeCount !== 0 || nonCaptureTransform !== "none") {
  throw new Error("non-capture ending shook");
}
if (!captureTransform.includes("translate") || settledTransform !== "none") {
  throw new Error("capture stage did not shake and settle");
}

await writeFile(
  join(output, "report.json"),
  JSON.stringify(
    {
      measuredAt: "2026-08-29",
      capture,
      resignation,
      captureTransform,
      settledTransform,
      nonCaptureTransform,
    },
    null,
    2,
  ),
);
await browser.close();
console.log(`PASS ${output}`);
