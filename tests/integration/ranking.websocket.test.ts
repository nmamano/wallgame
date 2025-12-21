/**
 * Integration test for ranking updates after a rated game.
 *
 * Uses Testcontainers to spin up an ephemeral PostgreSQL database.
 * No manual database setup required - just Docker.
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { randomUUID } from "crypto";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type {
  GameCreateResponse,
  GameSessionDetails,
  JoinGameResponse,
} from "../../shared/contracts/games";
import type {
  ActionRequestMessage,
  ServerMessage,
} from "../../shared/contracts/websocket-messages";
import type { GameConfiguration } from "../../shared/domain/game-types";
import { moveFromStandardNotation } from "../../shared/domain/standard-notation";
import type { RankingResponse } from "../../shared/contracts/ranking";

// ================================
// --- Test Harness ---
// ================================

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

let db: typeof import("../../server/db").db;
let createApp: typeof import("../../server/index").createApp;
let usersTable: typeof import("../../server/db/schema/users").usersTable;
let userAuthTable: typeof import("../../server/db/schema/users").userAuthTable;
let ratingsTable: typeof import("../../server/db/schema/ratings").ratingsTable;
let gamesTable: typeof import("../../server/db/schema/games").gamesTable;
let eq: typeof import("drizzle-orm").eq;

async function importServerModules() {
  const dbModule = await import("../../server/db");
  const serverModule = await import("../../server/index");
  const usersSchemaModule = await import("../../server/db/schema/users");
  const ratingsSchemaModule = await import("../../server/db/schema/ratings");
  const gamesSchemaModule = await import("../../server/db/schema/games");
  const drizzleOrm = await import("drizzle-orm");

  db = dbModule.db;
  createApp = serverModule.createApp;
  usersTable = usersSchemaModule.usersTable;
  userAuthTable = usersSchemaModule.userAuthTable;
  ratingsTable = ratingsSchemaModule.ratingsTable;
  gamesTable = gamesSchemaModule.gamesTable;
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
// --- Database Seeding Helpers ---
// ================================

const seededUserIds: number[] = [];

async function seedUser(authUserId: string): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({
      displayName: `player_${authUserId}`,
      capitalizedDisplayName: `Player_${authUserId}`,
      authProvider: "test",
    })
    .returning();

  seededUserIds.push(user.userId);

  await db.insert(userAuthTable).values({
    userId: user.userId,
    authProvider: "test",
    authUserId,
  });

  return user.userId;
}

async function cleanupUsers(): Promise<void> {
  await db.delete(gamesTable);
  for (const userId of seededUserIds) {
    await db.delete(ratingsTable).where(eq(ratingsTable.userId, userId));
    await db.delete(userAuthTable).where(eq(userAuthTable.userId, userId));
    await db.delete(usersTable).where(eq(usersTable.userId, userId));
  }
  seededUserIds.length = 0;
}

// ================================
// --- HTTP Client Helpers ---
// ================================

async function createFriendGame(
  userId: string,
  config: GameConfiguration,
  hostIsPlayer1: boolean,
): Promise<GameCreateResponse> {
  const res = await fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    body: JSON.stringify({
      config,
      matchType: "friend",
      hostDisplayName: `Player ${userId}`,
      hostIsPlayer1,
    }),
  });

  expect(res.status).toBe(201);
  return (await res.json()) as GameCreateResponse;
}

async function joinFriendGame(
  userId: string,
  gameId: string,
): Promise<GameSessionDetails> {
  const res = await fetch(`${baseUrl}/api/games/${gameId}/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    body: JSON.stringify({
      displayName: `Player ${userId}`,
    }),
  });

  expect(res.status).toBe(200);
  const json = (await res.json()) as JoinGameResponse;
  expect(json.role).toBe("player");
  if (json.role !== "player") {
    throw new Error("Expected join response to return player credentials");
  }

  return {
    snapshot: json.snapshot,
    role: json.seat,
    playerId: json.playerId,
    token: json.token,
    socketToken: json.socketToken,
    shareUrl: json.shareUrl,
  };
}

// ================================
// --- WebSocket Client Helpers ---
// ================================

interface TestSocket {
  ws: WebSocket;
  waitForMessage: <T extends ServerMessage["type"]>(
    expectedType: T,
    options?: { ignore?: ServerMessage["type"][] },
  ) => Promise<Extract<ServerMessage, { type: T }>>;
  close: () => void;
}

async function openGameSocket(
  userId: string,
  gameId: string,
  socketToken: string,
): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl =
      baseUrl.replace("http", "ws") +
      `/ws/games/${gameId}?token=${socketToken}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: "http://localhost:5173",
        "x-test-user-id": userId,
      },
    });

    const buffer: ServerMessage[] = [];
    let waitingResolve: ((msg: ServerMessage) => void) | null = null;

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      if (waitingResolve) {
        const resolveWaiting = waitingResolve;
        waitingResolve = null;
        resolveWaiting(msg);
      } else {
        buffer.push(msg);
      }
    });

    ws.on("open", () => {
      resolve({
        ws,
        close: () => ws.close(),
        waitForMessage: <T extends ServerMessage["type"]>(
          expectedType: T,
          options?: { ignore?: ServerMessage["type"][] },
        ) => {
          const ignoreTypes = options?.ignore ?? [];
          return new Promise<Extract<ServerMessage, { type: T }>>(
            (resolveWait, rejectWait) => {
              const processMessage = (msg: ServerMessage): boolean => {
                if (msg.type === expectedType) {
                  resolveWait(msg as Extract<ServerMessage, { type: T }>);
                  return true;
                }
                if (ignoreTypes.includes(msg.type)) {
                  return false;
                }
                rejectWait(
                  new Error(
                    `Expected "${expectedType}" but got "${msg.type}".`,
                  ),
                );
                return true;
              };

              while (buffer.length > 0) {
                const msg = buffer.shift()!;
                if (processMessage(msg)) {
                  return;
                }
              }

              const timeout = setTimeout(() => {
                waitingResolve = null;
                rejectWait(
                  new Error(`Timeout waiting for "${expectedType}" message.`),
                );
              }, 5000);

              const waitForNext = () => {
                waitingResolve = (msg: ServerMessage) => {
                  if (processMessage(msg)) {
                    clearTimeout(timeout);
                  } else {
                    waitForNext();
                  }
                };
              };
              waitForNext();
            },
          );
        },
      });
    });

    ws.on("error", (err) => reject(err));
  });
}

async function sendActionRequestAndExpectAck(
  socket: TestSocket,
  action: "resign",
): Promise<void> {
  const requestId = randomUUID();
  const message: ActionRequestMessage<"resign"> = {
    type: "action-request",
    requestId,
    action,
  };
  socket.ws.send(JSON.stringify(message));
  const ack = await socket.waitForMessage("actionAck", {
    ignore: ["state", "match-status"],
  });
  expect(ack.requestId).toBe(requestId);
  expect(ack.action).toBe(action);
}

async function sendMoveAndWaitForState(
  senderSocketIdx: 0 | 1,
  allSockets: [TestSocket, TestSocket],
  moveNotation: string,
  boardHeight: number,
): Promise<void> {
  const move = moveFromStandardNotation(moveNotation, boardHeight);
  allSockets[senderSocketIdx].ws.send(
    JSON.stringify({
      type: "submit-move",
      move,
    }),
  );
  await Promise.all([
    allSockets[0].waitForMessage("state", { ignore: ["match-status"] }),
    allSockets[1].waitForMessage("state", { ignore: ["match-status"] }),
  ]);
}

// ================================
// --- Test ---
// ================================

describe("ranking integration", () => {
  beforeAll(async () => {
    const handle = await setupEphemeralDb();
    container = handle.container;
    await importServerModules();
    startTestServer();
  }, 120_000);

  afterAll(async () => {
    await cleanupUsers();
    await stopTestServer();
    await teardownEphemeralDb(container);
  }, 60_000);

  it("ranks the winner first after a rated resignation", async () => {
    const userA = "alpha";
    const userB = "beta";
    await seedUser(userA);
    await seedUser(userB);

    const config: GameConfiguration = {
      timeControl: {
        initialSeconds: 120,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "standard",
      rated: true,
      boardWidth: 3,
      boardHeight: 3,
    };

    const { gameId, socketToken: socketTokenA } = await createFriendGame(
      userA,
      config,
      true,
    );
    const joiner = await joinFriendGame(userB, gameId);

    const socketA = await openGameSocket(userA, gameId, socketTokenA);
    const socketB = await openGameSocket(userB, gameId, joiner.socketToken);

    await socketA.waitForMessage("state");
    await socketA.waitForMessage("match-status");
    await socketB.waitForMessage("state");
    await socketB.waitForMessage("match-status");

    await sendMoveAndWaitForState(0, [socketA, socketB], "Cb2", 3);

    await sendActionRequestAndExpectAck(socketA, "resign");

    const [stateA, stateB] = await Promise.all([
      socketA.waitForMessage("state", { ignore: ["match-status"] }),
      socketB.waitForMessage("state", { ignore: ["match-status"] }),
    ]);
    expect(stateA.state.status).toBe("finished");
    expect(stateA.state.result?.reason).toBe("resignation");
    expect(stateA.state.result?.winner).toBe(2);
    expect(stateA.state).toEqual(stateB.state);

    await Promise.all([
      socketA.waitForMessage("match-status"),
      socketB.waitForMessage("match-status"),
    ]);

    socketA.close();
    socketB.close();

    const res = await fetch(
      `${baseUrl}/api/ranking?variant=standard&timeControl=rapid&page=1&pageSize=100`,
    );
    expect(res.status).toBe(200);
    const ranking = (await res.json()) as RankingResponse;
    expect(ranking.rows.length).toBeGreaterThanOrEqual(2);

    const top = ranking.rows[0];
    expect(top.rank).toBe(1);
    expect(top.displayName).toBe(`player_${userB}`);

    const other = ranking.rows.find(
      (row) => row.displayName === `player_${userA}`,
    );
    expect(other).toBeDefined();
    expect(top.rating).toBeGreaterThan(other!.rating);
  }, 30_000);
});
