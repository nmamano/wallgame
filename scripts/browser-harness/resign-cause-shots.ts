/**
 * The result line of a resigned game, for each stored resign cause (board
 * task 89ef6b5b): screenshots of the replay page, desktop and phone.
 *
 * Five finished fixture games on an ephemeral Postgres, all won by Host
 * (Player 1) by resignation after the same two opening moves; they differ only
 * in game_details.resign_cause: player, disconnect, idle, bot-forfeit, and
 * NULL (a game stored before the cause was recorded). The real server
 * (createApp) serves this tree's frontend/dist, so build first. Never a
 * production game.
 *
 *   flock /tmp/wallgame-build.lock bun run build
 *   SHOT_TAG=final bun scripts/browser-harness/resign-cause-shots.ts
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { setupEphemeralDb, teardownEphemeralDb } from "../../tests/setup-db";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import type { ResignCause } from "../../shared/domain/game-types";

const TAG = process.env.SHOT_TAG ?? "shot";
const OUT = "tmp/resign-cause";
const PORT = 5191;
const SIZE = 8;
process.env.ADDITIONAL_WS_ORIGINS = `http://localhost:${PORT}`;

const CASES: { id: string; cause: ResignCause | null }[] = [
  { id: "player", cause: "player" },
  { id: "disconnect", cause: "disconnect" },
  { id: "idle", cause: "idle" },
  { id: "bot-forfeit", cause: "bot-forfeit" },
  { id: "old-game", cause: null },
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

  for (const [index, { id, cause }] of CASES.entries()) {
    const gameId = `resign-${id}`;
    await db.insert(gamesTable).values({
      gameId,
      variant: "standard",
      timeControl: "unlimited",
      rated: false,
      matchType: "friend",
      boardWidth: SIZE,
      boardHeight: SIZE,
      startedAt: new Date(Date.UTC(2026, 10, 2, 0, index)),
      movesCount: 2,
    });
    await db.insert(gameDetailsTable).values({
      gameId,
      configParameters: {
        initialState: buildStandardInitialState(SIZE, SIZE),
      },
      moves: ["Cb8.Ma2", "Cg8.Mh2"],
      resignCause: cause,
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
    console.log(gameId, JSON.stringify(replay?.state.result));
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
      for (const { id } of CASES) {
        await page.goto(`http://localhost:${PORT}/game/resign-${id}`, {
          waitUntil: "networkidle",
        });
        const line = page
          .getByText(/^Host won/)
          .locator("visible=true")
          .first();
        await line.waitFor();
        await page.waitForTimeout(500);
        const path = `${OUT}/${TAG}-${id}-${device.name}.png`;
        await page.screenshot({ path });
        const text = await line.locator("xpath=..").innerText();
        console.log(`${path}: ${text.replace(/\s+/g, " ")}`);
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
