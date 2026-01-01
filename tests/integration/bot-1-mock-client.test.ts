/**
 * This is the first of 4 tests for the proactive bot protocol (V2):
 *
 * 1. bot-1-mock-client.test.ts: Mocks the bot client's WS messages.
 *    It tests the server-client protocol.
 * 2. bot-2-official-client.test.ts: Uses the official bot client with no engine
 *    so that it defaults to making a dummy AI move. It tests the official
 *    client.
 * 3. bot-3-dummy-engine.test.ts: Uses the official bot client with the dummy
 *    engine. It tests the engine API.
 * 4. bot-4-deep-wallwars-engine.test.ts: Usese the official bot client with the
 *    C++ deep-wallwars engine. It tests the Deep Wallwars adapter.
 *    Note that this may require C++ recompilation and environment setup.
 */

/**
 * Integration tests for custom bot WebSocket functionality (V2 Proactive Protocol).
 *
 * Uses Testcontainers to spin up an ephemeral PostgreSQL database.
 * No manual database setup required - just Docker.
 *
 * V2 Protocol Flow:
 * 1. Bot connects via /ws/custom-bot and sends attach with clientId and bots array
 * 2. Server responds with attached (bot is now registered and visible in UI)
 * 3. User creates game via /api/bots/play endpoint
 * 4. Human connects via regular game WebSocket
 * 5. Server sends request to bot when it's bot's turn
 * 6. Bot responds with moves
 * 7. Draw offers: Server sends draw request, bot accepts/declines
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type { ServerMessage } from "../../shared/contracts/websocket-messages";
import type { GameConfiguration } from "../../shared/domain/game-types";
import type {
  CustomBotServerMessage,
  CustomBotClientMessage,
  BotResponseAction,
  BotConfig,
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
  if (!server) {
    return;
  }

  console.log("[bot-1] stopTestServer: stopping server (force=true)");
  const stopStart = Date.now();
  const stopResult = await Promise.race([
    server.stop(true).then(() => "stopped" as const),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 5000),
    ),
  ]);

  if (stopResult === "timeout") {
    console.warn(
      "[bot-1] stopTestServer: stop(true) timed out, forcing stop(false)",
    );
    await server.stop(false);
  }

  console.log(`[bot-1] stopTestServer: stopped in ${Date.now() - stopStart}ms`);
  server = null;
}

// ================================
// --- HTTP Client Helpers ---
// ================================

interface PlayVsBotResponse {
  gameId: string;
  token: string;
  socketToken: string;
  role: "host" | "joiner";
  playerId: 1 | 2;
  shareUrl?: string;
}

/**
 * Creates a game against a registered bot via /api/bots/play.
 */
async function createGameVsBot(
  userId: string,
  botId: string,
  config: GameConfiguration,
): Promise<PlayVsBotResponse> {
  const res = await fetch(`${baseUrl}/api/bots/play`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    body: JSON.stringify({
      botId,
      config,
      hostDisplayName: `Player ${userId}`,
    }),
  });

  if (res.status !== 201) {
    const text = await res.text();
    throw new Error(
      `Expected status 201 but got ${res.status}. Error: ${text}`,
    );
  }
  return (await res.json()) as PlayVsBotResponse;
}

/**
 * V2: Lists available bots matching game settings.
 * Both variant and timeControl are required by the API.
 */
async function listBots(filters: {
  variant: string;
  timeControl: string;
  boardWidth?: number;
  boardHeight?: number;
}): Promise<{
  bots: { id: string; botId: string; name: string; clientId: string }[];
}> {
  const params = new URLSearchParams();
  params.set("variant", filters.variant);
  params.set("timeControl", filters.timeControl);
  if (filters.boardWidth) params.set("boardWidth", String(filters.boardWidth));
  if (filters.boardHeight)
    params.set("boardHeight", String(filters.boardHeight));

  const res = await fetch(`${baseUrl}/api/bots?${params.toString()}`);
  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(
      `Expected status 200 but got ${res.status}. Error: ${text}`,
    );
  }
  return (await res.json()) as {
    bots: { id: string; botId: string; name: string; clientId: string }[];
  };
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
// --- Custom Bot WebSocket (V2) ---
// ================================

interface BotSocket {
  ws: WebSocket;
  waitForMessage: <T extends CustomBotServerMessage["type"]>(
    expectedType: T,
    options?: { ignore?: CustomBotServerMessage["type"][] },
  ) => Promise<Extract<CustomBotServerMessage, { type: T }>>;
  sendAttach: (
    clientId: string,
    bots: BotConfig[],
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
          clientId: string,
          bots: BotConfig[],
          options?: { protocolVersion?: number },
        ) => {
          const msg: CustomBotClientMessage = {
            type: "attach",
            protocolVersion: options?.protocolVersion ?? 2,
            clientId,
            bots,
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
): Promise<Extract<ServerMessage, { type: "state" }>> {
  const { moveFromStandardNotation } =
    await import("../../shared/domain/standard-notation");
  const move = moveFromStandardNotation(moveNotation, boardHeight);
  humanSocket.ws.send(JSON.stringify({ type: "submit-move", move }));
  return await humanSocket.waitForMessage("state", {
    ignore: ["match-status"],
  });
}

async function waitForTurn(
  humanSocket: HumanSocket,
  playerId: number,
  initialState?: Extract<ServerMessage, { type: "state" }>,
): Promise<Extract<ServerMessage, { type: "state" }>> {
  if (
    initialState?.state.status === "playing" &&
    initialState.state.turn === playerId
  ) {
    return initialState;
  }

  while (true) {
    const state = await humanSocket.waitForMessage("state", {
      ignore: ["match-status"],
    });
    if (state.state.status !== "playing") {
      return state;
    }
    if (state.state.turn === playerId) {
      return state;
    }
  }
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

async function botMoveNoop(botSocket: BotSocket): Promise<void> {
  await botMove(botSocket, "---");
}

/**
 * Wait for bot to appear in the bot listing.
 */
async function waitForBotRegistration(
  compositeId: string,
  filters: { variant: string; timeControl: string },
  timeoutMs = 10000,
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const { bots } = await listBots(filters);
    if (bots.some((b) => b.id === compositeId)) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`Bot ${compositeId} did not register within ${timeoutMs}ms`);
}

/**
 * Creates a standard bot config for testing.
 */
function createTestBotConfig(botId: string, name: string): BotConfig {
  return {
    botId,
    name,
    username: null, // Public bot
    variants: {
      standard: {
        timeControls: ["bullet", "blitz", "rapid"],
        boardWidth: { min: 3, max: 15 },
        boardHeight: { min: 3, max: 15 },
        recommended: [{ boardWidth: 5, boardHeight: 5 }],
      },
      classic: {
        timeControls: ["bullet", "blitz", "rapid"],
        boardWidth: { min: 3, max: 15 },
        boardHeight: { min: 3, max: 15 },
        recommended: [{ boardWidth: 5, boardHeight: 5 }],
      },
    },
  };
}

// ================================
// --- Main Tests ---
// ================================

describe("custom bot WebSocket integration V2", () => {
  beforeAll(async () => {
    const handle = await setupEphemeralDb();
    container = handle.container;
    await importServerModules();
    startTestServer();
  }, 120_000);

  afterAll(async () => {
    console.log("[bot-1] afterAll: stopping server");
    const serverStopStart = Date.now();
    await stopTestServer();
    console.log(
      `[bot-1] afterAll: server stopped in ${Date.now() - serverStopStart}ms`,
    );
    console.log("[bot-1] afterAll: stopping db container");
    const dbStopStart = Date.now();
    await teardownEphemeralDb(container);
    console.log(
      `[bot-1] afterAll: db container stopped in ${Date.now() - dbStopStart}ms`,
    );
  }, 60_000);

  it("allows a custom bot to connect, play moves, and handle draws", async () => {
    const hostUserId = "host-user-v2";
    const clientId = "test-client-ws";
    const botId = "test-bot";
    const compositeId = `${clientId}:${botId}`;
    let botSocket: BotSocket | null = null;
    let humanSocket: HumanSocket | null = null;

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

    try {
      // 1. Connect bot and attach with V2 protocol
      botSocket = await openBotSocket();
      botSocket.sendAttach(clientId, [createTestBotConfig(botId, "Test Bot")]);

      const attached = await botSocket.waitForMessage("attached");
      expect(attached.protocolVersion).toBe(2);

      // 2. Wait for bot to appear in listing
      await waitForBotRegistration(compositeId, {
        variant: "standard",
        timeControl: "rapid",
      });

      // Verify bot appears in listing
      const { bots } = await listBots({
        variant: "standard",
        timeControl: "rapid",
      });
      expect(bots.some((b) => b.id === compositeId)).toBe(true);

      // 3. Create game against the bot via V2 API
      const {
        gameId,
        socketToken: hostSocketToken,
        playerId,
      } = await createGameVsBot(hostUserId, compositeId, gameConfig);

      expect(gameId).toBeDefined();

      // 4. Connect human player
      humanSocket = await openHumanSocket(hostUserId, gameId, hostSocketToken);

      // Wait for initial state
      const initialState = await humanSocket.waitForMessage("state");
      expect(initialState.state.status).toBe("playing");

      const humanPlayerId = playerId;
      const botPlayerId = humanPlayerId === 1 ? 2 : 1;

      // If bot starts, handle its move first.
      if (initialState.state.turn === botPlayerId) {
        await botMoveNoop(botSocket);
        await waitForTurn(humanSocket, humanPlayerId);
      }

      // 5. Play a couple of noop moves ("---") to advance turns.
      const afterHumanMove = await humanMove(humanSocket, "---", 3);
      expect(afterHumanMove.state.turn).toBe(botPlayerId);
      await botMoveNoop(botSocket);
      await waitForTurn(humanSocket, humanPlayerId);

      // 6. Human offers a draw, bot rejects it
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
      const afterHumanMove2 = await humanMove(humanSocket, "---", 3);
      expect(afterHumanMove2.state.turn).toBe(botPlayerId);
      await botMoveNoop(botSocket);
      await waitForTurn(humanSocket, humanPlayerId);

      // 8. Human offers another draw, bot accepts
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
    } finally {
      humanSocket?.close();
      botSocket?.close();
    }
  }, 60000);

  it("rejects attach with invalid protocol version", async () => {
    const botSocket = await openBotSocket();

    // Send attach with protocol version 1 (unsupported)
    botSocket.sendAttach(
      "test-client-v1",
      [createTestBotConfig("test-bot", "Test Bot")],
      { protocolVersion: 1 },
    );

    const rejected = await botSocket.waitForMessage("attach-rejected");
    expect(rejected.code).toBe("PROTOCOL_UNSUPPORTED");

    botSocket.close();
  }, 10000);

  it("rejects attach with empty bots array", async () => {
    const botSocket = await openBotSocket();

    // Send attach with no bots
    const msg: CustomBotClientMessage = {
      type: "attach",
      protocolVersion: 2,
      clientId: "empty-bots-client",
      bots: [],
      client: {
        name: "test-bot",
        version: "1.0.0",
      },
    };
    botSocket.ws.send(JSON.stringify(msg));

    const rejected = await botSocket.waitForMessage("attach-rejected");
    expect(rejected.code).toBe("NO_BOTS");

    botSocket.close();
  }, 10000);

  it("handles bot resign action", async () => {
    const hostUserId = "host-user-resign";
    const clientId = "test-client-resign";
    const botId = "resign-bot";
    const compositeId = `${clientId}:${botId}`;

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

    // Connect bot
    const botSocket = await openBotSocket();
    botSocket.sendAttach(clientId, [createTestBotConfig(botId, "Resign Bot")]);
    await botSocket.waitForMessage("attached");
    await waitForBotRegistration(compositeId, {
      variant: "standard",
      timeControl: "rapid",
    });

    // Create game
    const {
      gameId,
      socketToken: hostSocketToken,
      playerId,
    } = await createGameVsBot(hostUserId, compositeId, gameConfig);

    const humanSocket = await openHumanSocket(
      hostUserId,
      gameId,
      hostSocketToken,
    );
    await humanSocket.waitForMessage("state");

    const humanGoesFirst = playerId === 1;

    if (humanGoesFirst) {
      // Human moves first
      await humanMove(humanSocket, "---", 3);
    }

    // Bot receives move request but resigns instead
    const request = await botSocket.waitForMessage("request");
    expect(request.kind).toBe("move");

    await sleep(RATE_LIMIT_DELAY_MS);
    botSocket.sendResponse(request.requestId, { action: "resign" });

    const ack = await botSocket.waitForMessage("ack");
    expect(ack.requestId).toBe(request.requestId);

    // Game should end with human winning
    const finalState = await humanSocket.waitForMessage("state", {
      ignore: ["match-status"],
    });
    expect(finalState.state.status).toBe("finished");
    expect(finalState.state.result?.reason).toBe("resignation");
    expect(finalState.state.result?.winner).toBe(humanGoesFirst ? 1 : 2);

    humanSocket.close();
    botSocket.close();
  }, 30000);

  it("supports multiple bots per client", async () => {
    const clientId = "multi-bot-client";
    const bot1Id = "multi-bot-1";
    const bot2Id = "multi-bot-2";
    const compositeId1 = `${clientId}:${bot1Id}`;
    const compositeId2 = `${clientId}:${bot2Id}`;

    // Connect bot client with multiple bots
    const botSocket = await openBotSocket();
    botSocket.sendAttach(clientId, [
      createTestBotConfig(bot1Id, "Multi Bot 1"),
      createTestBotConfig(bot2Id, "Multi Bot 2"),
    ]);

    await botSocket.waitForMessage("attached");

    // Wait for both bots to appear in listing
    const filters = { variant: "standard", timeControl: "rapid" };
    await waitForBotRegistration(compositeId1, filters);
    await waitForBotRegistration(compositeId2, filters);

    // Verify both bots appear
    const { bots } = await listBots(filters);
    expect(bots.some((b) => b.id === compositeId1)).toBe(true);
    expect(bots.some((b) => b.id === compositeId2)).toBe(true);

    botSocket.close();
  }, 15000);
});
