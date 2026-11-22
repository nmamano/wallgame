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
import { moveFromStandardNotation } from "../../shared/domain/standard-notation";
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
let getLiveGameSummary: typeof import("../../server/games/store").getLiveGameSummary;

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
    const { gamePlayersTable } =
      await import("../../server/db/schema/game-players");
    ({ getSession, getLiveGameSummary } =
      await import("../../server/games/store"));
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
    // A guest (P1) against a bot (P2), each with its own recorded look.
    await db.insert(gamePlayersTable).values([
      {
        gameId: STORED_GAME_ID,
        playerOrder: 1,
        playerRole: "host",
        playerConfigType: "you",
        displayName: "Guest Wallaby",
        pawnColor: "green",
        catSkin: "cat-guest.svg",
        outcomeRank: 2,
        outcomeReason: "capture",
      },
      {
        gameId: STORED_GAME_ID,
        playerOrder: 2,
        playerRole: "joiner",
        playerConfigType: "bot",
        displayName: "Superhuman Bot",
        pawnColor: "pink",
        catSkin: "cat-bot.svg",
        outcomeRank: 1,
        outcomeReason: "capture",
      },
    ]);

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
    // A puzzle attempt, not a live game anyone can watch.
    expect(session.puzzle).toEqual({
      kind: "game",
      gameId: STORED_GAME_ID,
      ply: 10,
    });
    expect(getLiveGameSummary(body.gameId)).toBeNull();
    // The seats look as in the daily video: the human blue, the bot red, each
    // with its recorded pawns; not the request's or PuzzleBot's look.
    expect(session.players.host.appearance).toMatchObject({
      pawnColor: "blue",
      catSkin: "cat-guest.svg",
    });
    expect(session.players.joiner.appearance).toMatchObject({
      pawnColor: "red",
      catSkin: "cat-bot.svg",
    });
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

  it("the page's preview is exactly what the launch opens on", async () => {
    const res = await fetch(`${baseUrl}/api/puzzles/game/${STORED_GAME_ID}/11`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      launch: unknown;
      looks: Record<string, { pawnColor: string }>;
    };
    expect(body.launch).toEqual(
      JSON.parse(JSON.stringify(resolveGamePositionLaunch(STORED_GAME, 11))),
    );
    expect(body.looks["1"].pawnColor).toBe("blue");
    expect(body.looks["2"].pawnColor).toBe("red");
  });

  it("the preview refuses what the launch refuses", async () => {
    const after = await fetch(
      `${baseUrl}/api/puzzles/game/${STORED_GAME_ID}/${STORED_MOVES.length}`,
    );
    expect(after.status).toBe(409);
    const missing = await fetch(`${baseUrl}/api/puzzles/game/no-such-game/3`);
    expect(missing.status).toBe(404);
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

  it("a finished attempt is stored as a puzzle attempt, never as match history", async () => {
    const store = await import("../../server/games/store");
    const { persistCompletedGame } =
      await import("../../server/games/persistence");
    const queries = await import("../../server/db/game-queries");
    const { db } = await import("../../server/db");
    const { gamesTable } = await import("../../server/db/schema/games");
    const { eq } = await import("drizzle-orm");

    const res = await play(PUZZLE_BOT, STORED_GAME_ID, 10);
    expect(res.status).toBe(201);
    const { gameId } = (await res.json()) as { gameId: string };
    // 10 plies of the real game (enough for the showcase's 10-move floor),
    // then the human resigns. The bot seat is moved through the store: the
    // test's bot client never answers.
    const t = Date.now();
    for (let ply = 10; ply < 20; ply++) {
      store.applyPlayerMove({
        id: gameId,
        playerId: ply % 2 === 0 ? 1 : 2,
        move: moveFromStandardNotation(STORED_MOVES[ply], 8),
        timestamp: t + ply,
      });
    }
    store.resignGame({
      id: gameId,
      playerId: 1,
      timestamp: t + 100,
      cause: "player",
    });
    await persistCompletedGame(getSession(gameId));

    const [row] = await db
      .select({
        movesCount: gamesTable.movesCount,
        puzzleId: gamesTable.puzzleId,
        puzzleGameId: gamesTable.puzzleGameId,
        puzzlePly: gamesTable.puzzlePly,
      })
      .from(gamesTable)
      .where(eq(gamesTable.gameId, gameId));
    expect(row).toEqual({
      movesCount: 10,
      puzzleId: null,
      puzzleGameId: STORED_GAME_ID,
      puzzlePly: 10,
    });

    // The replay knows which position it came from.
    const replay = await queries.getReplayGameReadonly(gameId);
    expect(replay?.matchStatus.puzzle).toEqual({
      kind: "game",
      gameId: STORED_GAME_ID,
      ply: 10,
    });

    // Past Games and the showcase list the source game, not the attempt.
    const past = await queries.queryPastGames({ page: 1, pageSize: 100 });
    const pastIds = past.games.map((game) => game.gameId);
    expect(pastIds).toContain(STORED_GAME_ID);
    expect(pastIds).not.toContain(gameId);
    const showcaseIds = (await queries.getRandomShowcaseGames(100)).map(
      (game) => game.matchStatus.id,
    );
    expect(showcaseIds).toContain(STORED_GAME_ID);
    expect(showcaseIds).not.toContain(gameId);
  });
});
