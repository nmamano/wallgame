import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { chromium, type Page } from "playwright";
import type { GameConfiguration } from "../../shared/domain/game-types";
import { loggedOut, startStubServer } from "./stub-server";

const OUTPUT = join(
  import.meta.dir,
  "../../tmp/task-833f483a-game-page-feedback",
);
const GAME_ID = "feedback-fixture";
const CAPTURE_FRAME_TIMES = [
  0, 32, 64.8, 100, 136.8, 176, 216, 252, 288, 324, 360,
];
const FORCE_REVEALED_PIXEL_MISMATCH =
  process.env.GAME_CAPTURE_EDGE_CONTROL === "revealed-pixel-mismatch";
interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

const decodePng = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const chunks: Uint8Array[] = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(
      bytes.subarray(offset + 4, offset + 8),
    );
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      const header = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
      width = header.getUint32(0);
      height = header.getUint32(4);
      if (data[8] !== 8 || ![2, 6].includes(data[9])) {
        throw new Error("expected an 8-bit RGB or RGBA PNG");
      }
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      chunks.push(data);
    }
    offset += length + 12;
  }
  const compressed = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const raw = inflateSync(compressed);
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * channels);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x] ?? 0;
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      if (filter === 0) row[x] = source[x];
      else if (filter === 1) row[x] = source[x] + left;
      else if (filter === 2) row[x] = source[x] + up;
      else if (filter === 3) {
        row[x] = source[x] + Math.floor((left + up) / 2);
      } else if (filter === 4) {
        const prediction = left + up - upperLeft;
        const leftDistance = Math.abs(prediction - left);
        const upDistance = Math.abs(prediction - up);
        const upperLeftDistance = Math.abs(prediction - upperLeft);
        row[x] =
          source[x] +
          (leftDistance <= upDistance && leftDistance <= upperLeftDistance
            ? left
            : upDistance <= upperLeftDistance
              ? up
              : upperLeft);
      } else {
        throw new Error(`unsupported PNG filter ${filter}`);
      }
    }
    pixels.set(row, y * stride);
    previous = row;
  }
  return { width, height, channels, pixels };
};

const config: GameConfiguration = {
  boardHeight: 8,
  boardWidth: 8,
  rated: false,
  variant: "standard",
  randomStart: true,
  timeControl: { initialSeconds: 180, incrementSeconds: 2, preset: "blitz" },
  variantConfig: {
    pawns: {
      p1: { cat: [0, 0], mouse: [7, 0] },
      p2: { cat: [0, 7], mouse: [7, 7] },
    },
    walls: [],
  },
};

const measure = (page: Page) =>
  page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(
      '.grid[style*="grid-template-columns"]',
    );
    const board = grid?.parentElement?.parentElement;
    const files = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-board-coordinate="file"]',
      ),
    ];
    const ranks = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-board-coordinate="rank"]',
      ),
    ];
    if (!grid || !board) throw new Error("board geometry is missing");
    return {
      grid: {
        x: grid.getBoundingClientRect().x,
        y: grid.getBoundingClientRect().y,
        width: grid.getBoundingClientRect().width,
        height: grid.getBoundingClientRect().height,
      },
      board: {
        x: board.getBoundingClientRect().x,
        y: board.getBoundingClientRect().y,
        width: board.getBoundingClientRect().width,
        height: board.getBoundingClientRect().height,
      },
      files: files.map((element) => ({
        text: element.textContent,
        display: getComputedStyle(element).display,
        rect: {
          x: element.getBoundingClientRect().x,
          y: element.getBoundingClientRect().y,
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
        },
      })),
      ranks: ranks.map((element) => ({
        text: element.textContent,
        display: getComputedStyle(element).display,
        rect: {
          x: element.getBoundingClientRect().x,
          y: element.getBoundingClientRect().y,
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
        },
      })),
    };
  });

await mkdir(OUTPUT, { recursive: true });
const stub = startStubServer({ routes: { "/api/me": loggedOut }, port: 5187 });
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
});
const report: Record<string, unknown> = {};

try {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 393, height: 852 }],
  ] as const) {
    const context = await browser.newContext({
      viewport,
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const payload = JSON.stringify({
      config,
      players: ["you", "you"],
      nextSeatOrder: [0, 1],
    });
    await page.addInitScript(
      ({ key, value }) => sessionStorage.setItem(key, value),
      { key: `game-config-${GAME_ID}`, value: payload },
    );
    await page.goto(`${stub.url}/game/${GAME_ID}`, {
      waitUntil: "networkidle",
    });
    await page.locator('[data-board-coordinate="file"]').first().waitFor();

    if (name === "mobile") {
      await page.getByRole("button", { name: "Settings" }).click();
    }
    const controlPanelVariant =
      (await page
        .locator("[data-control-panel-variant]")
        .first()
        .textContent()) ?? "";
    if (controlPanelVariant.trim() !== "Standard") {
      throw new Error(`${name}: control-panel label is not Standard-only`);
    }
    if (name === "mobile") await page.keyboard.press("Escape");

    const visible = await measure(page);
    if (
      visible.files.length !== 8 ||
      visible.ranks.length !== 8 ||
      [...visible.files, ...visible.ranks].some(
        (label) => label.display === "none" || label.rect.width === 0,
      )
    ) {
      throw new Error(`${name}: board coordinates are not visible`);
    }
    await page.screenshot({
      path: join(OUTPUT, `${name}.png`),
      fullPage: false,
    });

    await page.addStyleTag({
      content: "[data-board-coordinate] { display: none !important; }",
    });
    const hidden = await measure(page);
    if (
      JSON.stringify(visible.grid) !== JSON.stringify(hidden.grid) ||
      JSON.stringify(visible.board) !== JSON.stringify(hidden.board)
    ) {
      throw new Error(`${name}: coordinates changed board or grid geometry`);
    }
    await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(
        "[data-capture-shake-stage]",
      );
      if (!stage) throw new Error("capture feedback stage missing");
      stage.classList.add("game-capture-shake");
    });
    const reduced = await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(
        "[data-capture-shake-stage].game-capture-shake",
      );
      if (!stage) throw new Error("capture feedback stage missing");
      const style = getComputedStyle(stage);
      return { animationName: style.animationName, transform: style.transform };
    });
    if (reduced.animationName !== "none" || reduced.transform !== "none") {
      throw new Error(`${name}: reduced motion still animates app pixels`);
    }

    report[name] = {
      viewport,
      controlPanelVariant,
      visible,
      hidden,
      reduced,
    };
    await context.close();

    for (const theme of ["light", "dark"] as const) {
      const motionContext = await browser.newContext({
        viewport,
        colorScheme: theme,
        reducedMotion: "no-preference",
      });
      const motionPage = await motionContext.newPage();
      await motionPage.addInitScript(
        ({ key, value, selectedTheme }) => {
          sessionStorage.setItem(key, value);
          localStorage.setItem("wall-game-theme", selectedTheme);
        },
        {
          key: `game-config-${GAME_ID}`,
          value: payload,
          selectedTheme: theme,
        },
      );
      await motionPage.goto(`${stub.url}/game/${GAME_ID}`, {
        waitUntil: "networkidle",
      });
      await motionPage
        .locator('[data-board-coordinate="file"]')
        .first()
        .waitFor();
      await motionPage.waitForFunction(
        (selectedTheme) =>
          document.documentElement.classList.contains(selectedTheme),
        theme,
      );
      await motionPage.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );

      const settledGeometry = await measure(motionPage);
      const nonCaptureAnimations = await motionPage
        .locator("[data-capture-shake-stage]")
        .evaluate((stage) => stage.getAnimations().length);
      if (nonCaptureAnimations !== 0) {
        throw new Error(`${name}-${theme}: non-capture page is animating`);
      }

      const stableStageRect: Rect = await motionPage.evaluate(() => {
        const stage = document.querySelector<HTMLElement>(
          "[data-capture-shake-stage]",
        );
        if (!stage) throw new Error("capture feedback stage missing");
        const rect = stage.getBoundingClientRect();
        stage.classList.add("game-capture-shake");
        const animations = stage.getAnimations();
        if (animations.length !== 1) {
          throw new Error(`capture created ${animations.length} animations`);
        }
        animations[0].pause();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      });

      const frames = [];
      for (const time of CAPTURE_FRAME_TIMES) {
        const frame = await motionPage.evaluate(
          ({ currentTime, stable }: { currentTime: number; stable: Rect }) => {
            const surface = document.querySelector<HTMLElement>(
              "[data-capture-feedback-surface]",
            );
            const stage = document.querySelector<HTMLElement>(
              "[data-capture-shake-stage]",
            );
            if (!surface || !stage) {
              throw new Error("capture surfaces missing");
            }
            const animation = stage.getAnimations()[0];
            if (!animation) throw new Error("capture animation missing");
            animation.currentTime = currentTime;
            const moved = stage.getBoundingClientRect();
            const surfaceRect = surface.getBoundingClientRect();
            const visibleLeft = Math.max(0, Math.ceil(surfaceRect.left));
            const visibleRight = Math.min(
              innerWidth - 1,
              Math.floor(surfaceRect.right - 1),
            );
            const visibleTop = Math.max(0, Math.ceil(surfaceRect.top));
            const visibleBottom = Math.min(
              innerHeight - 1,
              Math.floor(surfaceRect.bottom - 1),
            );
            const points: [number, number][] = [];
            for (let x = visibleLeft; x <= visibleRight; x++) {
              points.push([x, visibleTop], [x, visibleBottom]);
            }
            for (let y = visibleTop + 1; y < visibleBottom; y++) {
              points.push([visibleLeft, y], [visibleRight, y]);
            }
            let foreignViewportPixels = 0;
            let revealedStageStripPixels = 0;
            const revealedSamples: {
              x: number;
              y: number;
              hitTag: string;
            }[] = [];
            for (const [x, y] of points) {
              const hit = document.elementFromPoint(x, y);
              const belongsToFixedSurface =
                hit === surface || surface.contains(hit);
              if (!hit || !belongsToFixedSurface) {
                foreignViewportPixels++;
              }
              const inStableStage =
                x >= stable.left &&
                x < stable.right &&
                y >= stable.top &&
                y < stable.bottom;
              const inMovedStage =
                x >= moved.left &&
                x < moved.right &&
                y >= moved.top &&
                y < moved.bottom;
              if (
                inStableStage &&
                !inMovedStage &&
                hit !== stage &&
                !stage.contains(hit)
              ) {
                revealedStageStripPixels++;
                revealedSamples.push({
                  x,
                  y,
                  hitTag: hit?.tagName ?? "null",
                });
              }
            }
            const resolveColor = (color: string) => {
              const canvas = document.createElement("canvas");
              canvas.width = 1;
              canvas.height = 1;
              const context = canvas.getContext("2d")!;
              context.fillStyle = color;
              context.fillRect(0, 0, 1, 1);
              return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
            };
            return {
              time: currentTime,
              transform: getComputedStyle(stage).transform,
              movedRect: {
                left: moved.left,
                right: moved.right,
                top: moved.top,
                bottom: moved.bottom,
                width: moved.width,
                height: moved.height,
              },
              fixedSurfaceBackground: getComputedStyle(surface).backgroundColor,
              fixedSurfaceRgb: resolveColor(
                getComputedStyle(surface).backgroundColor,
              ),
              bodyBackground: getComputedStyle(document.body).backgroundColor,
              foreignViewportPixels,
              revealedStageStripPixels,
              revealedSamples,
            };
          },
          { currentTime: time, stable: stableStageRect },
        );
        if (frame.foreignViewportPixels !== 0) {
          throw new Error(
            `${name}-${theme}-${time}ms: ${frame.foreignViewportPixels} perimeter pixels are outside the fixed game surface`,
          );
        }
        const screenshot = await motionPage.screenshot({
          path: join(
            OUTPUT,
            `${name}-${theme}-${String(time).replace(".", "_")}ms.png`,
          ),
        });
        const image = decodePng(screenshot);
        const expectedSurfaceRgb = FORCE_REVEALED_PIXEL_MISMATCH
          ? [255, 0, 255]
          : frame.fixedSurfaceRgb;
        const revealedPixelMismatches = frame.revealedSamples.filter(
          ({ x, y }) => {
            const offset = (y * image.width + x) * image.channels;
            return expectedSurfaceRgb.some(
              (channel, index) => image.pixels[offset + index] !== channel,
            );
          },
        );
        if (revealedPixelMismatches.length !== 0) {
          throw new Error(
            `REVEALED_PIXEL_MISMATCH ${name}-${theme}-${time}ms: ${revealedPixelMismatches.length}/${frame.revealedSamples.length} captured pixels differ from expected fixed-surface RGB ${expectedSurfaceRgb.join(",")}`,
          );
        }
        frames.push({
          ...frame,
          revealedPixelMismatches: revealedPixelMismatches.length,
        });
      }
      await motionPage.evaluate(() => {
        const stage = document.querySelector<HTMLElement>(
          "[data-capture-shake-stage]",
        )!;
        stage.getAnimations().forEach((animation) => animation.cancel());
        stage.classList.remove("game-capture-shake");
      });
      const restoredGeometry = await measure(motionPage);
      if (
        JSON.stringify(settledGeometry) !== JSON.stringify(restoredGeometry)
      ) {
        throw new Error(
          `${name}-${theme}: shake changed settled board geometry`,
        );
      }
      report[`${name}-${theme}-capture-edge`] = {
        viewport,
        stableStageRect,
        settledGeometry,
        restoredGeometry,
        nonCaptureAnimations,
        frames,
      };
      await motionContext.close();
    }
  }
  await writeFile(
    join(OUTPUT, "report.json"),
    JSON.stringify({ measuredAt: "2026-08-29", ...report }, null, 2),
  );
} finally {
  await browser.close();
  await stub.stop();
}

console.log(`PASS ${OUTPUT}`);
