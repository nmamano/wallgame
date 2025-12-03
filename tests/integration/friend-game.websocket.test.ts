/**
 * Integration tests for friend game WebSocket functionality.
 *
 * Uses Testcontainers to spin up an ephemeral PostgreSQL database.
 * No manual database setup required - just Docker.
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type {
  GameCreateResponse,
  GameSessionDetails,
  JoinGameResponse,
  MatchmakingGamesResponse,
} from "../../shared/contracts/games";
import type {
  ClientMessage,
  ServerMessage,
} from "../../shared/contracts/websocket-messages";
import type {
  GameConfiguration,
  PlayerAppearance,
} from "../../shared/domain/game-types";
import { moveFromStandardNotation } from "../../shared/domain/standard-notation";

// ================================
// --- Test Harness ---
// ================================

let container: StartedTestContainer;
let server: any;
let baseUrl: string;

// These will be dynamically imported after DB is set up
let db: typeof import("../../server/db").db;
let createApp: typeof import("../../server/index").createApp;
let usersTable: typeof import("../../server/db/schema/users").usersTable;
let userAuthTable: typeof import("../../server/db/schema/users").userAuthTable;
let ratingsTable: typeof import("../../server/db/schema/ratings").ratingsTable;
let eq: typeof import("drizzle-orm").eq;
let sql: typeof import("drizzle-orm").sql;

async function importServerModules() {
  // Dynamic imports - these must happen AFTER DATABASE_URL is set
  const dbModule = await import("../../server/db");
  const serverModule = await import("../../server/index");
  const usersSchemaModule = await import("../../server/db/schema/users");
  const ratingsSchemaModule = await import("../../server/db/schema/ratings");
  const drizzleOrm = await import("drizzle-orm");

  db = dbModule.db;
  createApp = serverModule.createApp;
  usersTable = usersSchemaModule.usersTable;
  userAuthTable = usersSchemaModule.userAuthTable;
  ratingsTable = ratingsSchemaModule.ratingsTable;
  eq = drizzleOrm.eq;
  sql = drizzleOrm.sql;
}

function startTestServer() {
  const { app, websocket } = createApp();
  server = Bun.serve({
    fetch: app.fetch,
    websocket,
    port: 0, // Random available port
  });
  baseUrl = `http://localhost:${server.port}`;
}

async function stopTestServer() {
  if (server) {
    server.stop();
  }
}

// ================================
// --- Database Seeding Helpers ---
// ================================

/** Track seeded user IDs for cleanup */
const seededUserIds: number[] = [];

/**
 * Seeds a test user with an ELO rating in the database.
 * The authUserId should match the x-test-user-id header used in requests.
 */
async function seedTestUser(
  authUserId: string,
  options: {
    variant: string;
    timeControl: string;
    rating: number;
  },
): Promise<number> {
  // Create user
  const [user] = await db
    .insert(usersTable)
    .values({
      displayName: `player_${authUserId}`,
      capitalizedDisplayName: `Player_${authUserId}`,
      authProvider: "test",
    })
    .returning();

  seededUserIds.push(user.userId);

  // Create auth mapping (links test auth ID to internal user ID)
  await db.insert(userAuthTable).values({
    userId: user.userId,
    authProvider: "test",
    authUserId: authUserId, // This matches x-test-user-id header
  });

  // Create rating
  await db.insert(ratingsTable).values({
    userId: user.userId,
    variant: options.variant,
    timeControl: options.timeControl,
    rating: options.rating,
  });

  return user.userId;
}

/**
 * Cleans up all seeded test users and their related data.
 */
async function cleanupTestUsers(): Promise<void> {
  for (const userId of seededUserIds) {
    // Delete in order respecting foreign keys
    await db.delete(ratingsTable).where(eq(ratingsTable.userId, userId));
    await db.delete(userAuthTable).where(eq(userAuthTable.userId, userId));
    await db.delete(usersTable).where(eq(usersTable.userId, userId));
  }
  seededUserIds.length = 0;
}

// ================================
// --- HTTP Client Helpers ---
// ================================

/**
 * Creates a friend game with explicit Player 1 assignment for deterministic tests.
 *
 * @param hostIsPlayer1 - Whether the host becomes Player 1 (who starts first).
 *   Pass explicitly in tests for determinism. If omitted, server chooses randomly.
 *   See game-types.ts for terminology: Player A/B (roles) vs Player 1/2 (game logic).
 */
async function createFriendGame(
  userId: string,
  config: GameConfiguration,
  options?: {
    appearance?: PlayerAppearance;
    hostIsPlayer1?: boolean;
  },
): Promise<GameCreateResponse> {
  const res = await fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    body: JSON.stringify({
      config: config,
      matchType: "friend",
      hostDisplayName: `Player ${userId}`,
      hostAppearance: options?.appearance,
      hostIsPlayer1: options?.hostIsPlayer1,
    }),
  });

  if (res.status !== 201) {
    const text = await res.text();
    throw new Error(
      `Expected status 201 but got ${res.status}. Error: ${text}`,
    );
  }
  const json = await res.json();
  return json as GameCreateResponse;
}

/**
 * Creates a matchmaking game with explicit Player 1 assignment for deterministic tests.
 *
 * @param hostIsPlayer1 - Whether the host becomes Player 1 (who starts first).
 *   Pass explicitly in tests for determinism. If omitted, server chooses randomly.
 *   See game-types.ts for terminology: Player A/B (roles) vs Player 1/2 (game logic).
 */
async function createMatchmakingGame(
  userId: string,
  config: GameConfiguration,
  options?: {
    appearance?: PlayerAppearance;
    hostIsPlayer1?: boolean;
  },
): Promise<GameCreateResponse> {
  const res = await fetch(`${baseUrl}/api/games`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    body: JSON.stringify({
      config: config,
      matchType: "matchmaking",
      hostDisplayName: `Player ${userId}`,
      hostAppearance: options?.appearance,
      hostIsPlayer1: options?.hostIsPlayer1,
    }),
  });

  expect(res.status).toBe(201);
  const json = await res.json();
  return json as GameCreateResponse;
}

async function joinFriendGame(
  userId: string,
  gameId: string,
  appearance?: PlayerAppearance,
): Promise<GameSessionDetails> {
  const res = await fetch(`${baseUrl}/api/games/${gameId}/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    body: JSON.stringify({
      displayName: `Player ${userId}`,
      appearance,
    }),
  });

  expect(res.status).toBe(200);
  const json = (await res.json()) as JoinGameResponse;

  // Find joiner's playerId from the snapshot
  // The host chose whether they're Player 1 or 2, so joiner gets the other
  const joinerPlayer = json.snapshot.players.find((p) => p.role === "joiner");
  const playerId = joinerPlayer?.playerId ?? 2;

  return {
    snapshot: json.snapshot,
    role: "joiner",
    playerId,
    token: json.token,
    socketToken: json.socketToken,
    shareUrl: json.shareUrl,
  };
}

async function fetchMatchmakingGames(): Promise<
  MatchmakingGamesResponse["games"]
> {
  const res = await fetch(`${baseUrl}/api/games/matchmaking`);
  expect(res.status).toBe(200);
  const json = (await res.json()) as MatchmakingGamesResponse;
  return json.games;
}

// ================================
// --- WebSocket Client Helpers ---
// ================================

type TestSocket = {
  ws: WebSocket;
  /** Wait for the next message of the expected type. Skips messages of ignored types. Fails immediately if an unexpected type arrives. */
  waitForMessage: <T extends ServerMessage["type"]>(
    expectedType: T,
    options?: { ignore?: ServerMessage["type"][] },
  ) => Promise<Extract<ServerMessage, { type: T }>>;
  /** Consume and ignore any buffered messages of the given type (useful for match-status messages). */
  drainMessages: (type: ServerMessage["type"]) => void;
  /** Get current buffer state for debugging. */
  getBufferState: () => string;
  close: () => void;
};

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

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      if (waitingResolve) {
        const resolve = waitingResolve;
        waitingResolve = null;
        resolve(msg);
      } else {
        buffer.push(msg);
      }
    });

    ws.on("open", () => {
      resolve({
        ws,
        close: () => ws.close(),

        getBufferState: () => {
          return buffer.map((m) => m.type).join(", ") || "(empty)";
        },

        drainMessages: (type: ServerMessage["type"]) => {
          for (let i = buffer.length - 1; i >= 0; i--) {
            if (buffer[i].type === type) {
              buffer.splice(i, 1);
            }
          }
        },

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
                  return true; // Handled
                } else if (ignoreTypes.includes(msg.type)) {
                  return false; // Skip, keep waiting
                } else {
                  rejectWait(
                    new Error(
                      `Expected message type "${expectedType}" but got "${msg.type}". ` +
                        `Message: ${JSON.stringify(msg, null, 2)}`,
                    ),
                  );
                  return true; // Handled (with error)
                }
              };

              // Check buffer first, skip ignored messages
              while (buffer.length > 0) {
                const msg = buffer.shift()!;
                if (processMessage(msg)) {
                  return;
                }
                // Message was ignored, continue checking buffer
              }

              // Set up timeout
              const timeout = setTimeout(() => {
                waitingResolve = null;
                rejectWait(
                  new Error(
                    `Timeout waiting for "${expectedType}" message. Buffer: ${buffer.map((m) => m.type).join(", ") || "(empty)"}`,
                  ),
                );
              }, 5000);

              // Wait for messages, skipping ignored ones
              const waitForNext = () => {
                waitingResolve = (msg: ServerMessage) => {
                  if (processMessage(msg)) {
                    clearTimeout(timeout);
                  } else {
                    // Message was ignored, wait for next
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

/**
 * Sends a move from one socket and waits for both sockets to receive the state update.
 * Verifies both sockets received the same state and that the move was applied correctly.
 * Returns the state from the first socket.
 */
async function sendMoveAndWaitForState(
  senderSocketIdx: 0 | 1,
  allSockets: [TestSocket, TestSocket],
  moveNotation: string,
  boardHeight: number,
): Promise<Extract<ServerMessage, { type: "state" }>["state"]> {
  const move = moveFromStandardNotation(moveNotation, boardHeight);

  const senderSocket = allSockets[senderSocketIdx];
  senderSocket.ws.send(
    JSON.stringify({
      type: "submit-move",
      move,
    }),
  );

  const [stateA, stateB] = await Promise.all([
    allSockets[0].waitForMessage("state", { ignore: ["match-status"] }),
    allSockets[1].waitForMessage("state", { ignore: ["match-status"] }),
  ]);

  expect(stateA.state).toEqual(stateB.state);

  // Verify each action in the move was applied correctly
  // After a move, state.turn switches to the other player, so the mover is the opposite
  const playerId = stateA.state.turn === 1 ? "2" : "1";
  for (const action of move.actions) {
    if (action.type === "cat") {
      expect(stateA.state.pawns[playerId].cat).toEqual(action.target);
    } else if (action.type === "mouse") {
      expect(stateA.state.pawns[playerId].mouse).toEqual(action.target);
    } else if (action.type === "wall") {
      const matchingWall = stateA.state.walls.find(
        (w) =>
          w.cell[0] === action.target[0] &&
          w.cell[1] === action.target[1] &&
          w.orientation === action.wallOrientation,
      );
      expect(matchingWall).toBeDefined();
    }
  }

  return stateA.state;
}

// ================================
// --- Main Tests ---
// ================================

describe("friend game WebSocket integration", () => {
  beforeAll(async () => {
    // Start ephemeral PostgreSQL container and run migrations
    const handle = await setupEphemeralDb();
    container = handle.container;

    // Now import server modules (they will use the ephemeral DB)
    await importServerModules();

    // Start the test server
    startTestServer();
  });

  afterAll(async () => {
    await cleanupTestUsers();
    await stopTestServer();
    await teardownEphemeralDb(container);
  });

  it("allows two players to create a friend game, join it, exchange moves, and do meta actions", async () => {
    const userA = "user-a";
    const userB = "user-b";

    // Define appearance data for testing
    const userAAppearance = {
      pawnColor: "green",
      catSkin: "cat1.svg",
      mouseSkin: "mouse5.svg",
    };
    const userBAppearance = {
      pawnColor: "blue",
      catSkin: "cat2.svg",
      mouseSkin: "mouse3.svg",
    };

    // 1. User A creates a friend game with appearance
    // The board is 3x3 (from a1 at the bottom-left to c3 at the top-right)
    /*
      C1 __ C2
      __ __ __
      M1 __ M2
    */
    const gameConfig: GameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "standard",
      rated: false,
      boardWidth: 3,
      boardHeight: 3,
    };
    // Create game with host as Player 1 (who starts first) for deterministic testing
    // In normal games, hostIsPlayer1 is randomly chosen by the host frontend
    const {
      gameId,
      shareUrl,
      socketToken: socketTokenA,
      snapshot: initialSnapshotA,
    } = await createFriendGame(userA, gameConfig, {
      appearance: userAAppearance,
      hostIsPlayer1: true,
    });
    expect(gameId).toBeDefined();
    expect(shareUrl).toBeDefined();
    expect(socketTokenA).toBeDefined();
    expect(initialSnapshotA.players[0].appearance).toEqual(userAAppearance);

    // 2. User B joins the game with appearance
    const { socketToken: socketTokenB, snapshot: joinSnapshotB } =
      await joinFriendGame(userB, gameId, userBAppearance);
    expect(socketTokenB).toBeDefined();
    expect(joinSnapshotB.players[0].appearance).toEqual(userAAppearance); // Host appearance
    expect(joinSnapshotB.players[1].appearance).toEqual(userBAppearance); // Joiner appearance

    // 3. Both connect via WebSocket
    const socketA = await openGameSocket(userA, gameId, socketTokenA);
    const socketB = await openGameSocket(userB, gameId, socketTokenB);

    // Wait for initial match status and state (match-status comes first on connect)
    const matchStatusMsgA = await socketA.waitForMessage("match-status");
    const stateMsgA = await socketA.waitForMessage("state");
    const matchStatusMsgB = await socketB.waitForMessage("match-status");
    const stateMsgB = await socketB.waitForMessage("state");

    const initialState = stateMsgA.state;
    expect(initialState).toBeDefined();
    expect(stateMsgB.state).toEqual(initialState);

    // Verify both clients receive correct player appearances
    expect(matchStatusMsgA.snapshot.players[0].appearance).toEqual(
      userAAppearance,
    ); // Host
    expect(matchStatusMsgA.snapshot.players[1].appearance).toEqual(
      userBAppearance,
    ); // Joiner
    expect(matchStatusMsgB.snapshot.players[0].appearance).toEqual(
      userAAppearance,
    ); // Host
    expect(matchStatusMsgB.snapshot.players[1].appearance).toEqual(
      userBAppearance,
    ); // Joiner

    // 4. User A (Player 1) sends first move - move cat from a3 to b2
    // Player 1 starts, and their cat starts at a3 (top-left)
    /* __ __ C2
       __ C1 __
       M1 __ M2
    */
    await sendMoveAndWaitForState(0, [socketA, socketB], "Cb2", 3);

    // 5. User B (Player 2) sends a move - move cat from c3 to b2
    /* __ _____ __
       __ C1/C2 __
       M1 _____ M2
    */
    await sendMoveAndWaitForState(1, [socketA, socketB], "Cb2", 3);

    socketA.close();
    socketB.close();
  });

  it("allows two players to create a matchmaking game, join via lobby, and see pawn styles", async () => {
    const userA = "user-a";
    const userB = "user-b";

    // Define appearance data for testing
    const userAAppearance = {
      pawnColor: "red",
      catSkin: "cat3.svg",
      mouseSkin: "mouse1.svg",
    };
    const userBAppearance = {
      pawnColor: "blue",
      catSkin: "cat4.svg",
      mouseSkin: "mouse2.svg",
    };

    // 1. User A creates a matchmaking game with appearance
    const gameConfig: GameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "standard",
      rated: false,
      boardWidth: 9,
      boardHeight: 9,
    };
    // Create game with host as Player 1 for deterministic testing
    const {
      gameId,
      socketToken: socketTokenA,
      snapshot: initialSnapshotA,
    } = await createMatchmakingGame(userA, gameConfig, {
      appearance: userAAppearance,
      hostIsPlayer1: true,
    });
    expect(gameId).toBeDefined();
    expect(socketTokenA).toBeDefined();
    expect(initialSnapshotA.players[0].appearance).toEqual(userAAppearance);

    // 2. User B fetches available matchmaking games and joins one
    const availableGames = await fetchMatchmakingGames();
    expect(availableGames.length).toBeGreaterThan(0);

    // Find the game created by user A
    const gameToJoin = availableGames.find((game) => game.id === gameId);
    expect(gameToJoin).toBeDefined();
    expect(gameToJoin?.players[0].appearance).toEqual(userAAppearance);

    const { socketToken: socketTokenB, snapshot: joinSnapshotB } =
      await joinFriendGame(userB, gameId, userBAppearance);
    expect(socketTokenB).toBeDefined();
    expect(joinSnapshotB.players[0].appearance).toEqual(userAAppearance); // Host appearance
    expect(joinSnapshotB.players[1].appearance).toEqual(userBAppearance); // Joiner appearance

    // 3. Both connect via WebSocket
    const socketA = await openGameSocket(userA, gameId, socketTokenA);
    const socketB = await openGameSocket(userB, gameId, socketTokenB);

    // Wait for initial match status and state (match-status comes first on connect)
    const matchStatusMsgA = await socketA.waitForMessage("match-status");
    const stateMsgA = await socketA.waitForMessage("state");
    const matchStatusMsgB = await socketB.waitForMessage("match-status");
    const stateMsgB = await socketB.waitForMessage("state");

    const initialState = stateMsgA.state;
    expect(initialState).toBeDefined();
    expect(stateMsgB.state).toEqual(initialState);

    // Verify both clients receive correct player appearances
    expect(matchStatusMsgA.snapshot.players[0].appearance).toEqual(
      userAAppearance,
    ); // Host
    expect(matchStatusMsgA.snapshot.players[1].appearance).toEqual(
      userBAppearance,
    ); // Joiner
    expect(matchStatusMsgB.snapshot.players[0].appearance).toEqual(
      userAAppearance,
    ); // Host
    expect(matchStatusMsgB.snapshot.players[1].appearance).toEqual(
      userBAppearance,
    ); // Joiner

    socketA.close();
    socketB.close();
  });

  it("ensures each player receives the other player's ELO during setup", async () => {
    // Use unique user IDs for this test to avoid conflicts
    const userA = "user-elo-a";
    const userB = "user-elo-b";

    // Define ELO ratings for both players
    const userAElo = 1500;
    const userBElo = 1350;

    // Seed test users with ELO ratings in the database
    await seedTestUser(userA, {
      variant: "standard",
      timeControl: "rapid",
      rating: userAElo,
    });
    await seedTestUser(userB, {
      variant: "standard",
      timeControl: "rapid",
      rating: userBElo,
    });

    // 1. User A creates a friend game
    const gameConfig: GameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "standard",
      rated: true,
      boardWidth: 9,
      boardHeight: 9,
    };

    const {
      gameId,
      socketToken: socketTokenA,
      snapshot: initialSnapshotA,
    } = await createFriendGame(userA, gameConfig, {
      hostIsPlayer1: true,
    });
    expect(gameId).toBeDefined();
    expect(socketTokenA).toBeDefined();
    // Host's ELO should be included in the snapshot
    expect(initialSnapshotA.players[0].elo).toBe(userAElo);

    // 2. User B joins the game
    const { socketToken: socketTokenB, snapshot: joinSnapshotB } =
      await joinFriendGame(userB, gameId);
    expect(socketTokenB).toBeDefined();
    // Both players' ELO should be in the join response
    expect(joinSnapshotB.players[0].elo).toBe(userAElo); // Host ELO
    expect(joinSnapshotB.players[1].elo).toBe(userBElo); // Joiner ELO

    // 3. Both connect via WebSocket
    const socketA = await openGameSocket(userA, gameId, socketTokenA);
    const socketB = await openGameSocket(userB, gameId, socketTokenB);

    // Wait for initial match status (match-status comes first on connect)
    const matchStatusMsgA = await socketA.waitForMessage("match-status");
    await socketA.waitForMessage("state");
    const matchStatusMsgB = await socketB.waitForMessage("match-status");
    await socketB.waitForMessage("state");

    // Verify both clients receive both players' ELO ratings via WebSocket
    // Host (Player A) should see their own ELO and opponent's ELO
    expect(matchStatusMsgA.snapshot.players[0].elo).toBe(userAElo); // Host ELO
    expect(matchStatusMsgA.snapshot.players[1].elo).toBe(userBElo); // Joiner ELO

    // Joiner (Player B) should see their own ELO and opponent's ELO
    expect(matchStatusMsgB.snapshot.players[0].elo).toBe(userAElo); // Host ELO
    expect(matchStatusMsgB.snapshot.players[1].elo).toBe(userBElo); // Joiner ELO

    socketA.close();
    socketB.close();
  });

  it("supports draw offers, rejections, acceptance, and rematch functionality", async () => {
    const userA = "user-a";
    const userB = "user-b";

    // Create and join a new game for draw/rematch testing
    const gameConfig: GameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "standard",
      rated: false,
      boardWidth: 9,
      boardHeight: 9,
    };
    // Create game with host as Player 1 for deterministic testing
    const { gameId, socketToken: socketTokenA } = await createFriendGame(
      userA,
      gameConfig,
      { hostIsPlayer1: true },
    );

    const { socketToken: socketTokenB } = await joinFriendGame(userB, gameId);

    const socketA = await openGameSocket(userA, gameId, socketTokenA);
    const socketB = await openGameSocket(userB, gameId, socketTokenB);

    // Wait for initial match status and state (match-status comes first on connect)
    await socketA.waitForMessage("match-status");
    await socketA.waitForMessage("state");
    await socketB.waitForMessage("match-status");
    await socketB.waitForMessage("state");

    // Make some moves to have an active game
    // Player 1 moves cat from a9 to b8
    await sendMoveAndWaitForState(
      0,
      [socketA, socketB],
      "Cb8",
      gameConfig.boardHeight,
    );

    // Test draw offer and rejection
    const drawOfferPayload: ClientMessage = {
      type: "draw-offer",
    };
    socketA.ws.send(JSON.stringify(drawOfferPayload));

    const drawOfferMsg = await socketB.waitForMessage("draw-offer", {
      ignore: ["match-status"],
    });
    expect(drawOfferMsg.playerId).toBe(1);

    const drawRejectPayload: ClientMessage = {
      type: "draw-reject",
    };
    socketB.ws.send(JSON.stringify(drawRejectPayload));

    const drawRejectMsg = await socketA.waitForMessage("draw-rejected", {
      ignore: ["match-status", "draw-offer"],
    });
    expect(drawRejectMsg.playerId).toBe(2);

    // Test draw offer and acceptance
    socketA.ws.send(JSON.stringify(drawOfferPayload));

    await socketB.waitForMessage("draw-offer", {
      ignore: ["match-status", "draw-rejected"],
    });

    const drawAcceptPayload: ClientMessage = {
      type: "draw-accept",
    };
    socketB.ws.send(JSON.stringify(drawAcceptPayload));

    const drawEndMsg = await socketA.waitForMessage("state", {
      ignore: ["match-status", "draw-offer"],
    });
    expect(drawEndMsg.state.status).toBe("finished");
    expect(drawEndMsg.state.result?.reason).toBe("draw-agreement");

    // Test rematch offer and acceptance
    const rematchOfferPayload: ClientMessage = {
      type: "rematch-offer",
    };
    socketA.ws.send(JSON.stringify(rematchOfferPayload));

    const rematchOfferMsg = await socketB.waitForMessage("rematch-offer", {
      ignore: ["match-status", "state"],
    });
    expect(rematchOfferMsg.playerId).toBe(1);

    const rematchAcceptPayload: ClientMessage = {
      type: "rematch-accept",
    };
    socketB.ws.send(JSON.stringify(rematchAcceptPayload));

    // Wait for both sockets to receive the new game state after rematch
    const [rematchStateMsgA, rematchStateMsgB] = await Promise.all([
      socketA.waitForMessage("state", {
        ignore: ["match-status", "rematch-offer"],
      }),
      socketB.waitForMessage("state", {
        ignore: ["match-status", "rematch-offer"],
      }),
    ]);
    expect(rematchStateMsgA.state.status).toBe("playing");
    expect(rematchStateMsgA.state.moveCount).toBe(1);
    expect(rematchStateMsgA.state).toEqual(rematchStateMsgB.state);

    // Make a move in the new game
    // Player 1 moves cat from a9 to b8
    await sendMoveAndWaitForState(
      0,
      [socketA, socketB],
      "Cb8",
      gameConfig.boardHeight,
    );

    // Test rematch rejection
    const resignPayload: ClientMessage = {
      type: "resign",
    };
    socketB.ws.send(JSON.stringify(resignPayload));

    const resignEndMsg = await socketA.waitForMessage("state", {
      ignore: ["match-status"],
    });
    expect(resignEndMsg.state.status).toBe("finished");

    socketA.ws.send(JSON.stringify(rematchOfferPayload));
    await socketB.waitForMessage("rematch-offer", {
      ignore: ["match-status", "state"],
    });

    const rematchRejectPayload: ClientMessage = {
      type: "rematch-reject",
    };
    socketB.ws.send(JSON.stringify(rematchRejectPayload));

    const rematchRejectMsg = await socketA.waitForMessage("rematch-rejected", {
      ignore: ["match-status", "rematch-offer"],
    });
    expect(rematchRejectMsg.playerId).toBe(2);

    socketA.close();
    socketB.close();
  });
});
