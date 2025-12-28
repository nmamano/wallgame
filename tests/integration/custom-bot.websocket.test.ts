/**
 * Integration tests for custom bot WebSocket functionality.
 *
 * Uses Testcontainers to spin up an ephemeral PostgreSQL database.
 * No manual database setup required - just Docker.
 *
 *
 * 1. Creates game with joinerConfig: { type: "custom-bot" }
 * 2. Marks host ready
 * 3. Human connects via regular game WebSocket
 * 4. Bot connects via /ws/custom-bot and sends attach with seat token
 * 5. Handles dynamic turn order (checks who is Player 1)
 * 6. Plays 2 moves (one each)
 * 7. Human offers draw → Bot receives request with kind: "draw" → Bot declines → Human receives draw-rejected
 * 8. Plays 2 more moves
 * 9. Human offers draw → Bot accepts → Game ends with draw-agreement
 * 10. Human offers rematch → Bot receives request with kind: "rematch" → Bot accepts → Both receive rematch-started
 * 11. Human reconnects to new game, bot continues with same connection
 * 12. Plays 2 moves on rematch game
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type { GameCreateResponse } from "../../shared/contracts/games";
import type { ServerMessage } from "../../shared/contracts/websocket-messages";
import type { GameConfiguration } from "../../shared/domain/game-types";
import type {
  CustomBotServerMessage,
  CustomBotClientMessage,
  BotResponseAction,
} from "../../shared/contracts/custom-bot-protocol";

// ================================
// --- Test Harness ---
// ================================

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

// These will be dynamically imported after DB is set up
let createApp: typeof import("../../server/index").createApp;

async function importServerModules() {
  const serverModule = await import("../../server/index");
  createApp = serverModule.createApp;
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
    await server.stop(true);
  }
}

// ================================
// --- HTTP Client Helpers ---
// ================================

/**
 * Creates a game with a custom bot as the joiner.
 */
async function createGameWithCustomBot(
  userId: string,
  config: GameConfiguration,
  options?: {
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
      config,
      matchType: "friend",
      hostDisplayName: `Player ${userId}`,
      hostIsPlayer1: options?.hostIsPlayer1,
      joinerConfig: {
        type: "custom-bot",
        displayName: "Test Bot",
      },
    }),
  });

  if (res.status !== 201) {
    const text = await res.text();
    throw new Error(
      `Expected status 201 but got ${res.status}. Error: ${text}`,
    );
  }
  return (await res.json()) as GameCreateResponse;
}

/**
 * Marks the host as ready (required before game starts).
 */
async function markHostReady(
  userId: string,
  gameId: string,
  hostToken: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/games/${gameId}/ready`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    body: JSON.stringify({ token: hostToken }),
  });

  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(
      `Expected status 200 but got ${res.status}. Error: ${text}`,
    );
  }
}

// ================================
// --- Human Player WebSocket ---
// ================================

interface HumanSocket {
  ws: WebSocket;
  waitForMessage: <T extends ServerMessage["type"]>(
    expectedType: T,
    options?: { ignore?: ServerMessage["type"][] },
  ) => Promise<Extract<ServerMessage, { type: T }>>;
  close: () => void;
}

async function openHumanSocket(
  userId: string,
  gameId: string,
  socketToken: string,
): Promise<HumanSocket> {
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

        waitForMessage: <T extends ServerMessage["type"]>(
          expectedType: T,
          options?: { ignore?: ServerMessage["type"][] },
        ) => {
          const ignoreTypes = ["welcome", ...(options?.ignore ?? [])];

          return new Promise<Extract<ServerMessage, { type: T }>>(
            (resolveWait, rejectWait) => {
              const processMessage = (msg: ServerMessage): boolean => {
                if (msg.type === expectedType) {
                  resolveWait(msg as Extract<ServerMessage, { type: T }>);
                  return true;
                } else if (ignoreTypes.includes(msg.type)) {
                  return false;
                } else {
                  rejectWait(
                    new Error(
                      `Expected "${expectedType}" but got "${
                        msg.type
                      }". Message: ${JSON.stringify(msg)}`,
                    ),
                  );
                  return true;
                }
              };

              while (buffer.length > 0) {
                const msg = buffer.shift()!;
                if (processMessage(msg)) return;
              }

              const timeout = setTimeout(() => {
                waitingResolve = null;
                rejectWait(
                  new Error(
                    `Timeout waiting for "${expectedType}". Buffer: ${
                      buffer.map((m) => m.type).join(", ") || "(empty)"
                    }`,
                  ),
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

// ================================
// --- Custom Bot WebSocket ---
// ================================

interface BotSocket {
  ws: WebSocket;
  waitForMessage: <T extends CustomBotServerMessage["type"]>(
    expectedType: T,
    options?: { ignore?: CustomBotServerMessage["type"][] },
  ) => Promise<Extract<CustomBotServerMessage, { type: T }>>;
  sendAttach: (
    seatToken: string,
    options?: { protocolVersion?: number },
  ) => void;
  sendResponse: (requestId: string, response: BotResponseAction) => void;
  close: () => void;
}

async function openBotSocket(): Promise<BotSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl = baseUrl.replace("http", "ws") + `/ws/custom-bot`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: "http://localhost:5173",
      },
    });

    const buffer: CustomBotServerMessage[] = [];
    let waitingResolve: ((msg: CustomBotServerMessage) => void) | null = null;

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as CustomBotServerMessage;
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

        sendAttach: (
          seatToken: string,
          options?: { protocolVersion?: number },
        ) => {
          const msg: CustomBotClientMessage = {
            type: "attach",
            protocolVersion: options?.protocolVersion ?? 1,
            seatToken,
            supportedGame: {
              variants: ["standard", "classic", "freestyle"],
              maxBoardWidth: 15,
              maxBoardHeight: 15,
            },
            client: {
              name: "test-bot",
              version: "1.0.0",
            },
          };
          ws.send(JSON.stringify(msg));
        },

        sendResponse: (requestId: string, response: BotResponseAction) => {
          const msg: CustomBotClientMessage = {
            type: "response",
            requestId,
            response,
          };
          ws.send(JSON.stringify(msg));
        },

        waitForMessage: <T extends CustomBotServerMessage["type"]>(
          expectedType: T,
          options?: { ignore?: CustomBotServerMessage["type"][] },
        ) => {
          const ignoreTypes = options?.ignore ?? [];

          return new Promise<Extract<CustomBotServerMessage, { type: T }>>(
            (resolveWait, rejectWait) => {
              const processMessage = (msg: CustomBotServerMessage): boolean => {
                if (msg.type === expectedType) {
                  resolveWait(
                    msg as Extract<CustomBotServerMessage, { type: T }>,
                  );
                  return true;
                } else if (ignoreTypes.includes(msg.type)) {
                  return false;
                } else {
                  rejectWait(
                    new Error(
                      `Expected "${expectedType}" but got "${
                        msg.type
                      }". Message: ${JSON.stringify(msg)}`,
                    ),
                  );
                  return true;
                }
              };

              while (buffer.length > 0) {
                const msg = buffer.shift()!;
                if (processMessage(msg)) return;
              }

              const timeout = setTimeout(() => {
                waitingResolve = null;
                rejectWait(
                  new Error(
                    `Timeout waiting for "${expectedType}". Buffer: ${
                      buffer.map((m) => m.type).join(", ") || "(empty)"
                    }`,
                  ),
                );
              }, 5000);

              const waitForNext = () => {
                waitingResolve = (msg: CustomBotServerMessage) => {
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

// ================================
// --- Test Helpers ---
// ================================

const RATE_LIMIT_DELAY_MS = 300; // Slightly more than the 200ms rate limit

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Plays a move for the human player.
 */
async function humanMove(
  humanSocket: HumanSocket,
  moveNotation: string,
  boardHeight: number,
): Promise<void> {
  const { moveFromStandardNotation } =
    await import("../../shared/domain/standard-notation");
  const move = moveFromStandardNotation(moveNotation, boardHeight);
  humanSocket.ws.send(JSON.stringify({ type: "submit-move", move }));
  await humanSocket.waitForMessage("state", { ignore: ["match-status"] });
}

/**
 * Bot receives a request and responds with a move.
 */
async function botMove(
  botSocket: BotSocket,
  moveNotation: string,
): Promise<void> {
  const request = await botSocket.waitForMessage("request");
  expect(request.kind).toBe("move");

  // Wait to avoid rate limiting
  await sleep(RATE_LIMIT_DELAY_MS);

  botSocket.sendResponse(request.requestId, {
    action: "move",
    moveNotation,
  });

  const ack = await botSocket.waitForMessage("ack");
  expect(ack.requestId).toBe(request.requestId);
}

// ================================
// --- Main Tests ---
// ================================

describe("custom bot WebSocket integration", () => {
  beforeAll(async () => {
    const handle = await setupEphemeralDb();
    container = handle.container;
    await importServerModules();
    startTestServer();
  }, 120_000);

  afterAll(async () => {
    await stopTestServer();
    await teardownEphemeralDb(container);
  }, 60_000);

  it("allows a custom bot to connect, play moves, handle draws, and rematch", async () => {
    const hostUserId = "host-user";

    // 1. Create a game with custom bot as joiner
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

    const {
      gameId,
      socketToken: hostSocketToken,
      hostToken,
      customBotSeatToken,
    } = await createGameWithCustomBot(hostUserId, gameConfig);

    expect(gameId).toBeDefined();
    expect(customBotSeatToken).toBeDefined();

    // 2. Mark host as ready
    await markHostReady(hostUserId, gameId, hostToken);

    // 3. Connect human player
    const humanSocket = await openHumanSocket(
      hostUserId,
      gameId,
      hostSocketToken,
    );

    // Wait for initial state
    const initialState = await humanSocket.waitForMessage("state");
    expect(initialState.state.status).toBe("playing");

    // 4. Connect bot and attach
    const botSocket = await openBotSocket();
    botSocket.sendAttach(customBotSeatToken!);

    const attached = await botSocket.waitForMessage("attached");
    expect(attached.match.gameId).toBe(gameId);
    expect(attached.match.seat.role).toBe("joiner");

    // Get initial match status to know who goes first
    const matchStatus = await humanSocket.waitForMessage("match-status");
    const hostPlayerId = matchStatus.snapshot.players[0].playerId;
    const botPlayerId = matchStatus.snapshot.players[1].playerId;

    // Determine who goes first (Player 1 always starts)
    const humanGoesFirst = hostPlayerId === 1;

    // 5. Play a couple of moves
    // Board is 3x3:
    //   C1 .. C2
    //   .. .. ..
    //   M1 .. M2

    if (humanGoesFirst) {
      // Human (Player 1) moves first: Cat a3 -> b2
      await humanMove(humanSocket, "Cb2", 3);
      // Bot (Player 2) moves: Cat c3 -> b2
      await botMove(botSocket, "Cb2");
      // Consume state update on human side after bot move
      await humanSocket.waitForMessage("state", { ignore: ["match-status"] });
      // Now it's human's turn - can offer draw
    } else {
      // Bot (Player 1) moves first: Cat a3 -> b2
      await botMove(botSocket, "Cb2");
      // Consume state update on human side after bot move
      await humanSocket.waitForMessage("state", { ignore: ["match-status"] });
      // Now it's human's turn - can offer draw here (before human moves)
    }

    // 6. Human offers a draw (while it's human's turn), bot rejects it
    humanSocket.ws.send(JSON.stringify({ type: "draw-offer" }));

    // Bot receives draw request
    const drawRequest = await botSocket.waitForMessage("request");
    expect(drawRequest.kind).toBe("draw");

    // Bot declines (wait to avoid rate limiting)
    await sleep(RATE_LIMIT_DELAY_MS);
    botSocket.sendResponse(drawRequest.requestId, { action: "decline-draw" });

    const drawDeclineAck = await botSocket.waitForMessage("ack");
    expect(drawDeclineAck.requestId).toBe(drawRequest.requestId);

    // Human receives draw-rejected
    const drawRejected = await humanSocket.waitForMessage("draw-rejected", {
      ignore: ["state", "match-status"],
    });
    expect(drawRejected.playerId).toBe(botPlayerId);

    // 7. Make more moves - after draw decline, it's still human's turn
    // Complete the round of moves, ending with bot's move so it's human's turn for step 8
    if (humanGoesFirst) {
      // After draw decline: It's human's turn (move count is 2)
      // Human moves: place walls
      await humanMove(humanSocket, ">a2.^b1", 3);
      // Bot moves: Cat b2 -> c2 + wall
      await botMove(botSocket, "Cc2.^a1");
      // Consume state update on human side after bot move
      await humanSocket.waitForMessage("state", { ignore: ["match-status"] });
    } else {
      // After draw decline: It's human's turn (move count is 1)
      // Human moves: Cat c3 -> b2
      await humanMove(humanSocket, "Cb2", 3);
      // Bot moves: place walls
      await botMove(botSocket, ">a2.^b1");
      // Consume state update on human side after bot move
      await humanSocket.waitForMessage("state", { ignore: ["match-status"] });
      // Human moves again: place walls
      await humanMove(humanSocket, "Cc2.^a1", 3);
      // Bot moves again
      await botMove(botSocket, "Cb3");
      // Consume state update on human side after bot move
      await humanSocket.waitForMessage("state", { ignore: ["match-status"] });
    }

    // 8. Human offers another draw (it's human's turn), bot accepts
    humanSocket.ws.send(JSON.stringify({ type: "draw-offer" }));

    // Bot receives draw request
    const drawRequest2 = await botSocket.waitForMessage("request");
    expect(drawRequest2.kind).toBe("draw");

    // Bot accepts (wait to avoid rate limiting)
    await sleep(RATE_LIMIT_DELAY_MS);
    botSocket.sendResponse(drawRequest2.requestId, { action: "accept-draw" });

    const drawAcceptAck = await botSocket.waitForMessage("ack");
    expect(drawAcceptAck.requestId).toBe(drawRequest2.requestId);

    // Game should end in draw
    const drawState = await humanSocket.waitForMessage("state", {
      ignore: ["match-status"],
    });
    expect(drawState.state.status).toBe("finished");
    expect(drawState.state.result?.reason).toBe("draw-agreement");

    // 9. Human offers rematch, bot accepts
    humanSocket.ws.send(JSON.stringify({ type: "rematch-offer" }));

    // Bot receives rematch request
    const rematchRequest = await botSocket.waitForMessage("request");
    expect(rematchRequest.kind).toBe("rematch");

    // Bot accepts (wait to avoid rate limiting)
    await sleep(RATE_LIMIT_DELAY_MS);
    botSocket.sendResponse(rematchRequest.requestId, {
      action: "accept-rematch",
    });

    const rematchAck = await botSocket.waitForMessage("ack");
    expect(rematchAck.requestId).toBe(rematchRequest.requestId);

    // Bot receives rematch-started with new game info
    const rematchStarted = await botSocket.waitForMessage("rematch-started");
    expect(rematchStarted.newGameId).toBeDefined();
    expect(rematchStarted.newGameId).not.toBe(gameId);

    // Human receives rematch-started
    const humanRematchStarted = await humanSocket.waitForMessage(
      "rematch-started",
      { ignore: ["match-status", "state"] },
    );
    expect(humanRematchStarted.newGameId).toBe(rematchStarted.newGameId);

    // Close old human socket and open new one for the rematch game
    humanSocket.close();
    const newHumanSocket = await openHumanSocket(
      hostUserId,
      rematchStarted.newGameId,
      humanRematchStarted.seat!.socketToken,
    );

    // Wait for initial state on new game
    const rematchState = await newHumanSocket.waitForMessage("state");
    expect(rematchState.state.status).toBe("playing");
    expect(rematchState.state.moveCount).toBe(0);

    // Get new match status to determine who goes first in rematch
    const rematchMatchStatus =
      await newHumanSocket.waitForMessage("match-status");
    const newHostPlayerId = rematchMatchStatus.snapshot.players[0].playerId;
    const humanGoesFirstInRematch = newHostPlayerId === 1;

    // 10. Play a couple of moves on the new game
    if (humanGoesFirstInRematch) {
      // Human moves first
      await humanMove(newHumanSocket, "Cb2", 3);
      // Bot moves
      await botMove(botSocket, "Cb2");
    } else {
      // Bot moves first
      await botMove(botSocket, "Cb2");
      // Human moves
      await humanMove(newHumanSocket, "Cb2", 3);
    }

    // Verify game is still in progress
    const finalState = await newHumanSocket.waitForMessage("state", {
      ignore: ["match-status"],
    });
    expect(finalState.state.status).toBe("playing");

    // Cleanup
    newHumanSocket.close();
    botSocket.close();
  }, 60000);
});
