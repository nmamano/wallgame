/**
 * This is the fourth of 4 tests for the proactive bot protocol (V2):
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
 * IMPORTANT: This test tests the actual GPU model, not the simple policy.
 *
 * Integration test for the official custom bot client CLI using the deep-wallwars engine.
 * V2: Bots use proactive protocol with clientId and bots array.
 *
 * Uses Testcontainers to spin up an ephemeral PostgreSQL database.
 * Spawns the actual CLI client process with --engine and verifies moves.
 *
 * Prerequisites:
 * - deep-wallwars must be compiled (deep_ww_engine binary must exist)
 * - 8x8 TensorRT model must exist (8x8_750000.trt)
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type { ServerMessage } from "../../shared/contracts/websocket-messages";
import type { GameConfiguration } from "../../shared/domain/game-types";
import {
  EVALUATION_MIN,
  EVALUATION_MAX,
} from "../../shared/custom-bot/engine-api";
import * as fs from "fs";
import * as path from "path";

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

interface PlayVsBotResponse {
  gameId: string;
  token: string;
  socketToken: string;
  role: "host" | "joiner";
  playerId: 1 | 2;
  shareUrl?: string;
}

/**
 * V2: Creates a game against a registered bot via /api/bots/play.
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
    options?: { ignore?: ServerMessage["type"][]; timeoutMs?: number },
  ) => Promise<Extract<ServerMessage, { type: T }>>;
  waitForState: (
    predicate: (state: Extract<ServerMessage, { type: "state" }>) => boolean,
    options?: { timeoutMs?: number },
  ) => Promise<Extract<ServerMessage, { type: "state" }>>;
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
          options?: { ignore?: ServerMessage["type"][]; timeoutMs?: number },
        ) => {
          const ignoreTypes = ["welcome", ...(options?.ignore ?? [])];
          const timeoutMs = options?.timeoutMs ?? 10000;

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
              }, timeoutMs);

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

        // Wait for a state message that matches a predicate (ignores all other messages)
        waitForState: (
          predicate: (
            state: Extract<ServerMessage, { type: "state" }>,
          ) => boolean,
          options?: { timeoutMs?: number },
        ) => {
          const timeoutMs = options?.timeoutMs ?? 15000;

          return new Promise<Extract<ServerMessage, { type: "state" }>>(
            (resolveWait, rejectWait) => {
              const processMessage = (msg: ServerMessage): boolean => {
                if (msg.type === "state") {
                  const stateMsg = msg;
                  if (predicate(stateMsg)) {
                    resolveWait(stateMsg);
                    return true;
                  }
                }
                return false;
              };

              while (buffer.length > 0) {
                const msg = buffer.shift()!;
                if (processMessage(msg)) return;
              }

              const timeout = setTimeout(() => {
                waitingResolve = null;
                rejectWait(
                  new Error(
                    `Timeout waiting for state matching predicate. Buffer: ${
                      buffer.map((m) => m.type).join(", ") || "(empty)"
                    }`,
                  ),
                );
              }, timeoutMs);

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
// --- Bot Client Process ---
// ================================

interface BotClientProcess {
  proc: Subprocess;
  kill: () => void;
  waitForExit: () => Promise<number>;
}

interface BotConfigFile {
  path: string;
  cleanup: () => Promise<void>;
}

const deepWallwarsVariants = {
  classic: {
    timeControls: ["bullet", "blitz", "rapid", "classical"],
    boardWidth: { min: 8, max: 8 },
    boardHeight: { min: 8, max: 8 },
    recommended: [{ boardWidth: 8, boardHeight: 8 }],
  },
};

async function createBotConfigFile(args: {
  serverUrl: string;
  botId: string;
  botName: string;
  engine?: string;
}): Promise<BotConfigFile> {
  const dir = await mkdtemp(path.join(tmpdir(), "wallgame-bot-"));
  const configPath = path.join(dir, "bot-config.json");
  const config = {
    server: args.serverUrl,
    bots: [
      {
        botId: args.botId,
        name: args.botName,
        username: null,
        variants: deepWallwarsVariants,
      },
    ],
    engineCommands: args.engine
      ? { [args.botId]: { default: args.engine } }
      : {},
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));

  return {
    path: configPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * V2: Spawns bot client with clientId, bot configuration, and engine command.
 */
function spawnBotClient(
  configPath: string,
  clientId: string,
): BotClientProcess {
  const proc = spawn({
    cmd: [
      "bun",
      "run",
      "src/index.ts",
      "--client-id",
      clientId,
      "--config",
      configPath,
      "--log-level",
      "debug",
    ],
    cwd: "./official-custom-bot-client",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Log stdout/stderr for debugging (fire-and-forget)
  void (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      console.log("[BOT STDOUT]", decoder.decode(value));
    }
  })();

  void (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      console.log("[BOT STDERR]", decoder.decode(value));
    }
  })();

  return {
    proc,
    kill: () => proc.kill(),
    waitForExit: () => proc.exited,
  };
}

// ================================
// --- Test Helpers ---
// ================================

/**
 * Verifies that an evaluation value is within the valid range [-1, +1].
 */
function assertValidEvaluation(evaluation: unknown): void {
  expect(typeof evaluation).toBe("number");
  expect(evaluation).toBeGreaterThanOrEqual(EVALUATION_MIN);
  expect(evaluation).toBeLessThanOrEqual(EVALUATION_MAX);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const DEEP_WW_TIMEOUT_MS = (() => {
  const raw = Number(process.env.DEEP_WW_TIMEOUT_MS ?? "30000");
  return Number.isFinite(raw) ? raw : 30000;
})();

/**
 * Plays a move for the human player (does not wait for response).
 */
async function submitHumanMove(
  humanSocket: HumanSocket,
  moveNotation: string,
  boardHeight: number,
): Promise<void> {
  const { moveFromStandardNotation } =
    await import("../../shared/domain/standard-notation");
  const move = moveFromStandardNotation(moveNotation, boardHeight);
  humanSocket.ws.send(JSON.stringify({ type: "submit-move", move }));
}

/**
 * Wait for the game to reach a specific move count.
 */
async function waitForMoveCount(
  humanSocket: HumanSocket,
  moveCount: number,
  options?: { timeoutMs?: number },
): Promise<Extract<ServerMessage, { type: "state" }>> {
  return humanSocket.waitForState(
    (state) => state.state.moveCount >= moveCount,
    options,
  );
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
 * Finds the deep_ww_engine binary.
 * Checks WSL build path first, then native Windows build path.
 */
function findDeepWallWarsEngine(): string {
  // Possible locations for the engine binary
  const candidates = [
    // WSL build (Linux binary, accessed from WSL or Git Bash)
    path.join(process.cwd(), "deep-wallwars", "build", "deep_ww_engine"),
    // Windows build (if someone built it natively on Windows)
    path.join(process.cwd(), "deep-wallwars", "build", "deep_ww_engine.exe"),
    // Alternative: user might have a different build directory
    path.join(
      process.cwd(),
      "deep-wallwars",
      "build",
      "Release",
      "deep_ww_engine",
    ),
    path.join(
      process.cwd(),
      "deep-wallwars",
      "build",
      "Release",
      "deep_ww_engine.exe",
    ),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Deep-wallwars engine binary not found. Please compile deep-wallwars first.\n` +
      `Expected locations:\n${candidates
        .map((c) => `  - ${c}`)
        .join("\n")}\n\n` +
      `To compile:\n` +
      `  cd deep-wallwars\n` +
      `  mkdir -p build && cd build\n` +
      `  cmake ..\n` +
      `  make deep_ww_engine\n\n` +
      `See deep-wallwars/ENGINE_ADAPTER.md for details.`,
  );
}

/**
 * Finds the 8x8 TensorRT model file.
 * Returns the path if found, otherwise returns null.
 */
function findTensorRTModel(): string | null {
  const candidates = [
    path.join(process.cwd(), "deep-wallwars", "build", "8x8_750000.trt"),
    path.join(
      process.cwd(),
      "deep-wallwars",
      "build",
      "Release",
      "8x8_750000.trt",
    ),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ================================
// --- Main Test ---
// ================================

describe("custom bot client CLI integration V2 (deep-wallwars engine)", () => {
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

  it("plays a game using the actual CLI client with the deep-wallwars engine", async () => {
    // Find the engine binary (throws clear error if not found)
    const engineBinary = findDeepWallWarsEngine();
    console.log(`Using deep-wallwars engine: ${engineBinary}`);

    const tensorRTModel = findTensorRTModel();
    if (!tensorRTModel) {
      throw new Error(
        "TensorRT model not found. Build the 8x8 model before running this test.",
      );
    }
    const engineCommand = `${engineBinary} --model ${tensorRTModel} --samples 200`;

    console.log(`Using TensorRT model: ${tensorRTModel}`);
    console.log(`Engine command: ${engineCommand}`);

    const hostUserId = "host-user-deepww-v2";
    const clientId = "deepww-client-v2";
    const botId = "deepww-bot";
    const compositeId = `${clientId}:${botId}`;
    let botClient: BotClientProcess | null = null;
    let humanSocket: HumanSocket | null = null;
    let configFile: BotConfigFile | null = null;

    // Deep-wallwars only supports:
    // - Classic variant (reach opponent's corner)
    // - 8x8 board (model is trained for this size)
    const gameConfig: GameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "classic", // Required for deep-wallwars
      rated: false,
      boardWidth: 8, // Required for deep-wallwars
      boardHeight: 8, // Required for deep-wallwars
    };

    try {
      // V2: Start bot client first (proactive connection)
      configFile = await createBotConfigFile({
        serverUrl: baseUrl,
        botId,
        botName: botId,
        engine: engineCommand,
      });
      botClient = spawnBotClient(configFile.path, clientId);

      // Wait for bot to register
      await waitForBotRegistration(
        compositeId,
        { variant: "classic", timeControl: "rapid" },
        DEEP_WW_TIMEOUT_MS,
      );

      // Verify bot appears in listing
      const { bots } = await listBots({
        variant: "classic",
        timeControl: "rapid",
      });
      expect(bots.some((b) => b.id === compositeId)).toBe(true);

      // V2: Create game via /api/bots/play
      const {
        gameId,
        socketToken: hostSocketToken,
        playerId,
      } = await createGameVsBot(hostUserId, compositeId, gameConfig);

      expect(gameId).toBeDefined();

      humanSocket = await openHumanSocket(hostUserId, gameId, hostSocketToken);

      const initialState = await humanSocket.waitForMessage("state", {
        ignore: ["match-status"],
        timeoutMs: DEEP_WW_TIMEOUT_MS,
      });
      expect(initialState.state.status).toBe("playing");
      expect(initialState.state.config.variant).toBe("classic");
      expect(initialState.state.config.boardWidth).toBe(8);
      expect(initialState.state.config.boardHeight).toBe(8);

      const humanGoesFirst = playerId === 1;
      let stateAfterBotMove: Extract<ServerMessage, { type: "state" }>;

      // In classic variant, cat starts at bottom-left corner and needs to reach top-right
      // Track state after bot move to verify evaluation
      if (humanGoesFirst) {
        // Human move 1
        await submitHumanMove(humanSocket, "---", 8);
        await waitForMoveCount(humanSocket, 1, {
          timeoutMs: DEEP_WW_TIMEOUT_MS,
        });

        // Bot move 2 - capture state for evaluation check
        stateAfterBotMove = await waitForMoveCount(humanSocket, 2, {
          timeoutMs: DEEP_WW_TIMEOUT_MS,
        });

        // Human move 3
        await submitHumanMove(humanSocket, "---", 8);
        await waitForMoveCount(humanSocket, 3, {
          timeoutMs: DEEP_WW_TIMEOUT_MS,
        });

        // Bot move 4
        await waitForMoveCount(humanSocket, 4, {
          timeoutMs: DEEP_WW_TIMEOUT_MS,
        });
      } else {
        // Bot move 1 - capture state for evaluation check
        stateAfterBotMove = await waitForMoveCount(humanSocket, 1, {
          timeoutMs: DEEP_WW_TIMEOUT_MS,
        });

        // Human move 2
        await submitHumanMove(humanSocket, "---", 8);
        await waitForMoveCount(humanSocket, 2, {
          timeoutMs: DEEP_WW_TIMEOUT_MS,
        });

        // Bot move 3
        await waitForMoveCount(humanSocket, 3, {
          timeoutMs: DEEP_WW_TIMEOUT_MS,
        });

        // Human move 4
        await submitHumanMove(humanSocket, "---", 8);
        await waitForMoveCount(humanSocket, 4, {
          timeoutMs: DEEP_WW_TIMEOUT_MS,
        });
      }

      const midGameState = await waitForMoveCount(humanSocket, 4, {
        timeoutMs: DEEP_WW_TIMEOUT_MS,
      });

      // Verify the game is still in progress
      expect(midGameState.state.status).toBe("playing");

      // Verify evaluation is included in state broadcast from deep-wallwars engine
      // Note: Deep-wallwars returns real MCTS evaluation, so we only verify it's in valid range
      // We check stateAfterBotMove which is guaranteed to be from a bot move
      assertValidEvaluation(
        (stateAfterBotMove as unknown as { evaluation: number }).evaluation,
      );

      // Human resigns to end the test
      humanSocket.ws.send(JSON.stringify({ type: "resign" }));

      const finalState = await humanSocket.waitForState(
        (state) => state.state.status === "finished",
      );
      expect(finalState.state.result?.reason).toBe("resignation");
      const botPlayerId = humanGoesFirst ? 2 : 1;
      expect(finalState.state.result?.winner).toBe(botPlayerId);
    } finally {
      humanSocket?.close();
      if (botClient) {
        botClient.kill();
        await botClient.waitForExit();
      }
      if (configFile) {
        await configFile.cleanup();
      }
    }
  }, 300000); // 5 minutes timeout for GPU model loading

  it("handles unsupported variant gracefully (resigns)", async () => {
    const engineBinary = findDeepWallWarsEngine();
    const engineCommand = `${engineBinary} --model simple`;
    const hostUserId = "host-user-unsupported-variant-v2";
    const clientId = "deepww-unsupported-variant-v2";
    const botId = "unsupported-variant-bot";
    const compositeId = `${clientId}:${botId}`;
    let botClient: BotClientProcess | null = null;
    let humanSocket: HumanSocket | null = null;
    let configFile: BotConfigFile | null = null;

    // Try to use "freestyle" variant (not supported by deep-wallwars)
    const gameConfig: GameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "freestyle", // Not supported
      rated: false,
      boardWidth: 8,
      boardHeight: 8,
    };

    try {
      // Start bot client
      configFile = await createBotConfigFile({
        serverUrl: baseUrl,
        botId,
        botName: botId,
        engine: engineCommand,
      });
      botClient = spawnBotClient(configFile.path, clientId);

      // Wait for bot to register
      await waitForBotRegistration(compositeId, {
        variant: "classic",
        timeControl: "rapid",
      });

      // Create game
      const {
        gameId,
        socketToken: hostSocketToken,
        playerId,
      } = await createGameVsBot(hostUserId, compositeId, gameConfig);

      humanSocket = await openHumanSocket(hostUserId, gameId, hostSocketToken);

      await humanSocket.waitForMessage("state", { ignore: ["match-status"] });

      const humanGoesFirst = playerId === 1;

      if (humanGoesFirst) {
        await submitHumanMove(humanSocket, "---", 8);
        await waitForMoveCount(humanSocket, 1);
      }

      // Bot should resign because variant is not supported
      const finalState = await humanSocket.waitForState(
        (state) => state.state.status === "finished",
        { timeoutMs: 10000 },
      );
      expect(finalState.state.result?.reason).toBe("resignation");
      expect(finalState.state.result?.winner).toBe(playerId);
    } finally {
      humanSocket?.close();
      if (botClient) {
        botClient.kill();
        await botClient.waitForExit();
      }
      if (configFile) {
        await configFile.cleanup();
      }
    }
  }, 60000);

  it("handles unsupported board size gracefully (resigns)", async () => {
    const engineBinary = findDeepWallWarsEngine();
    const engineCommand = `${engineBinary} --model simple`;
    const hostUserId = "host-user-unsupported-size-v2";
    const clientId = "deepww-unsupported-size-v2";
    const botId = "unsupported-size-bot";
    const compositeId = `${clientId}:${botId}`;
    let botClient: BotClientProcess | null = null;
    let humanSocket: HumanSocket | null = null;
    let configFile: BotConfigFile | null = null;

    // Try to use 15x15 board (not supported by deep-wallwars 8x8 model)
    const gameConfig: GameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "classic",
      rated: false,
      boardWidth: 15, // Not supported
      boardHeight: 15, // Not supported
    };

    try {
      // Start bot client
      configFile = await createBotConfigFile({
        serverUrl: baseUrl,
        botId,
        botName: botId,
        engine: engineCommand,
      });
      botClient = spawnBotClient(configFile.path, clientId);

      // Wait for bot to register
      await waitForBotRegistration(compositeId, {
        variant: "classic",
        timeControl: "rapid",
      });

      // Create game
      const {
        gameId,
        socketToken: hostSocketToken,
        playerId,
      } = await createGameVsBot(hostUserId, compositeId, gameConfig);

      humanSocket = await openHumanSocket(hostUserId, gameId, hostSocketToken);

      await humanSocket.waitForMessage("state", { ignore: ["match-status"] });

      const humanGoesFirst = playerId === 1;

      if (humanGoesFirst) {
        await submitHumanMove(humanSocket, "---", 15);
        await waitForMoveCount(humanSocket, 1);
      }

      // Bot should resign because board size is not supported
      const finalState = await humanSocket.waitForState(
        (state) => state.state.status === "finished",
        { timeoutMs: 10000 },
      );
      expect(finalState.state.result?.reason).toBe("resignation");
      expect(finalState.state.result?.winner).toBe(playerId);
    } finally {
      humanSocket?.close();
      if (botClient) {
        botClient.kill();
        await botClient.waitForExit();
      }
      if (configFile) {
        await configFile.cleanup();
      }
    }
  }, 60000);
});
