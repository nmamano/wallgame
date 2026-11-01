/**
 * Screenshots for one site batch: the last-move arrow of a diagonal 2-step
 * move (board task e93322a1) and the social links in the home footer (board
 * task 9538978d).
 *
 * Three finished fixture games on an ephemeral Postgres, each ending on a
 * diagonal 2-step cat move by Player 1 from b7 [1,1] to c6 [2,2]:
 *   wall-end    a wall right of b7: the straight arrow grazes its end.
 *   two-walls   that wall plus one under c7: the straight arrow runs through
 *               the point where the two walls meet.
 *   open        no wall: both corners are open, and the row-first rule
 *               picks c7.
 * Notation joins a pawn's two steps into one action, so every fixture move
 * stores the same way, whatever the steps below say.
 * The real server (createApp) serves this tree's frontend/dist, so build
 * first. Never a production game.
 *
 *   flock /tmp/wallgame-build.lock bun run build
 *   SHOT_TAG=after bun scripts/browser-harness/arrow-route-shots.ts
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { setupEphemeralDb, teardownEphemeralDb } from "../../tests/setup-db";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import { moveToStandardNotation } from "../../shared/domain/standard-notation";
import type { Move } from "../../shared/domain/game-types";

const TAG = process.env.SHOT_TAG ?? "shot";
const OUT = "tmp/arrow-route";
const PORT = 5191;
const SIZE = 8;
const GRID = ".grid.w-full.relative";
process.env.ADDITIONAL_WS_ORIGINS = `http://localhost:${PORT}`;

const notation = (move: Move) => moveToStandardNotation(move, SIZE);
const catTo = (...targets: [number, number][]): Move => ({
  actions: targets.map((target) => ({ type: "cat", target })),
});

const SCENARIOS: { id: string; moves: Move[] }[] = [
  {
    id: "wall-end",
    moves: [
      catTo([1, 1]),
      {
        actions: [
          { type: "wall", target: [1, 1], wallOrientation: "vertical" },
          { type: "cat", target: [0, 6] },
        ],
      },
      catTo([2, 2]),
    ],
  },
  {
    id: "two-walls",
    moves: [
      catTo([1, 1]),
      {
        actions: [
          { type: "wall", target: [1, 1], wallOrientation: "vertical" },
          { type: "wall", target: [2, 2], wallOrientation: "horizontal" },
        ],
      },
      catTo([2, 1], [2, 2]),
    ],
  },
  {
    id: "open",
    moves: [catTo([1, 1]), catTo([0, 6], [0, 5]), catTo([2, 2])],
  },
];

const handle = await setupEphemeralDb();
let exitStatus = 0;
try {
  const { db } = await import("../../server/db");
  const { gamesTable } = await import("../../server/db/schema/games");
  const { gameDetailsTable } =
    await import("../../server/db/schema/game-details");
  const { gamePlayersTable } =
    await import("../../server/db/schema/game-players");
  const { getReplayGameReadonly } =
    await import("../../server/db/game-queries");
  const { createApp } = await import("../../server/app");

  for (const [index, scenario] of SCENARIOS.entries()) {
    const gameId = `arrow-${scenario.id}`;
    await db.insert(gamesTable).values({
      gameId,
      variant: "standard",
      timeControl: "unlimited",
      rated: false,
      matchType: "friend",
      boardWidth: SIZE,
      boardHeight: SIZE,
      startedAt: new Date(Date.UTC(2026, 10, 1, 0, index)),
      movesCount: scenario.moves.length,
    });
    await db.insert(gameDetailsTable).values({
      gameId,
      configParameters: {
        initialState: buildStandardInitialState(SIZE, SIZE),
      },
      moves: scenario.moves.map(notation),
    });
    await db.insert(gamePlayersTable).values(
      ([1, 2] as const).map((order) => ({
        gameId,
        playerOrder: order,
        playerRole: order === 1 ? "host" : "joiner",
        playerConfigType: "friend",
        displayName: order === 1 ? "Host" : "Joiner",
        outcomeRank: order === 1 ? 1 : 2,
        outcomeReason: "resignation",
      })),
    );
    const replay = await getReplayGameReadonly(gameId);
    if (replay?.state.history.length !== scenario.moves.length) {
      throw new Error(`${gameId}: the fixture does not replay in full`);
    }
    console.log(gameId, scenario.moves.map(notation).join(" "));
  }

  const { app, websocket } = createApp();
  const server = Bun.serve({ fetch: app.fetch, websocket, port: PORT });
  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--no-sandbox"],
  });
  mkdirSync(OUT, { recursive: true });
  const devices = [
    { name: "desktop", viewport: { width: 1280, height: 900 } },
    { name: "phone", viewport: { width: 393, height: 852 } },
  ];
  try {
    for (const device of devices) {
      const context = await browser.newContext({
        viewport: device.viewport,
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      for (const scenario of SCENARIOS) {
        await page.goto(`http://localhost:${PORT}/game/arrow-${scenario.id}`, {
          waitUntil: "networkidle",
        });
        await page.waitForSelector(GRID);
        await page.waitForTimeout(800);
        const base = `${OUT}/${TAG}-${scenario.id}-${device.name}`;
        await page.screenshot({ path: `${base}.png` });
        await page
          .locator(GRID)
          .first()
          .screenshot({
            path: `${base}-board.png`,
          });
        console.log(`${base}: written`);
      }
      // The home footer (board task 9538978d), and in embedded mode, where
      // its outbound links must be gone.
      for (const [name, query] of [
        ["footer", ""],
        ["footer-embedded", "?embedded=1"],
      ]) {
        await page.goto(`http://localhost:${PORT}/${query}`, {
          waitUntil: "networkidle",
        });
        const footer = page.locator("footer").first();
        await footer.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        const base = `${OUT}/${TAG}-${name}-${device.name}`;
        await footer.screenshot({ path: `${base}.png` });
        await page.screenshot({ path: `${base}-page.png` });
        console.log(
          `${base}: written, social links:`,
          await footer.locator("ul a[aria-label]").count(),
        );
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await server.stop(true);
  }
} catch (error) {
  console.error(error);
  exitStatus = 1;
} finally {
  await teardownEphemeralDb(handle.container);
}
process.exit(exitStatus);
