/**
 * Integration tests for past games persistence and replay.
 *
 * Uses Testcontainers to spin up an ephemeral PostgreSQL database.
 * No manual database setup required - just Docker.
 */

import {
  describe,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  expect,
} from "bun:test";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type {
  GameConfiguration,
  Move,
  PlayerId,
} from "../../shared/domain/game-types";
import type {
  PastGamesResponse,
  ResolveGameAccessResponse,
} from "../../shared/contracts/games";

// ================================
// --- Test Harness ---
// ================================

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

let db: typeof import("../../server/db").db;
let createApp: typeof import("../../server/index").createApp;
let createGameSession: typeof import("../../server/games/store").createGameSession;
let joinGameSession: typeof import("../../server/games/store").joinGameSession;
let applyPlayerMove: typeof import("../../server/games/store").applyPlayerMove;
let resignGame: typeof import("../../server/games/store").resignGame;
let persistCompletedGame: typeof import("../../server/games/persistence").persistCompletedGame;
let gamesTable: typeof import("../../server/db/schema/games").gamesTable;
let usersTable: typeof import("../../server/db/schema/users").usersTable;
let userAuthTable: typeof import("../../server/db/schema/users").userAuthTable;
let eq: typeof import("drizzle-orm").eq;

async function importServerModules() {
  const dbModule = await import("../../server/db");
  const serverModule = await import("../../server/index");
  const storeModule = await import("../../server/games/store");
  const persistenceModule = await import("../../server/games/persistence");
  const gamesSchemaModule = await import("../../server/db/schema/games");
  const usersSchemaModule = await import("../../server/db/schema/users");
  const drizzleOrm = await import("drizzle-orm");

  db = dbModule.db;
  createApp = serverModule.createApp;
  createGameSession = storeModule.createGameSession;
  joinGameSession = storeModule.joinGameSession;
  applyPlayerMove = storeModule.applyPlayerMove;
  resignGame = storeModule.resignGame;
  persistCompletedGame = persistenceModule.persistCompletedGame;
  gamesTable = gamesSchemaModule.gamesTable;
  usersTable = usersSchemaModule.usersTable;
  userAuthTable = usersSchemaModule.userAuthTable;
  eq = drizzleOrm.eq;
}

function startTestServer() {
  const { app, websocket } = createApp();
  server = Bun.serve({
    fetch: app.fetch,
    websocket,
    port: 0,
  });
  baseUrl = `http://localhost:${server.port}`;
}

async function stopTestServer() {
  if (server) {
    await server.stop(true);
  }
}

// ================================
// --- Helpers ---
// ================================

const seededUserIds: number[] = [];

async function seedUser(args: {
  authUserId: string;
  displayName: string;
  capitalizedDisplayName: string;
}): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({
      displayName: args.displayName,
      capitalizedDisplayName: args.capitalizedDisplayName,
      authProvider: "test",
    })
    .returning({ userId: usersTable.userId });

  await db.insert(userAuthTable).values({
    userId: user.userId,
    authProvider: "test",
    authUserId: args.authUserId,
  });

  seededUserIds.push(user.userId);
  return user.userId;
}

async function cleanupUsers(): Promise<void> {
  await db.delete(gamesTable);
  for (const userId of seededUserIds) {
    await db.delete(usersTable).where(eq(usersTable.userId, userId));
  }
  seededUserIds.length = 0;
}

const buildOpeningMove = (
  config: GameConfiguration,
  playerId: PlayerId,
): Move => {
  const rows = config.boardHeight;
  const cols = config.boardWidth;
  if (playerId === 1) {
    return {
      actions: [
        { type: "cat", target: [0, 1] },
        { type: "mouse", target: [rows - 2, 0] },
      ],
    };
  }
  return {
    actions: [
      { type: "cat", target: [0, cols - 2] },
      { type: "mouse", target: [rows - 2, cols - 1] },
    ],
  };
};

async function createCompletedGame(args: {
  config: GameConfiguration;
  hostAuthUserId?: string;
  joinerAuthUserId?: string;
  startedAt?: number;
}): Promise<string> {
  const { session } = createGameSession({
    config: args.config,
    matchType: "friend",
    hostDisplayName: "host",
    hostIsPlayer1: true,
    hostAuthUserId: args.hostAuthUserId,
  });

  joinGameSession({
    id: session.id,
    displayName: "joiner",
    authUserId: args.joinerAuthUserId,
  });

  const startTimestamp = args.startedAt ?? Date.now();

  applyPlayerMove({
    id: session.id,
    playerId: 1,
    move: buildOpeningMove(args.config, 1),
    timestamp: startTimestamp,
  });

  applyPlayerMove({
    id: session.id,
    playerId: 2,
    move: buildOpeningMove(args.config, 2),
    timestamp: startTimestamp + 1000,
  });

  resignGame({
    id: session.id,
    playerId: 1,
    timestamp: startTimestamp + 2000,
  });

  await persistCompletedGame(session);
  return session.id;
}

// ================================
// --- Test Setup ---
// ================================

beforeAll(async () => {
  const handle = await setupEphemeralDb();
  container = handle.container;
  await importServerModules();
  startTestServer();
}, 120_000);

beforeEach(async () => {
  await db.delete(gamesTable);
});

afterAll(async () => {
  await cleanupUsers();
  await stopTestServer();
  await teardownEphemeralDb(container);
}, 60_000);

// ================================
// --- Tests ---
// ================================

describe("past games persistence", () => {
  it("serves replay data from the DB and increments views", async () => {
    const config: GameConfiguration = {
      timeControl: {
        initialSeconds: 120,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "standard",
      rated: false,
      boardWidth: 6,
      boardHeight: 6,
    };

    const gameId = await createCompletedGame({
      config,
      startedAt: Date.now() - 5000,
    });

    const [initialRow] = await db
      .select({ views: gamesTable.views })
      .from(gamesTable)
      .where(eq(gamesTable.gameId, gameId))
      .limit(1);
    expect(initialRow?.views).toBe(0);

    const res = await fetch(`${baseUrl}/api/games/${gameId}`);
    expect(res.status).toBe(200);
    const replay = (await res.json()) as ResolveGameAccessResponse;
    expect(replay.kind).toBe("replay");
    if (replay.kind !== "replay") {
      throw new Error("Expected replay response");
    }
    expect(replay.state.moveCount).toBe(2);
    expect(replay.views).toBe(1);

    const [afterFirstView] = await db
      .select({ views: gamesTable.views })
      .from(gamesTable)
      .where(eq(gamesTable.gameId, gameId))
      .limit(1);
    expect(afterFirstView?.views).toBe(1);

    const res2 = await fetch(`${baseUrl}/api/games/${gameId}`);
    expect(res2.status).toBe(200);
    const replay2 = (await res2.json()) as ResolveGameAccessResponse;
    expect(replay2.kind).toBe("replay");
    if (replay2.kind !== "replay") {
      throw new Error("Expected replay response");
    }
    expect(replay2.views).toBe(2);
  });

  it("filters and paginates past games", async () => {
    const alphaAuth = "auth-alpha";
    const betaAuth = "auth-beta";

    await seedUser({
      authUserId: alphaAuth,
      displayName: "alpha",
      capitalizedDisplayName: "Alpha",
    });
    await seedUser({
      authUserId: betaAuth,
      displayName: "beta",
      capitalizedDisplayName: "Beta",
    });

    const baseTime = Date.now() - 20_000;

    const gameA = await createCompletedGame({
      config: {
        timeControl: {
          initialSeconds: 180,
          incrementSeconds: 2,
          preset: "rapid",
        },
        variant: "standard",
        rated: true,
        boardWidth: 9,
        boardHeight: 9,
      },
      hostAuthUserId: alphaAuth,
      joinerAuthUserId: betaAuth,
      startedAt: baseTime,
    });

    const gameB = await createCompletedGame({
      config: {
        timeControl: {
          initialSeconds: 90,
          incrementSeconds: 1,
          preset: "blitz",
        },
        variant: "classic",
        rated: false,
        boardWidth: 6,
        boardHeight: 6,
      },
      hostAuthUserId: alphaAuth,
      startedAt: baseTime + 1000,
    });

    const gameC = await createCompletedGame({
      config: {
        timeControl: {
          initialSeconds: 60,
          incrementSeconds: 0,
          preset: "bullet",
        },
        variant: "standard",
        rated: false,
        boardWidth: 10,
        boardHeight: 10,
      },
      hostAuthUserId: betaAuth,
      startedAt: baseTime + 2000,
    });

    const res = await fetch(
      `${baseUrl}/api/games/past?variant=standard&page=1&pageSize=1`,
    );
    expect(res.status).toBe(200);
    const standardPage1 = (await res.json()) as PastGamesResponse;
    expect(standardPage1.games.length).toBe(1);
    expect(standardPage1.games[0]?.gameId).toBe(gameC);
    expect(standardPage1.hasMore).toBe(true);

    const resPage2 = await fetch(
      `${baseUrl}/api/games/past?variant=standard&page=2&pageSize=1`,
    );
    expect(resPage2.status).toBe(200);
    const standardPage2 = (await resPage2.json()) as PastGamesResponse;
    expect(standardPage2.games.length).toBe(1);
    expect(standardPage2.games[0]?.gameId).toBe(gameA);
    expect(standardPage2.hasMore).toBe(false);

    const resPlayer = await fetch(
      `${baseUrl}/api/games/past?player1=alpha&page=1&pageSize=10`,
    );
    expect(resPlayer.status).toBe(200);
    const alphaGames = (await resPlayer.json()) as PastGamesResponse;
    const alphaIds = alphaGames.games.map((game) => game.gameId).sort();
    expect(alphaIds).toEqual([gameA, gameB].sort());

    const resBoard = await fetch(
      `${baseUrl}/api/games/past?boardSize=small&page=1&pageSize=10`,
    );
    expect(resBoard.status).toBe(200);
    const smallBoardGames = (await resBoard.json()) as PastGamesResponse;
    expect(smallBoardGames.games.length).toBe(1);
    expect(smallBoardGames.games[0]?.gameId).toBe(gameB);
  });
});
