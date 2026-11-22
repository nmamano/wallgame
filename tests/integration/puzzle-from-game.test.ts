/**
 * POST /api/bots/play with `fromGame` (task a03b8f5c): a position from a
 * stored game launched against the puzzle bot. The server rebuilds the
 * position from the stored game, so the created game must open on that exact
 * position with the human to move, and every unplayable request must be
 * refused before a game exists.
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";

import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type {
  BotConfig,
  CustomBotClientMessage,
} from "../../shared/contracts/custom-bot-protocol";
import { resolveGamePositionLaunch } from "../../shared/domain/game-position-puzzle";
import {
  STORED_GAME,
  STORED_GAME_ID,
  STORED_INITIAL_STATE,
  STORED_MOVES,
} from "../fixtures/stored-standard-game";

const TEST_OFFICIAL_TOKEN = "test-official-token";
process.env.OFFICIAL_BOT_TOKEN = TEST_OFFICIAL_TOKEN;

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;
let getSession: typeof import("../../server/games/store").getSession;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const STANDARD_8X8 = {
  standard: {
    boardWidth: { min: 4, max: 12 },
    boardHeight: { min: 4, max: 10 },
    recommended: [{ boardWidth: 8, boardHeight: 8 }],
  },
};

const puzzleBot: BotConfig = {
  botId: "puzzle-bot",
  name: "PuzzleBot",
  username: null,
  officialToken: TEST_OFFICIAL_TOKEN,
  analysis: true,
  placement: "puzzle",
  variants: STANDARD_8X8,
};

const ordinaryBot: BotConfig = {
  botId: "ordinary-bot",
  name: "Ordinary Bot",
  username: null,
  officialToken: TEST_OFFICIAL_TOKEN,
  variants: STANDARD_8X8,
};

async function attachBots(clientId: string, bots: BotConfig[]) {
  const socket = new WebSocket(
    `${baseUrl.replace("http", "ws")}/ws/custom-bot`,
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const attach: CustomBotClientMessage = {
    type: "attach",
    protocolVersion: 3,
    clientId,
    bots,
    client: { name: "puzzle-from-game-test", version: "1.0.0" },
  };
  socket.send(JSON.stringify(attach));
  await new Promise<void>((resolve) => {
    socket.on("message", (raw: Buffer) => {
      const parsed = JSON.parse(raw.toString()) as { type: string };
      if (parsed.type === "attached") resolve();
    });
  });
  return socket;
}

const clientId = "puzzle-from-game-client";
const PUZZLE_BOT = `${clientId}:puzzle-bot`;
const ORDINARY_BOT = `${clientId}:ordinary-bot`;

const play = (botId: string, gameId: string, ply: number) =>
  fetch(`${baseUrl}/api/bots/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      botId,
      fromGame: { gameId, ply },
      hostDisplayName: "Tester",
    }),
  });

describe("a stored game's position launched as a puzzle", () => {
  let socket: WebSocket;

  beforeAll(async () => {
    container = (await setupEphemeralDb()).container;
    const { db } = await import("../../server/db");
    const { gamesTable } = await import("../../server/db/schema/games");
    const { gameDetailsTable } =
      await import("../../server/db/schema/game-details");
    ({ getSession } = await import("../../server/games/store"));
    const { app, websocket } = (await import("../../server/app")).createApp();
    server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
    baseUrl = `http://localhost:${server.port}`;

    await db.insert(gamesTable).values({
      gameId: STORED_GAME_ID,
      variant: "standard",
      rated: false,
      timeControl: "blitz",
      boardWidth: 8,
      boardHeight: 8,
      movesCount: STORED_MOVES.length,
      startedAt: new Date("2026-10-23T16:25:02.770Z"),
      matchType: "friend",
    });
    await db.insert(gameDetailsTable).values({
      gameId: STORED_GAME_ID,
      configParameters: {
        timeControl: STORED_GAME.config.timeControl,
        randomStart: false,
        initialState: STORED_INITIAL_STATE,
      },
      moves: STORED_MOVES,
    });

    socket = await attachBots(clientId, [puzzleBot, ordinaryBot]);
    // The bot registry writes through to the DB asynchronously on attach.
    await sleep(200);
  }, 120_000);

  afterAll(async () => {
    socket?.close();
    await server?.stop(true);
    await teardownEphemeralDb(container);
  });

  it("P1 to move: the game opens on the position, the human is P1", async () => {
    const res = await play(PUZZLE_BOT, STORED_GAME_ID, 10);
    const body = (await res.json()) as { gameId: string; playerId: number };
    expect(res.status).toBe(201);
    expect(body.playerId).toBe(1);
    const session = getSession(body.gameId);
    expect(session.config.variantConfig).toEqual(
      resolveGamePositionLaunch(STORED_GAME, 10).config.variantConfig,
    );
    expect(session.gameState.history).toHaveLength(0);
    expect(session.gameState.turn).toBe(1);
  });

  it("P2 to move: the game's real move N-1 is already played", async () => {
    const res = await play(PUZZLE_BOT, STORED_GAME_ID, 11);
    const body = (await res.json()) as { gameId: string; playerId: number };
    expect(res.status).toBe(201);
    expect(body.playerId).toBe(2);
    const state = getSession(body.gameId).gameState;
    expect(state.history).toHaveLength(1);
    expect(state.turn).toBe(2);
  });

  it("refuses an opponent that is not the puzzle bot", async () => {
    const res = await play(ORDINARY_BOT, STORED_GAME_ID, 10);
    expect(res.status).toBe(400);
  });

  it("refuses a game that is not stored", async () => {
    const res = await play(PUZZLE_BOT, "no-such-game", 10);
    expect(res.status).toBe(404);
  });

  it("refuses the position after the last move", async () => {
    const res = await play(PUZZLE_BOT, STORED_GAME_ID, STORED_MOVES.length);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("cannot be played as a puzzle");
  });

  it("refuses a request that also carries a config", async () => {
    const res = await fetch(`${baseUrl}/api/bots/play`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        botId: PUZZLE_BOT,
        fromGame: { gameId: STORED_GAME_ID, ply: 10 },
        config: {
          variant: "standard",
          randomStart: false,
          boardWidth: 8,
          boardHeight: 8,
        },
      }),
    });
    expect(res.status).toBe(400);
  });
});
