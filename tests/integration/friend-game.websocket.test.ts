/**
 * Integration tests for friend game WebSocket functionality.
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
  MatchmakingGamesResponse,
} from "../../shared/contracts/games";
import type {
  ActionRequestMessage,
  ServerMessage,
} from "../../shared/contracts/websocket-messages";
import type {
  GameConfiguration,
  PlayerAppearance,
} from "../../shared/domain/game-types";
import {
  cellFromStandardNotation,
  moveFromStandardNotation,
} from "../../shared/domain/standard-notation";
import { newRatingsAfterGame, Outcome } from "../../server/games/rating-system";
import type {
  ActionRequestPayload,
  ControllerActionKind,
} from "../../shared/contracts/controller-actions";

// ================================
// --- Test Harness ---
// ================================

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

// These will be dynamically imported after DB is set up
let db: typeof import("../../server/db").db;
let createApp: typeof import("../../server/index").createApp;
let usersTable: typeof import("../../server/db/schema/users").usersTable;
let userAuthTable: typeof import("../../server/db/schema/users").userAuthTable;
let ratingsTable: typeof import("../../server/db/schema/ratings").ratingsTable;
let eq: typeof import("drizzle-orm").eq;

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
    await server.stop(true); // Force close all connections
  }
}

// ================================
// --- Database Seeding Helpers ---
// ================================

/** Track seeded user IDs for cleanup */
const seededUserIds: number[] = [];

/**
 * Seeds a test user with a Glicko-2 rating in the database.
 * The authUserId should match the x-test-user-id header used in requests.
 */
async function seedTestUser(
  authUserId: string,
  options: {
    variant: string;
    timeControl: string;
    rating: number;
    ratingDeviation: number;
    volatility: number;
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

  // Create rating with full Glicko-2 state
  await db.insert(ratingsTable).values({
    userId: user.userId,
    variant: options.variant,
    timeControl: options.timeControl,
    rating: options.rating,
    ratingDeviation: options.ratingDeviation,
    volatility: options.volatility,
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

interface TestSocket {
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
          options?: {
            ignore?: ServerMessage["type"][];
            preserveIgnored?: boolean;
          },
        ) => {
          const ignoreTypes = options?.ignore ?? [];
          const preserveIgnored = options?.preserveIgnored ?? false;
          const preservedMessages: ServerMessage[] = [];

          const restorePreservedMessages = () => {
            if (!preserveIgnored || preservedMessages.length === 0) {
              return;
            }
            for (let i = preservedMessages.length - 1; i >= 0; i--) {
              buffer.unshift(preservedMessages[i]);
            }
            preservedMessages.length = 0;
          };

          return new Promise<Extract<ServerMessage, { type: T }>>(
            (resolveWait, rejectWait) => {
              const processMessage = (msg: ServerMessage): boolean => {
                if (msg.type === expectedType) {
                  restorePreservedMessages();
                  resolveWait(msg as Extract<ServerMessage, { type: T }>);
                  return true; // Handled
                } else if (ignoreTypes.includes(msg.type)) {
                  if (preserveIgnored) {
                    preservedMessages.push(msg);
                  }
                  return false; // Skip, keep waiting
                } else {
                  restorePreservedMessages();
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
                restorePreservedMessages();
                rejectWait(
                  new Error(
                    `Timeout waiting for "${expectedType}" message. Buffer: ${
                      buffer.map((m) => m.type).join(", ") || "(empty)"
                    }`,
                  ),
                );
              }, 5000);

              // Wait for messages, skipping ignored ones
              const waitForNext = () => {
                waitingResolve = (msg: ServerMessage) => {
                  if (processMessage(msg)) {
                    clearTimeout(timeout);
                    // preserved messages already restored in processMessage when needed
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

const ACTION_REQUEST_IGNORED_MESSAGE_TYPES: ServerMessage["type"][] = [
  "state",
  "match-status",
  "draw-offer",
  "draw-rejected",
  "takeback-offer",
  "takeback-rejected",
  "rematch-offer",
  "rematch-rejected",
];

async function sendActionRequestAndExpectAck<K extends ControllerActionKind>(
  socket: TestSocket,
  action: K,
  payload?: ActionRequestPayload<K>,
): Promise<void> {
  const requestId = randomUUID();
  const message: ActionRequestMessage<K> = {
    type: "action-request",
    requestId,
    action,
  };
  if (payload !== undefined) {
    message.payload = payload;
  }
  socket.ws.send(JSON.stringify(message));
  const ack = await socket.waitForMessage("actionAck", {
    ignore: ACTION_REQUEST_IGNORED_MESSAGE_TYPES,
    preserveIgnored: true,
  });
  expect(ack.requestId).toBe(requestId);
  expect(ack.action).toBe(action);
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

    // Define Glicko-2 rating state for both players
    // Note: DB uses ratingDeviation, but rating-system uses deviation
    const userARating = { rating: 1500, deviation: 200, volatility: 0.06 };
    const userBRating = { rating: 1350, deviation: 150, volatility: 0.05 };

    // Seed test users with Glicko-2 ratings in the database
    await seedTestUser(userA, {
      variant: "standard",
      timeControl: "rapid",
      rating: userARating.rating,
      ratingDeviation: userARating.deviation,
      volatility: userARating.volatility,
    });
    await seedTestUser(userB, {
      variant: "standard",
      timeControl: "rapid",
      rating: userBRating.rating,
      ratingDeviation: userBRating.deviation,
      volatility: userBRating.volatility,
    });

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

    // User A creates a friend game with appearance
    // The board is 3x3 (from a1 at the bottom-left to c3 at the top-right)
    /*
      C1 .. C2
      .. .. ..
      M1 .. M2
    */
    const gameConfig: GameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "standard",
      rated: true,
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
    expect(initialSnapshotA.players[0].elo).toBe(userARating.rating); // Host's rating should be included

    // User B joins the game with appearance
    const { socketToken: socketTokenB, snapshot: joinSnapshotB } =
      await joinFriendGame(userB, gameId, userBAppearance);
    expect(socketTokenB).toBeDefined();
    expect(joinSnapshotB.players[0].appearance).toEqual(userAAppearance); // Host appearance
    expect(joinSnapshotB.players[1].appearance).toEqual(userBAppearance); // Joiner appearance
    expect(joinSnapshotB.players[0].elo).toBe(userARating.rating); // Host rating
    expect(joinSnapshotB.players[1].elo).toBe(userBRating.rating); // Joiner rating

    // Both connect via WebSocket
    const socketA = await openGameSocket(userA, gameId, socketTokenA);
    const socketB = await openGameSocket(userB, gameId, socketTokenB);

    // Wait for initial state and match status (state comes first on connect)
    const stateMsgA = await socketA.waitForMessage("state");
    const matchStatusMsgA = await socketA.waitForMessage("match-status");
    const stateMsgB = await socketB.waitForMessage("state");
    const matchStatusMsgB = await socketB.waitForMessage("match-status");

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

    // Verify both clients receive correct player ratings via WebSocket
    expect(matchStatusMsgA.snapshot.players[0].elo).toBe(userARating.rating); // Host rating
    expect(matchStatusMsgA.snapshot.players[1].elo).toBe(userBRating.rating); // Joiner rating
    expect(matchStatusMsgB.snapshot.players[0].elo).toBe(userARating.rating); // Host rating
    expect(matchStatusMsgB.snapshot.players[1].elo).toBe(userBRating.rating); // Joiner rating

    // User A (Player 1) sends first move - move cat from a3 to b2
    // Player 1 starts, and their cat starts at a3 (top-left)
    /* .. .. C2
       .. C1 ..
       M1 .. M2
    */
    await sendMoveAndWaitForState(0, [socketA, socketB], "Cb2", 3);

    // User B (Player 2) sends a move - move cat from c3 to b2
    /* .. ..... ..
       .. C1/C2 ..
       M1 ..... M2
    */
    await sendMoveAndWaitForState(1, [socketA, socketB], "Cb2", 3);

    // Player 2 requests a takeback
    await sendActionRequestAndExpectAck(socketB, "requestTakeback");

    // Only the opponent (Player 1) receives the takeback offer
    const takebackOfferA = await socketA.waitForMessage("takeback-offer");
    expect(takebackOfferA.playerId).toBe(2);

    // Player 1 accepts the takeback
    socketA.ws.send(JSON.stringify({ type: "takeback-accept" }));

    // Both players receive the updated state (move undone)
    const [takebackStateA, takebackStateB] = await Promise.all([
      socketA.waitForMessage("state"),
      socketB.waitForMessage("state"),
    ]);
    expect(takebackStateA.state).toEqual(takebackStateB.state);
    // After takeback, it should be Player 2's turn again
    expect(takebackStateA.state.turn).toBe(2);
    // Player 2's cat should be back on c3
    expect(takebackStateA.state.pawns[2].cat).toEqual(
      cellFromStandardNotation("c3", 3),
    );

    // Player 2 makes the same move again
    /* .. ..... ..
       .. C1/C2 ..
       M1 ..... M2
    */
    await sendMoveAndWaitForState(1, [socketA, socketB], "Cb2", 3);

    // Player 2 requests another takeback
    await sendActionRequestAndExpectAck(socketB, "requestTakeback");

    // Only the opponent (Player 1) receives the takeback offer
    const takebackOffer2A = await socketA.waitForMessage("takeback-offer");
    expect(takebackOffer2A.playerId).toBe(2);

    // Player 1 rejects the takeback
    socketA.ws.send(JSON.stringify({ type: "takeback-reject" }));

    // Both players receive the rejection (rejections are broadcast)
    const [takebackReject2A, takebackReject2B] = await Promise.all([
      socketA.waitForMessage("takeback-rejected"),
      socketB.waitForMessage("takeback-rejected"),
    ]);
    expect(takebackReject2A.playerId).toBe(1);
    expect(takebackReject2B.playerId).toBe(1);

    // Player 2 requests yet another takeback
    await sendActionRequestAndExpectAck(socketB, "requestTakeback");

    // Only the opponent (Player 1) receives the takeback offer
    const takebackOffer3A = await socketA.waitForMessage("takeback-offer");
    expect(takebackOffer3A.playerId).toBe(2);

    // Player 1 requests a takeback while Player 2's takeback is still pending
    // Player 1 is asking to undo THEIR OWN last move (Cb2)
    await sendActionRequestAndExpectAck(socketA, "requestTakeback");

    // Only the opponent (Player 2) receives Player 1's takeback offer
    const takebackOffer4B = await socketB.waitForMessage("takeback-offer");
    expect(takebackOffer4B.playerId).toBe(1);

    // Player 2 accepts Player 1's takeback
    socketB.ws.send(JSON.stringify({ type: "takeback-accept" }));

    // Both players receive the updated state
    // Since P1 requested to undo their own move, this undoes both:
    // - Player 2's last move (Cb2) - to get back to P1's turn
    // - Player 1's last move (Cb2) - the move P1 asked to take back
    // This brings the game back to the starting position
    const [takebackState2A, takebackState2B] = await Promise.all([
      socketA.waitForMessage("state"),
      socketB.waitForMessage("state"),
    ]);
    expect(takebackState2A.state).toEqual(takebackState2B.state);
    // After takeback, it's Player 1's turn (back to start)
    expect(takebackState2A.state.turn).toBe(1);
    // Both cats should be back at their starting corners
    expect(takebackState2A.state.pawns[1].cat).toEqual(
      cellFromStandardNotation("a3", 3),
    );
    expect(takebackState2A.state.pawns[2].cat).toEqual(
      cellFromStandardNotation("c3", 3),
    );

    // Players replay the same moves
    // Player 1 moves cat from a3 to b2
    /* .. .. C2
       .. C1 ..
       M1 .. M2
    */
    await sendMoveAndWaitForState(0, [socketA, socketB], "Cb2", 3);

    // Player 2 moves cat from c3 to b2
    /* .. ..... ..
       .. C1/C2 ..
       M1 ..... M2
    */
    await sendMoveAndWaitForState(1, [socketA, socketB], "Cb2", 3);

    // User A (Player 1) sends a move - places two walls
    /* .. ..... ..
       ..|C1/C2 ..
          -----
       M1 ..... M2
    */
    await sendMoveAndWaitForState(0, [socketA, socketB], ">a2.^b1", 3);

    // User B (Player 2) sends a move - cat move and wall
    /* .. .. ..
       ..|C1 C2
       -- --
       M1 .. M2
    */
    await sendMoveAndWaitForState(1, [socketA, socketB], "Cc2.^a1", 3);

    // User A (Player 1) wins by capturing Player 2's mouse at c1
    /* .. .. ..
       ..|.. C2
       -- --
       M1 .. C1(captured M2)
    */
    const move = moveFromStandardNotation("Cc1", 3);
    socketA.ws.send(
      JSON.stringify({
        type: "submit-move",
        move,
      }),
    );

    // Both clients should receive the game-ending state
    const [finalStateA, finalStateB] = await Promise.all([
      socketA.waitForMessage("state", { ignore: ["match-status"] }),
      socketB.waitForMessage("state", { ignore: ["match-status"] }),
    ]);

    // Verify game ended with Player 1 winning
    expect(finalStateA.state.status).toBe("finished");
    expect(finalStateA.state.result?.winner).toBe(1);
    expect(finalStateA.state.result?.reason).toBe("capture");
    expect(finalStateB.state).toEqual(finalStateA.state);

    // Wait for match-status messages which contain updated ratings
    const [matchStatusA, matchStatusB] = await Promise.all([
      socketA.waitForMessage("match-status"),
      socketB.waitForMessage("match-status"),
    ]);

    // Calculate expected new ratings using the Glicko-2 system
    const expectedNewRatings = newRatingsAfterGame(
      userARating,
      userBRating,
      Outcome.Win, // Player 1 (User A) won
    );

    // Verify both clients receive the updated ratings
    // User A is the host (Player 1), User B is the joiner (Player 2)
    const hostNewRating = matchStatusA.snapshot.players[0].elo!;
    const joinerNewRating = matchStatusA.snapshot.players[1].elo!;

    expect(hostNewRating).toBeCloseTo(expectedNewRatings.a.rating, 5);
    expect(joinerNewRating).toBeCloseTo(expectedNewRatings.b.rating, 5);

    // Both clients should receive the same updated ratings
    expect(matchStatusB.snapshot.players[0].elo).toBe(hostNewRating);
    expect(matchStatusB.snapshot.players[1].elo).toBe(joinerNewRating);

    // Sanity check: winner's rating should increase, loser's should decrease
    expect(hostNewRating).toBeGreaterThan(userARating.rating);
    expect(joinerNewRating).toBeLessThan(userBRating.rating);

    // Test rematch - Player A offers, Player B accepts
    await sendActionRequestAndExpectAck(socketA, "offerRematch");

    // Only the opponent (Player B) receives the rematch offer
    const rematchOfferMsgB = await socketB.waitForMessage("rematch-offer");
    expect(rematchOfferMsgB.playerId).toBe(1);

    await sendActionRequestAndExpectAck(socketB, "respondRematch", {
      decision: "accepted",
    });

    // Wait for both sockets to receive the new game state after rematch
    const [rematchStateA, rematchStateB] = await Promise.all([
      socketA.waitForMessage("state", {
        ignore: ["match-status", "rematch-offer"],
      }),
      socketB.waitForMessage("state", {
        ignore: ["match-status", "rematch-offer"],
      }),
    ]);
    expect(rematchStateA.state.status).toBe("playing");
    expect(rematchStateA.state.moveCount).toBe(1);
    expect(rematchStateA.state).toEqual(rematchStateB.state);

    // Wait for match-status to verify player roles have swapped
    const [rematchStatusA, rematchStatusB] = await Promise.all([
      socketA.waitForMessage("match-status"),
      socketB.waitForMessage("match-status"),
    ]);

    // After rematch, Player B (joiner) should now be Player 1 (goes first)
    // players[0] is still the host (User A), players[1] is still the joiner (User B)
    expect(rematchStatusA.snapshot.players[0].playerId).toBe(2); // Host is now Player 2
    expect(rematchStatusA.snapshot.players[1].playerId).toBe(1); // Joiner is now Player 1
    expect(rematchStatusB.snapshot).toEqual(rematchStatusA.snapshot);

    // Player B (now Player 1) makes the first move
    // Since player IDs swapped, socketB (User B) is now Player 1
    // Move cat from a3 (Player 1's starting corner) to b2
    /* .. .. C2
       .. C1 ..
       M1 .. M2
    */
    await sendMoveAndWaitForState(1, [socketA, socketB], "Cb2", 3);

    // Player A (now Player 2) makes a move
    /* .. ..... ..
       .. C1/C2 ..
       M1 ..... M2
    */
    await sendMoveAndWaitForState(0, [socketA, socketB], "Cb2", 3);

    // Both players offer draws in parallel
    await sendActionRequestAndExpectAck(socketA, "offerDraw");
    await sendActionRequestAndExpectAck(socketB, "offerDraw");

    // Each socket receives only the opponent's offer (not their own)
    const [drawOfferFromB, drawOfferFromA] = await Promise.all([
      socketA.waitForMessage("draw-offer"),
      socketB.waitForMessage("draw-offer"),
    ]);
    expect(drawOfferFromB.playerId).toBe(1); // A receives B's offer (B is now P1)
    expect(drawOfferFromA.playerId).toBe(2); // B receives A's offer (A is now P2)

    // One player rejects, the other accepts
    // Player A rejects (B's offer), Player B accepts (A's offer) → Draw happens
    socketA.ws.send(JSON.stringify({ type: "draw-reject" }));
    socketB.ws.send(JSON.stringify({ type: "draw-accept" }));

    // Both players receive the draw result
    const [drawState2A, drawState2B] = await Promise.all([
      socketA.waitForMessage("state", {
        ignore: ["match-status", "draw-offer", "draw-rejected"],
      }),
      socketB.waitForMessage("state", {
        ignore: ["match-status", "draw-offer", "draw-rejected"],
      }),
    ]);
    expect(drawState2A.state.status).toBe("finished");
    expect(drawState2A.state.result?.reason).toBe("draw-agreement");
    expect(drawState2A.state).toEqual(drawState2B.state);

    // Wait for match-status messages which contain updated ratings after draw
    const [drawMatchStatusA, drawMatchStatusB] = await Promise.all([
      socketA.waitForMessage("match-status"),
      socketB.waitForMessage("match-status"),
    ]);

    // Verify updated ratings after draw
    // players[0] is host (User A), players[1] is joiner (User B)
    const hostRatingAfterDraw = drawMatchStatusA.snapshot.players[0].elo!;
    const joinerRatingAfterDraw = drawMatchStatusA.snapshot.players[1].elo!;

    // Both clients should receive the same updated ratings
    expect(drawMatchStatusB.snapshot.players[0].elo).toBe(hostRatingAfterDraw);
    expect(drawMatchStatusB.snapshot.players[1].elo).toBe(
      joinerRatingAfterDraw,
    );

    // Verify ratings changed from post-game-1 values
    expect(hostRatingAfterDraw).not.toBe(hostNewRating);
    expect(joinerRatingAfterDraw).not.toBe(joinerNewRating);

    // In a draw, the higher-rated player loses rating, lower-rated gains
    // After game 1, host (A) had higher rating than joiner (B)
    expect(hostRatingAfterDraw).toBeLessThan(hostNewRating);
    expect(joinerRatingAfterDraw).toBeGreaterThan(joinerNewRating);

    // Both players offer rematch
    await sendActionRequestAndExpectAck(socketA, "offerRematch");
    await sendActionRequestAndExpectAck(socketB, "offerRematch");

    // Each socket receives only the opponent's offer (not their own)
    const [rematchOfferFromB, rematchOfferFromA] = await Promise.all([
      socketA.waitForMessage("rematch-offer"),
      socketB.waitForMessage("rematch-offer"),
    ]);
    expect(rematchOfferFromB.playerId).toBe(1); // A receives B's offer (B is now P1)
    expect(rematchOfferFromA.playerId).toBe(2); // B receives A's offer (A is now P2)

    // One player accepts
    await sendActionRequestAndExpectAck(socketB, "respondRematch", {
      decision: "accepted",
    });

    // Wait for new game state after second rematch
    const [rematch2StateA, rematch2StateB] = await Promise.all([
      socketA.waitForMessage("state", {
        ignore: ["match-status", "rematch-offer"],
      }),
      socketB.waitForMessage("state", {
        ignore: ["match-status", "rematch-offer"],
      }),
    ]);
    expect(rematch2StateA.state.status).toBe("playing");
    expect(rematch2StateA.state.moveCount).toBe(1);
    expect(rematch2StateA.state).toEqual(rematch2StateB.state);

    // Wait for match-status to verify player roles have swapped back
    const [rematch2StatusA, rematch2StatusB] = await Promise.all([
      socketA.waitForMessage("match-status"),
      socketB.waitForMessage("match-status"),
    ]);

    // After second rematch, Host (User A) should be Player 1 again
    expect(rematch2StatusA.snapshot.players[0].playerId).toBe(1); // Host is Player 1 again
    expect(rematch2StatusA.snapshot.players[1].playerId).toBe(2); // Joiner is Player 2 again
    expect(rematch2StatusB.snapshot).toEqual(rematch2StatusA.snapshot);

    // Host (Player 1) makes the first move in game 3
    /* .. .. C2
       .. C1 ..
       M1 .. M2
    */
    await sendMoveAndWaitForState(0, [socketA, socketB], "Cb2", 3);

    // Host resigns game 3
    await sendActionRequestAndExpectAck(socketA, "resign");

    // Both players receive the game end state
    const [resignStateA, resignStateB] = await Promise.all([
      socketA.waitForMessage("state", { ignore: ["match-status"] }),
      socketB.waitForMessage("state", { ignore: ["match-status"] }),
    ]);
    expect(resignStateA.state.status).toBe("finished");
    expect(resignStateA.state.result?.reason).toBe("resignation");
    expect(resignStateA.state.result?.winner).toBe(2); // Joiner wins
    expect(resignStateA.state).toEqual(resignStateB.state);

    // Both players offer rematch
    await sendActionRequestAndExpectAck(socketA, "offerRematch");
    await sendActionRequestAndExpectAck(socketB, "offerRematch");

    // Each socket receives only the opponent's offer
    await Promise.all([
      socketA.waitForMessage("rematch-offer", {
        ignore: ["match-status", "state"],
      }),
      socketB.waitForMessage("rematch-offer", {
        ignore: ["match-status", "state"],
      }),
    ]);

    // One player accepts
    await sendActionRequestAndExpectAck(socketA, "respondRematch", {
      decision: "accepted",
    });

    // Wait for new game state after third rematch
    const [rematch3StateA, rematch3StateB] = await Promise.all([
      socketA.waitForMessage("state", {
        ignore: ["match-status", "rematch-offer"],
      }),
      socketB.waitForMessage("state", {
        ignore: ["match-status", "rematch-offer"],
      }),
    ]);
    expect(rematch3StateA.state.status).toBe("playing");
    expect(rematch3StateA.state.moveCount).toBe(1);
    expect(rematch3StateA.state).toEqual(rematch3StateB.state);

    // Wait for match-status to verify player roles have swapped again
    const [rematch3StatusA, rematch3StatusB] = await Promise.all([
      socketA.waitForMessage("match-status"),
      socketB.waitForMessage("match-status"),
    ]);

    // After third rematch, Joiner (User B) should be Player 1
    expect(rematch3StatusA.snapshot.players[0].playerId).toBe(2); // Host is Player 2
    expect(rematch3StatusA.snapshot.players[1].playerId).toBe(1); // Joiner is Player 1
    expect(rematch3StatusB.snapshot).toEqual(rematch3StatusA.snapshot);

    // Joiner (now Player 1) makes the first move in game 4
    /* .. .. C2
       .. C1 ..
       M1 .. M2
    */
    await sendMoveAndWaitForState(1, [socketA, socketB], "Cb2", 3);

    // Player 2 (Host) moves cat to b2
    /* .. ..... ..
       .. C1/C2 ..
       M1 ..... M2
    */
    await sendMoveAndWaitForState(0, [socketA, socketB], "Cb2", 3);

    // Player 1 (Joiner) moves cat to c1 - triggers 1-move rule draw
    /* .. .. C2
       .. .. ..
       M1 C1 M2
    */
    socketB.ws.send(
      JSON.stringify({
        type: "submit-move",
        move: moveFromStandardNotation("Cc1", 3),
      }),
    );

    // Game ends in draw due to 1-move rule
    const [drawRuleStateA, drawRuleStateB] = await Promise.all([
      socketA.waitForMessage("state", { ignore: ["match-status"] }),
      socketB.waitForMessage("state", { ignore: ["match-status"] }),
    ]);
    expect(drawRuleStateA.state.status).toBe("finished");
    expect(drawRuleStateA.state.result?.reason).toBe("one-move-rule");
    expect(drawRuleStateA.state).toEqual(drawRuleStateB.state);

    // One player offers rematch, the other accepts
    await sendActionRequestAndExpectAck(socketA, "offerRematch");

    await socketB.waitForMessage("rematch-offer", {
      ignore: ["match-status", "state"],
    });

    await sendActionRequestAndExpectAck(socketB, "respondRematch", {
      decision: "accepted",
    });

    // Wait for new game state after fourth rematch
    const [rematch4StateA, rematch4StateB] = await Promise.all([
      socketA.waitForMessage("state", {
        ignore: ["match-status", "rematch-offer"],
      }),
      socketB.waitForMessage("state", {
        ignore: ["match-status", "rematch-offer"],
      }),
    ]);
    expect(rematch4StateA.state.status).toBe("playing");
    expect(rematch4StateA.state.moveCount).toBe(1);
    expect(rematch4StateA.state).toEqual(rematch4StateB.state);

    // Wait for match-status to verify player roles
    const [rematch4StatusA, rematch4StatusB] = await Promise.all([
      socketA.waitForMessage("match-status"),
      socketB.waitForMessage("match-status"),
    ]);

    // After fourth rematch, Host (User A) should be Player 1 again
    expect(rematch4StatusA.snapshot.players[0].playerId).toBe(1); // Host is Player 1
    expect(rematch4StatusA.snapshot.players[1].playerId).toBe(2); // Joiner is Player 2
    expect(rematch4StatusB.snapshot).toEqual(rematch4StatusA.snapshot);

    // Host (Player 1) makes the first move in game 5
    /* .. .. C2
       .. C1 ..
       M1 .. M2
    */
    await sendMoveAndWaitForState(0, [socketA, socketB], "Cb2", 3);

    // Player 1 offers draw, Player 2 rejects
    await sendActionRequestAndExpectAck(socketA, "offerDraw");

    const drawOffer5B = await socketB.waitForMessage("draw-offer");
    expect(drawOffer5B.playerId).toBe(1);

    socketB.ws.send(JSON.stringify({ type: "draw-reject" }));

    const [drawReject5A, drawReject5B] = await Promise.all([
      socketA.waitForMessage("draw-rejected"),
      socketB.waitForMessage("draw-rejected"),
    ]);
    expect(drawReject5A.playerId).toBe(2);
    expect(drawReject5B.playerId).toBe(2);

    // Player 1 gives 30 seconds to Player 2
    await sendActionRequestAndExpectAck(socketA, "giveTime", { seconds: 30 });

    // Both players receive updated state with the new time
    const [giveTimeStateA, giveTimeStateB] = await Promise.all([
      socketA.waitForMessage("state"),
      socketB.waitForMessage("state"),
    ]);
    expect(giveTimeStateA.state).toEqual(giveTimeStateB.state);
    // Player 2's time should have increased (we just verify the state was broadcast)
    expect(giveTimeStateA.state.status).toBe("playing");

    // Player 2 makes suicidal move "Mb2" - moving mouse onto cat loses the game
    /* .. .. C2
       .. C1 ..
       .. M1 M2   <- M1 moves to b2, lands on C1, loses
    */
    socketB.ws.send(
      JSON.stringify({
        type: "submit-move",
        move: moveFromStandardNotation("Mb2", 3),
      }),
    );

    // Game ends - Player 2 loses by moving mouse onto cat
    const [suicideStateA, suicideStateB] = await Promise.all([
      socketA.waitForMessage("state", { ignore: ["match-status"] }),
      socketB.waitForMessage("state", { ignore: ["match-status"] }),
    ]);
    expect(suicideStateA.state.status).toBe("finished");
    expect(suicideStateA.state.result?.winner).toBe(1); // Player 1 wins
    expect(suicideStateA.state.result?.reason).toBe("capture");
    expect(suicideStateA.state).toEqual(suicideStateB.state);

    // Player 1 offers rematch, Player 2 rejects
    await sendActionRequestAndExpectAck(socketA, "offerRematch");

    const rematchOffer5B = await socketB.waitForMessage("rematch-offer", {
      ignore: ["match-status", "state"],
    });
    expect(rematchOffer5B.playerId).toBe(1);

    await sendActionRequestAndExpectAck(socketB, "respondRematch", {
      decision: "declined",
    });

    // Need to ignore match-status from the game-ending move
    const [rematchReject5A, rematchReject5B] = await Promise.all([
      socketA.waitForMessage("rematch-rejected", { ignore: ["match-status"] }),
      socketB.waitForMessage("rematch-rejected", { ignore: ["match-status"] }),
    ]);
    expect(rematchReject5A.playerId).toBe(2);
    expect(rematchReject5B.playerId).toBe(2);

    socketA.close();
    socketB.close();
  }, 60000);

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

    // Wait for initial state and match status (state comes first on connect)
    const stateMsgA = await socketA.waitForMessage("state");
    const matchStatusMsgA = await socketA.waitForMessage("match-status");
    const stateMsgB = await socketB.waitForMessage("state");
    const matchStatusMsgB = await socketB.waitForMessage("match-status");

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
  }, 30000);
});
