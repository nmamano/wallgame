/**
 * The last-placed-wall highlight over a Crisp tee, on a REAL game, at 393x650.
 *
 * Board task c003ec83. The junction fix changes what is painted on the pillar
 * where a wall meets a run; the highlight is a box-shadow on the WALL div with
 * an 8px blur and 3px spread, so it reaches outside that div and composites
 * over exactly those pillar pixels. Reviewer 3 refused a structural argument
 * here, and was right to: d07a8f9 reverted a change to this same area because
 * the highlight looked fine in theory and wrong on a real phone.
 *
 * It has to be a real ONLINE game. `lastWalls` populates only from a server
 * `game-state` update (gameViewModel.ts:261) - measured 2026-08-16, two
 * completed turns of LOCAL play leave every wall with no glow at all, so no
 * offline route can produce a game-driven highlight.
 *
 * Two guest browser contexts against a real server on an ephemeral Postgres.
 * The host lays the run, the joiner lays the stem LAST, so the glow lands on
 * the wall whose colour used to bleed into the run.
 *
 * PORT 5173 IS NOT A PREFERENCE. The dev WebSocket guard allows exactly one
 * origin, http://localhost:5173 (game-socket.ts:2460), and it is not
 * configurable - on any other port every socket is refused and no game starts.
 *
 * Every placement is VERIFIED by the wall count rather than assumed. The board
 * is random per game, an illegal wall is refused silently, and a refused click
 * leaves the turn incomplete so no update is sent and nothing ever glows. That
 * is not hypothetical: it produced an empty glow list on one run and a real one
 * on the next, off identical code. The run also fails loudly if no glow appears,
 * because a screenshot of an unhighlighted board would prove nothing.
 *
 * Needs Docker. Run it after `bun run build` (hold /tmp/wallgame-build.lock):
 *   SHOT_TAG=after bun scripts/browser-harness/drive-live-wall-highlight.ts
 */
import { chromium, type Page } from "playwright-core";
import { setupEphemeralDb, teardownEphemeralDb } from "../../tests/setup-db";

const TAG = process.env.SHOT_TAG ?? "shot";
const OUT = "tmp/crisp-junction";
/** The one origin the dev WebSocket guard accepts. Not a preference. */
const PORT = 5173;
const GRID = ".grid.w-full.relative";

interface Slot {
  index: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  cx: number;
  cy: number;
  vertical: boolean;
}
interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
interface Junction {
  x: number;
  y: number;
  west: Slot;
  east: Slot;
  north: Slot;
}
interface Glow {
  bg: string;
  shadow: string;
}

process.env.FRONTEND_URL = `http://localhost:${PORT}`;
const handle = await setupEphemeralDb();
const { createApp } = await import("../../server/app");
const { app, websocket } = createApp();
const server = Bun.serve({ fetch: app.fetch, websocket, port: PORT });
const BASE = `http://localhost:${PORT}`;

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--no-sandbox"],
});

/** 0 unless something below fails; carried through the forced exit. */
let exitStatus = 0;

const slotsOf = (page: Page): Promise<Slot[]> =>
  page.evaluate((grid: string) => {
    const root = document.querySelector(grid);
    if (!root) return [];
    return [...root.children].flatMap((el, index) => {
      if (getComputedStyle(el).zIndex !== "15") return [];
      const r = el.getBoundingClientRect();
      return [
        {
          index,
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          cx: (r.left + r.right) / 2,
          cy: (r.top + r.bottom) / 2,
          vertical: r.height > r.width,
        },
      ];
    });
  }, GRID);

const jointsOf = (page: Page): Promise<Box[]> =>
  page.evaluate((grid: string) => {
    const root = document.querySelector(grid);
    if (!root) return [];
    return [...root.children].flatMap((el) => {
      if (getComputedStyle(el).zIndex !== "12") return [];
      const r = el.getBoundingClientRect();
      return [{ left: r.left, right: r.right, top: r.top, bottom: r.bottom }];
    });
  }, GRID);

const wallCount = (page: Page): Promise<number> =>
  page.evaluate((grid: string) => {
    const root = document.querySelector(grid);
    if (!root) return 0;
    return [...root.children].filter((el) =>
      (el.getAttribute("class") ?? "").includes("shadow-md"),
    ).length;
  }, GRID);

/** Walls carrying the last-placed highlight, if any. */
const glowsOf = (page: Page): Promise<Glow[]> =>
  page.evaluate((grid: string) => {
    const root = document.querySelector(grid);
    if (!root) return [];
    return [...root.children]
      .filter((el) => (el.getAttribute("class") ?? "").includes("shadow-md"))
      .map((el) => ({
        bg: getComputedStyle(el).backgroundColor,
        shadow: getComputedStyle(el).boxShadow,
      }))
      .filter(
        (w) =>
          w.shadow !== "" &&
          w.shadow !== "none" &&
          !w.shadow.includes("rgba(0, 0, 0, 0) 0px 0px 0px 0px"),
      );
  }, GRID);

const clickSlot = (page: Page, index: number): Promise<void> =>
  page.evaluate(
    ([grid, k]: [string, number]) => {
      const root = document.querySelector(grid);
      const child = root?.children[k];
      if (child instanceof HTMLElement) child.click();
    },
    [GRID, index] as [string, number],
  );

/**
 * Clicks a wall slot and reports whether a wall actually appeared.
 *
 * The board is random per game and an illegal wall is refused in silence, so
 * an unchecked click can leave the turn incomplete - no server update, no
 * `lastWalls`, nothing to photograph.
 */
const place = async (page: Page, index: number): Promise<boolean> => {
  const before = await wallCount(page);
  await clickSlot(page, index);
  await page.waitForTimeout(600);
  return (await wallCount(page)) > before;
};

const openPage = async (): Promise<Page> => {
  const context = await browser.newContext({
    viewport: { width: 393, height: 650 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.setItem("wall-game-board-theme", JSON.stringify("crisp"));
    localStorage.setItem("wall-game-theme", "dark");
  });
  return page;
};

try {
  const host = await openPage();
  await host.goto(`${BASE}/play`, { waitUntil: "networkidle" });
  await host.waitForTimeout(800);
  await host
    .getByRole("button", { name: /Invite Friend/i })
    .first()
    .click();
  await host.waitForTimeout(300);
  await host
    .getByRole("button", { name: /^Create game$/i })
    .first()
    .click();
  await host.waitForTimeout(2500);

  const joiner = await openPage();
  await joiner.goto(host.url(), { waitUntil: "networkidle" });
  await joiner.waitForTimeout(2000);
  await joiner
    .getByRole("button", { name: /^Join Game$/i })
    .first()
    .click();
  await joiner.waitForTimeout(3000);

  const slots = await slotsOf(host);
  const joints = await jointsOf(host);
  const horizontal = slots.filter((s) => !s.vertical);
  const vertical = slots.filter((s) => s.vertical);
  const near = (a: number, b: number) => Math.abs(a - b) < 4;

  const candidates: Junction[] = [];
  for (const j of joints) {
    const x = (j.left + j.right) / 2;
    const y = (j.top + j.bottom) / 2;
    const west = horizontal.find((h) => near(h.cy, y) && near(h.right, j.left));
    const east = horizontal.find((h) => near(h.cy, y) && near(h.left, j.right));
    const north = vertical.find((v) => near(v.cx, x) && near(v.bottom, j.top));
    if (west && east && north) candidates.push({ x, y, west, east, north });
  }
  if (candidates.length === 0) {
    throw new Error("no junction had west, east and north slots");
  }
  console.log(`candidate junctions: ${candidates.length}`);

  // Host lays the run; the joiner lays the stem LAST, so the glow lands on the
  // wall whose colour used to bleed into the run.
  let target: Junction | null = null;
  let glowing: Glow[] = [];
  for (const c of candidates) {
    if (!(await place(host, c.west.index))) continue;
    if (!(await place(host, c.east.index))) continue;
    await host.waitForTimeout(1800);
    if (!(await place(joiner, c.north.index))) continue;
    let turnEnded = false;
    for (const far of horizontal.filter((h) => Math.abs(h.cy - c.y) > 90)) {
      if (await place(joiner, far.index)) {
        turnEnded = true;
        break;
      }
    }
    if (!turnEnded) continue;
    await joiner.waitForTimeout(2500);
    glowing = await glowsOf(host);
    if (glowing.length > 0) {
      target = c;
      break;
    }
  }
  if (!target) throw new Error("could not build a highlighted tee");
  console.log(`glows: ${JSON.stringify(glowing)}`);

  const junction = target;
  for (const [name, page] of [
    ["host", host],
    ["joiner", joiner],
  ] as const) {
    const spot = await page.evaluate(
      ([grid, x, y]: [string, number, number]) => {
        const root = document.querySelector(grid);
        if (!root) return null;
        const hit = [...root.children].find((el) => {
          if (getComputedStyle(el).zIndex !== "12") return false;
          const b = el.getBoundingClientRect();
          return (
            x >= b.left - 2 &&
            x <= b.right + 2 &&
            y >= b.top - 2 &&
            y <= b.bottom + 2
          );
        });
        if (!hit) return null;
        hit.scrollIntoView({ block: "center", inline: "center" });
        const b = hit.getBoundingClientRect();
        return { cx: (b.left + b.right) / 2, cy: (b.top + b.bottom) / 2 };
      },
      [GRID, junction.x, junction.y] as [string, number, number],
    );
    // Both-client agreement is part of what this run claims, so a missing crop
    // is a failure, not a note. Skipping one would leave the claim standing on
    // half the evidence.
    if (!spot) {
      throw new Error(`${name}: junction not found for the crop`);
    }
    await page.waitForTimeout(300);
    await page.screenshot({
      path: `${OUT}/${TAG}-live-highlight-${name}-mobile-dpr2.png`,
      clip: {
        x: Math.max(0, spot.cx - 46),
        y: Math.max(0, spot.cy - 46),
        width: 92,
        height: 92,
      },
    });
    console.log(`${name}: shot written`);
  }
} catch (error) {
  // Print it here: the forced exit below would otherwise be the last thing to
  // run, and an unhandled rejection racing process.exit can be swallowed.
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  exitStatus = 1;
} finally {
  await browser.close();
  await server.stop(true);
  await teardownEphemeralDb(handle.container);
  // The forced exit STAYS. Importing server/db opens a postgres-js pool at
  // module load and nothing ever closes it, so this process would hang after
  // finishing every query. It must carry the status, though: an unconditional
  // exit(0) here reported success after a thrown assertion - including "no
  // highlighted tee was ever built", which is the one failure this harness
  // exists to catch.
  process.exit(exitStatus);
}
