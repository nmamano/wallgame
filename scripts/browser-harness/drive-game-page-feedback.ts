import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import type { GameConfiguration } from "../../shared/domain/game-types";
import { loggedOut, startStubServer } from "./stub-server";

const OUTPUT = join(
  import.meta.dir,
  "../../tmp/task-833f483a-game-page-feedback",
);
const GAME_ID = "feedback-fixture";

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
      const root =
        document.querySelector<HTMLElement>(".min-h-screen") ??
        document.querySelector<HTMLElement>(".overflow-hidden");
      if (!root) throw new Error("capture feedback surface missing");
      root.classList.add("game-capture-shake");
    });
    const reduced = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(".game-capture-shake");
      if (!root) throw new Error("capture feedback surface missing");
      const style = getComputedStyle(root);
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
