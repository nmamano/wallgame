/**
 * This is the first of 4 tests for the proactive bot protocol (V3):
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
 * Integration tests for custom bot WebSocket functionality (V3 Bot Game Session Protocol).
 *
 * Uses Testcontainers to spin up an ephemeral PostgreSQL database.
 * No manual database setup required - just Docker.
 *
 * V3 Protocol Flow:
 * 1. Bot connects via /ws/custom-bot and sends attach with clientId and bots array
 * 2. Server responds with attached (bot is now registered and visible in UI)
 * 3. User creates game via /api/bots/play endpoint
 * 4. Human connects via regular game WebSocket
 * 5. Server sends start_game_session to bot
 * 6. Bot responds with game_session_started
 * 7. Server sends evaluate_position requests, bot responds with evaluate_response
 * 8. Server sends apply_move messages, bot responds with move_applied
 * 9. Draw handling: Server auto-rejects draws in V3 (no message to bot)
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type { ServerMessage } from "../../shared/contracts/websocket-messages";
import type { GameConfiguration } from "../../shared/domain/game-types";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import type {
  CustomBotServerMessage,
  CustomBotClientMessage,
  BotConfig,
  GameSessionStartedMessage,
  GameSessionEndedMessage,
  EvaluateResponseMessage,
  MoveAppliedMessage,
} from "../../shared/contracts/custom-bot-protocol";
import {
  EVALUATION_MIN,
  EVALUATION_MAX,
} from "../../shared/custom-bot/engine-api";

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
 * @param hostIsPlayer1 - If true, host is Player 1 (moves first). If false, bot is Player 1. If undefined, random.
 */
async function createGameVsBot(
  userId: string,
  botId: string,
  config: GameConfiguration,
  hostIsPlayer1?: boolean,
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
      hostIsPlayer1,
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
 * V3: Lists available bots matching game settings.
 * TimeControl is ignored in V3 (bot games are untimed) but may still be accepted by API for compatibility.
 */
async function listBots(filters: {
  variant: string;
  timeControl?: string;
  boardWidth?: number;
  boardHeight?: number;
}): Promise<{
  bots: { id: string; botId: string; name: string; clientId: string }[];
}> {
  const params = new URLSearchParams();
  params.set("variant", filters.variant);
  if (filters.timeControl) params.set("timeControl", filters.timeControl);
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
// --- Custom Bot WebSocket (V3) ---
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
  // V3 BGS response methods
  sendGameSessionStarted: (bgsId: string, success: boolean, error?: string) => void;
  sendGameSessionEnded: (bgsId: string, success: boolean, error?: string) => void;
  sendEvaluateResponse: (bgsId: string, ply: number, bestMove: string, evaluation: number, success?: boolean, error?: string) => void;
  sendMoveApplied: (bgsId: string, ply: number, success?: boolean, error?: string) => void;
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
            protocolVersion: options?.protocolVersion ?? 3,
            clientId,
            bots,
            client: {
              name: "test-bot",
              version: "3.0.0",
            },
          };
          ws.send(JSON.stringify(msg));
        },

        sendGameSessionStarted: (bgsId: string, success: boolean, error = "") => {
          const msg: GameSessionStartedMessage = {
            type: "game_session_started",
            bgsId,
            success,
            error,
          };
          ws.send(JSON.stringify(msg));
        },

        sendGameSessionEnded: (bgsId: string, success: boolean, error = "") => {
          const msg: GameSessionEndedMessage = {
            type: "game_session_ended",
            bgsId,
            success,
            error,
          };
          ws.send(JSON.stringify(msg));
        },

        sendEvaluateResponse: (bgsId: string, ply: number, bestMove: string, evaluation: number, success = true, error = "") => {
          const msg: EvaluateResponseMessage = {
            type: "evaluate_response",
            bgsId,
            ply,
            bestMove,
            evaluation,
            success,
            error,
          };
          ws.send(JSON.stringify(msg));
        },

        sendMoveApplied: (bgsId: string, ply: number, success = true, error = "") => {
          const msg: MoveAppliedMessage = {
            type: "move_applied",
            bgsId,
            ply,
            success,
            error,
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
 * Verifies that an evaluation value is within the valid range [-1, +1].
 */
function assertValidEvaluation(evaluation: unknown): void {
  expect(typeof evaluation).toBe("number");
  expect(evaluation).toBeGreaterThanOrEqual(EVALUATION_MIN);
  expect(evaluation).toBeLessThanOrEqual(EVALUATION_MAX);
}

/**
 * Wait for bot to appear in the bot listing.
 */
async function waitForBotRegistration(
  compositeId: string,
  filters: { variant: string; timeControl?: string },
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
 * V3: Creates a standard bot config for testing (no timeControls - bot games are untimed)
 */
function createTestBotConfig(botId: string, name: string): BotConfig {
  return {
    botId,
    name,
    username: null, // Public bot
    variants: {
      standard: {
        boardWidth: { min: 3, max: 15 },
        boardHeight: { min: 3, max: 15 },
        recommended: [{ boardWidth: 5, boardHeight: 5 }],
      },
      classic: {
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

describe("custom bot WebSocket integration V3", () => {
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

  it("allows a custom bot to connect and play using V3 BGS protocol", async () => {
    const hostUserId = "host-user-v3";
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
      variantConfig: buildStandardInitialState(3, 3),
    };

    try {
      // 1. Connect bot and attach with V3 protocol
      botSocket = await openBotSocket();
      botSocket.sendAttach(clientId, [createTestBotConfig(botId, "Test Bot")]);

      const attached = await botSocket.waitForMessage("attached");
      expect(attached.protocolVersion).toBe(3);

      // 2. Wait for bot to appear in listing
      await waitForBotRegistration(compositeId, {
        variant: "standard",
      });

      // Verify bot appears in listing
      const { bots } = await listBots({
        variant: "standard",
      });
      expect(bots.some((b) => b.id === compositeId)).toBe(true);

      // 3. Create game against the bot (human is Player 1, moves first)
      const {
        gameId,
        socketToken: hostSocketToken,
        playerId,
      } = await createGameVsBot(hostUserId, compositeId, gameConfig, true);

      expect(gameId).toBeDefined();
      expect(playerId).toBe(1); // Human is Player 1

      // 4. Connect human player
      humanSocket = await openHumanSocket(hostUserId, gameId, hostSocketToken);

      // 5. Bot receives start_game_session
      const startSession = await botSocket.waitForMessage("start_game_session");
      expect(startSession.bgsId).toBeDefined();
      expect(startSession.botId).toBe(botId);

      // Bot confirms session started
      await sleep(RATE_LIMIT_DELAY_MS);
      botSocket.sendGameSessionStarted(startSession.bgsId, true);

      // 6. Bot receives initial evaluate_position request (ply 0)
      const initialEval = await botSocket.waitForMessage("evaluate_position");
      expect(initialEval.bgsId).toBe(startSession.bgsId);
      expect(initialEval.expectedPly).toBe(0);

      // Bot responds with evaluation and best move
      await sleep(RATE_LIMIT_DELAY_MS);
      botSocket.sendEvaluateResponse(initialEval.bgsId, 0, "---", 0.0);

      // Wait for initial state
      const initialState = await humanSocket.waitForMessage("state");
      expect(initialState.state.status).toBe("playing");
      expect(initialState.state.turn).toBe(1); // Human's turn first

      const humanPlayerId = 1;
      const botPlayerId = 2;

      // 7. Human makes a noop move ("---")
      const afterHumanMove = await humanMove(humanSocket, "---", 3);
      expect(afterHumanMove.state.turn).toBe(botPlayerId);

      // 8. Bot receives apply_move for human's move
      const applyHumanMove = await botSocket.waitForMessage("apply_move");
      expect(applyHumanMove.bgsId).toBe(startSession.bgsId);
      expect(applyHumanMove.expectedPly).toBe(0);
      expect(applyHumanMove.move).toBe("---");

      // Bot confirms move applied (new ply is 1)
      await sleep(RATE_LIMIT_DELAY_MS);
      botSocket.sendMoveApplied(applyHumanMove.bgsId, 1);

      // 9. Bot receives evaluate_position for position after human move
      const evalAfterHuman = await botSocket.waitForMessage("evaluate_position");
      expect(evalAfterHuman.bgsId).toBe(startSession.bgsId);
      expect(evalAfterHuman.expectedPly).toBe(1);

      // Bot responds with evaluation - this becomes the bot's move
      await sleep(RATE_LIMIT_DELAY_MS);
      botSocket.sendEvaluateResponse(evalAfterHuman.bgsId, 1, "---", -0.2);

      // Wait for bot's turn to complete
      const stateAfterBotMove = await waitForTurn(humanSocket, humanPlayerId);
      // Verify evaluation is included in state broadcast after bot move
      assertValidEvaluation(
        (stateAfterBotMove as unknown as { evaluation: number }).evaluation,
      );

      // 10. Human resigns to end game
      humanSocket.ws.send(JSON.stringify({ type: "resign" }));

      // Wait for game to end
      const finalState = await humanSocket.waitForMessage("state", {
        ignore: ["match-status"],
      });
      expect(finalState.state.status).toBe("finished");
      expect(finalState.state.result?.reason).toBe("resignation");
      expect(finalState.state.result?.winner).toBe(botPlayerId);

      // 11. Bot receives end_game_session
      const endSession = await botSocket.waitForMessage("end_game_session");
      expect(endSession.bgsId).toBe(startSession.bgsId);

      // Bot confirms session ended
      await sleep(RATE_LIMIT_DELAY_MS);
      botSocket.sendGameSessionEnded(endSession.bgsId, true);
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

  it("rejects attach with V2 protocol version", async () => {
    const botSocket = await openBotSocket();

    // Send attach with protocol version 2 (no longer supported)
    botSocket.sendAttach(
      "test-client-v2",
      [createTestBotConfig("test-bot", "Test Bot")],
      { protocolVersion: 2 },
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
      protocolVersion: 3,
      clientId: "empty-bots-client",
      bots: [],
      client: {
        name: "test-bot",
        version: "3.0.0",
      },
    };
    botSocket.ws.send(JSON.stringify(msg));

    const rejected = await botSocket.waitForMessage("attach-rejected");
    expect(rejected.code).toBe("NO_BOTS");

    botSocket.close();
  }, 10000);

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
    const filters = { variant: "standard" };
    await waitForBotRegistration(compositeId1, filters);
    await waitForBotRegistration(compositeId2, filters);

    // Verify both bots appear
    const { bots } = await listBots(filters);
    expect(bots.some((b) => b.id === compositeId1)).toBe(true);
    expect(bots.some((b) => b.id === compositeId2)).toBe(true);

    botSocket.close();
  }, 15000);
});
