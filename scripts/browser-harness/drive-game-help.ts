import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import type {
  GameConfiguration,
  RulesVariant,
} from "../../shared/domain/game-types";
import { startStubServer, loggedOut } from "./stub-server";

const OUTPUT = join(
  import.meta.dir,
  "../../tmp/task-4e7b8296-help-reset/implementation-screenshots",
);
const GAME_ID = "help-fixture";

const initialState = (
  variant: RulesVariant,
): GameConfiguration["variantConfig"] => {
  if (variant === "classic") {
    return {
      pawns: {
        p1: { cat: [0, 0], home: [7, 7] },
        p2: { cat: [0, 7], home: [7, 0] },
      },
      walls: [],
    };
  }
  if (variant === "animal-cycle") {
    return {
      pawns: {
        p1: { cat: [0, 0], elephant: [7, 0] },
        p2: { mouse: [7, 7], dog: [0, 7] },
      },
      walls: [],
    };
  }
  return {
    pawns: {
      p1: { cat: [0, 0], mouse: [7, 0] },
      p2: { cat: [0, 7], mouse: [7, 7] },
    },
    walls: [],
  };
};

const config = (variant: RulesVariant): GameConfiguration => ({
  boardHeight: 8,
  boardWidth: 8,
  rated: false,
  variant,
  randomStart: false,
  timeControl: { initialSeconds: 180, incrementSeconds: 2, preset: "blitz" },
  variantConfig: initialState(variant),
});

const fail = (message: string): never => {
  throw new Error(message);
};

const pageMeasurements = (page: Page) =>
  page.evaluate(() => {
    const help = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Game help"]',
    );
    if (!help) throw new Error("Game help trigger is missing");
    const controls = [...document.querySelectorAll<HTMLElement>("button, a")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((element) => ({
        name:
          element.getAttribute("aria-label") ??
          element.getAttribute("title") ??
          element.textContent?.trim() ??
          "",
        rect: {
          x: Math.round(element.getBoundingClientRect().x * 100) / 100,
          y: Math.round(element.getBoundingClientRect().y * 100) / 100,
          width: Math.round(element.getBoundingClientRect().width * 100) / 100,
          height:
            Math.round(element.getBoundingClientRect().height * 100) / 100,
        },
      }));
    return {
      help: {
        x: Math.round(help.getBoundingClientRect().x * 100) / 100,
        y: Math.round(help.getBoundingClientRect().y * 100) / 100,
        width: Math.round(help.getBoundingClientRect().width * 100) / 100,
        height: Math.round(help.getBoundingClientRect().height * 100) / 100,
      },
      controls,
      horizontalOverflow:
        Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth,
        ) - window.innerWidth,
    };
  });

const assertDialog = async (page: Page, variant: RulesVariant) => {
  const dialog = page.getByRole("dialog", { name: "Game help" });
  await dialog.waitFor();
  const text = await dialog.innerText();
  for (const required of [
    "Make 2 actions per turn:",
    "Movement action",
    "Move 1 square per action. Diagonal is 2 actions.",
    "Wall action",
    "Walls are permanent.",
  ]) {
    if (!text.includes(required)) fail(`Missing approved copy: ${required}`);
  }
  if (
    /How to play|Standard rules|Close finish|Keep teammates apart/.test(text)
  ) {
    fail("Discarded player copy is visible");
  }
  if (variant === "standard") {
    if (!text.includes("Opponent's mouse"))
      fail("Standard opponent copy missing");
    if (
      !text.includes("Walls can't block a cat from reaching its target mouse.")
    ) {
      fail("Standard wall-path copy missing");
    }
  }
  if (
    variant === "classic" &&
    !text.includes("The first cat to reach home wins.")
  ) {
    fail("Classic home copy missing");
  }
  if (variant === "animal-cycle") {
    if ((text.match(/captures/g) ?? []).length !== 4) {
      fail("Animal Cycle must show four capture relations");
    }
    if (!text.includes("First capture wins."))
      fail("Animal Cycle win copy missing");
  }

  const geometry = await dialog.evaluate((root) => {
    const boards = [...root.querySelectorAll<HTMLElement>("[data-help-board]")];
    const wallResult = (orientation: "vertical" | "horizontal") => {
      const wall = root.querySelector<HTMLElement>(
        `[data-help-wall="${orientation}"]`,
      );
      if (!wall) throw new Error(`${orientation} wall missing`);
      const board = wall.closest<HTMLElement>("[data-help-board]")!;
      const cells = board.querySelectorAll<HTMLElement>(":scope > div");
      const wallRect = wall.getBoundingClientRect();
      const anchor =
        orientation === "vertical"
          ? cells[3].getBoundingClientRect()
          : cells[1].getBoundingClientRect();
      return {
        orientation,
        wall: {
          left: wallRect.left,
          top: wallRect.top,
          right: wallRect.right,
          bottom: wallRect.bottom,
          width: wallRect.width,
          height: wallRect.height,
        },
        anchor: {
          left: anchor.left,
          top: anchor.top,
          right: anchor.right,
          bottom: anchor.bottom,
          width: anchor.width,
          height: anchor.height,
        },
      };
    };
    return {
      boardCount: boards.length,
      vertical: wallResult("vertical"),
      horizontal: wallResult("horizontal"),
      pawnSources: [...root.querySelectorAll<HTMLImageElement>("img[alt]")]
        .map((image) => image.getAttribute("src"))
        .filter(Boolean),
      wallColor: getComputedStyle(
        root.querySelector<HTMLElement>('[data-help-wall="vertical"]')!,
      ).backgroundColor,
      wallPathWeight: getComputedStyle(
        [...root.querySelectorAll("p")].find((p) =>
          p.textContent?.startsWith("Walls can't"),
        )!,
      ).fontWeight,
    };
  });

  const tolerance = 0.6;
  const vertical = geometry.vertical;
  const horizontal = geometry.horizontal;
  if (
    Math.abs(vertical.wall.left - vertical.anchor.right) > tolerance ||
    Math.abs(vertical.wall.top - (vertical.anchor.top - 1)) > tolerance ||
    Math.abs(vertical.wall.width - 7) > tolerance ||
    Math.abs(vertical.wall.height - (vertical.anchor.height + 2)) > tolerance
  ) {
    fail(
      `Vertical wall is outside its legal slot: ${JSON.stringify(vertical)}`,
    );
  }
  if (
    Math.abs(horizontal.wall.left - (horizontal.anchor.left - 1)) > tolerance ||
    Math.abs(horizontal.wall.top - horizontal.anchor.bottom) > tolerance ||
    Math.abs(horizontal.wall.width - (horizontal.anchor.width + 2)) >
      tolerance ||
    Math.abs(horizontal.wall.height - 7) > tolerance
  ) {
    fail(
      `Horizontal wall is outside its legal slot: ${JSON.stringify(horizontal)}`,
    );
  }
  const requiredAssets = ["cat3.svg"];
  if (variant === "standard") requiredAssets.push("mouse20.svg");
  if (variant === "classic") requiredAssets.push("home2.svg");
  if (variant === "animal-cycle") {
    requiredAssets.push("mouse20.svg", "elephant-14.svg", "dog-puppy-03.svg");
  }
  for (const asset of requiredAssets) {
    if (!geometry.pawnSources.some((source) => source?.endsWith(asset))) {
      fail(`Default pawn asset missing: ${asset}`);
    }
  }
  if (geometry.wallColor !== "rgb(220, 38, 38)") {
    fail(
      `Wall did not derive the fixture player's red color: ${geometry.wallColor}`,
    );
  }
  if (geometry.wallPathWeight !== "400") {
    fail(`Wall path copy is not normal weight: ${geometry.wallPathWeight}`);
  }
  return geometry;
};

await mkdir(OUTPUT, { recursive: true });
const stub = startStubServer({ routes: { "/api/me": loggedOut }, port: 5184 });
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
});

try {
  for (const [layout, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    for (const variant of ["standard", "classic", "animal-cycle"] as const) {
      const context = await browser.newContext({
        viewport,
        colorScheme: "dark",
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const payload = JSON.stringify({
        config: config(variant),
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
      const trigger = page.getByRole("button", { name: "Game help" });
      await trigger.waitFor();
      const before = await pageMeasurements(page);
      if (before.horizontalOverflow !== 0) {
        fail(`${layout} closed page has horizontal overflow`);
      }
      if (variant === "standard") {
        await page.screenshot({
          path: join(OUTPUT, `${layout}-closed.png`),
          fullPage: false,
        });
      }

      await trigger.click();
      const geometry = await assertDialog(page, variant);
      const after = await pageMeasurements(page);
      if (after.horizontalOverflow !== 0) {
        fail(`${layout} ${variant} dialog has horizontal overflow`);
      }
      const beforeExisting = before.controls.filter(
        (control) => control.name !== "Game help",
      );
      const afterExisting = after.controls.filter(
        (control) => control.name !== "Game help" && control.name !== "Close",
      );
      if (JSON.stringify(beforeExisting) !== JSON.stringify(afterExisting)) {
        fail(`${layout} existing controls moved when HELP opened`);
      }
      await page.screenshot({
        path: join(OUTPUT, `${layout}-${variant}.png`),
        fullPage: false,
      });

      const dialog = page.getByRole("dialog", { name: "Game help" });
      const close = page.getByRole("button", { name: "Close" });
      if (!(await close.isVisible())) fail("Close button is not visible");
      const initialFocusInside = await page.evaluate(() =>
        document
          .querySelector('[role="dialog"]')
          ?.contains(document.activeElement),
      );
      if (!initialFocusInside)
        fail("Initial dialog focus is outside the dialog");
      await page.keyboard.press("Tab");
      const trapped = await page.evaluate(() =>
        document
          .querySelector('[role="dialog"]')
          ?.contains(document.activeElement),
      );
      if (!trapped) fail("Tab focus escaped the dialog");
      const reducedMotion = await page.evaluate(() => ({
        content: getComputedStyle(
          document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!,
        ).animationName,
        overlay: getComputedStyle(
          document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!,
        ).animationName,
      }));
      if (
        reducedMotion.content !== "none" ||
        reducedMotion.overlay !== "none"
      ) {
        fail(`Reduced motion still animates: ${JSON.stringify(reducedMotion)}`);
      }
      await page.keyboard.press("Escape");
      await page.getByRole("dialog", { name: "Game help" }).waitFor({
        state: "hidden",
      });
      const focusRestored = await trigger.evaluate(
        (element) => document.activeElement === element,
      );
      if (!focusRestored) fail("Dialog did not restore focus to its trigger");

      await trigger.press("Enter");
      await dialog.waitFor();
      await close.click();
      await dialog.waitFor({ state: "hidden" });
      await trigger.press(" ");
      await dialog.waitFor();
      await page
        .locator('[data-slot="dialog-overlay"]')
        .click({ position: { x: 4, y: 4 } });
      await dialog.waitFor({ state: "hidden" });

      console.log(
        JSON.stringify({
          layout,
          variant,
          viewport,
          helpRect: before.help,
          horizontalOverflow: after.horizontalOverflow,
          controlCount: beforeExisting.length,
          wallColor: geometry.wallColor,
          verticalSlot: geometry.vertical,
          horizontalSlot: geometry.horizontal,
        }),
      );
      await context.close();
    }
  }
  console.log(`screenshots=${OUTPUT}`);
  console.log(`requests=${JSON.stringify(stub.log())}`);
} finally {
  await browser.close();
  await stub.stop();
}
