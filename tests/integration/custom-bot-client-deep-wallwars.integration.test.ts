/**
 * IMPORTANT: This test tests the actual GPU model, not the simple policy.
 *
 * Integration test for the official custom bot client CLI using the deep-wallwars engine.
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
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type { GameCreateResponse } from "../../shared/contracts/games";
import type { ServerMessage } from "../../shared/contracts/websocket-messages";
import type { GameConfiguration } from "../../shared/domain/game-types";
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
        displayName: "Deep WallWars Bot",
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

function spawnBotClient(
  seatToken: string,
  serverUrl: string,
  engineCommand: string,
): BotClientProcess {
  const proc = spawn({
    cmd: [
      "bun",
      "run",
      "src/index.ts",
      "--server",
      serverUrl,
      "--token",
      seatToken,
      "--log-level",
      "debug",
      "--engine",
      engineCommand,
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
      `Expected locations:\n${candidates.map((c) => `  - ${c}`).join("\n")}\n\n` +
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

describe("custom bot client CLI integration (deep-wallwars engine)", () => {
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

    const hostUserId = "host-user-deepww";

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

    const {
      gameId,
      socketToken: hostSocketToken,
      hostToken,
      customBotSeatToken,
    } = await createGameWithCustomBot(hostUserId, gameConfig, {
      hostIsPlayer1: true,
    });

    expect(gameId).toBeDefined();
    expect(customBotSeatToken).toBeDefined();

    await markHostReady(hostUserId, gameId, hostToken);

    const humanSocket = await openHumanSocket(
      hostUserId,
      gameId,
      hostSocketToken,
    );

    const initialState = await humanSocket.waitForMessage("state");
    expect(initialState.state.status).toBe("playing");
    expect(initialState.state.config.variant).toBe("classic");
    expect(initialState.state.config.boardWidth).toBe(8);
    expect(initialState.state.config.boardHeight).toBe(8);

    // Spawn the bot client with deep-wallwars engine
    // Uses TensorRT model if available, otherwise simple policy
    const botClient = spawnBotClient(
      customBotSeatToken!,
      baseUrl,
      engineCommand,
    );

    // Wait for bot to connect
    await humanSocket.waitForMessage("match-status", { timeoutMs: 120000 });

    // Human (Player 1) makes first move
    // In classic variant, cat starts at bottom-left corner and needs to reach top-right
    await submitHumanMove(humanSocket, "---", 8);
    await waitForMoveCount(humanSocket, 1, { timeoutMs: 120000 });

    // Bot (Player 2) should respond - wait for move count to increment
    await waitForMoveCount(humanSocket, 2, { timeoutMs: 120000 });

    // Human makes second move
    await submitHumanMove(humanSocket, "---", 8);
    await waitForMoveCount(humanSocket, 3, { timeoutMs: 120000 });

    // Bot should respond again
    const midGameState = await waitForMoveCount(humanSocket, 4, {
      timeoutMs: 120000,
    });

    // Verify the game is still in progress
    expect(midGameState.state.status).toBe("playing");

    // Human resigns to end the test
    humanSocket.ws.send(JSON.stringify({ type: "resign" }));

    const finalState = await humanSocket.waitForState(
      (state) => state.state.status === "finished",
    );
    expect(finalState.state.result?.reason).toBe("resignation");
    expect(finalState.state.result?.winner).toBe(2); // Bot wins

    humanSocket.close();
    botClient.kill();
    await botClient.waitForExit();
  }, 120000);

  it("handles unsupported variant gracefully (resigns)", async () => {
    const engineBinary = findDeepWallWarsEngine();
    const engineCommand = `${engineBinary} --model simple`;
    const hostUserId = "host-user-unsupported-variant";

    // Try to use "standard" variant (not supported by deep-wallwars)
    const gameConfig: GameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "standard", // Not supported
      rated: false,
      boardWidth: 8,
      boardHeight: 8,
    };

    const {
      gameId,
      socketToken: hostSocketToken,
      hostToken,
      customBotSeatToken,
    } = await createGameWithCustomBot(hostUserId, gameConfig, {
      hostIsPlayer1: true,
    });

    await markHostReady(hostUserId, gameId, hostToken);

    const humanSocket = await openHumanSocket(
      hostUserId,
      gameId,
      hostSocketToken,
    );

    await humanSocket.waitForMessage("state");

    const botClient = spawnBotClient(
      customBotSeatToken!,
      baseUrl,
      engineCommand,
    );

    await humanSocket.waitForMessage("match-status");

    // Human makes a move
    await submitHumanMove(humanSocket, "---", 8);
    await waitForMoveCount(humanSocket, 1);

    // Bot should resign because variant is not supported
    const finalState = await humanSocket.waitForState(
      (state) => state.state.status === "finished",
      { timeoutMs: 10000 },
    );
    expect(finalState.state.result?.reason).toBe("resignation");
    expect(finalState.state.result?.winner).toBe(1); // Human wins (bot resigned)

    humanSocket.close();
    botClient.kill();
    await botClient.waitForExit();
  }, 30000);

  it("handles unsupported board size gracefully (resigns)", async () => {
    const engineBinary = findDeepWallWarsEngine();
    const engineCommand = `${engineBinary} --model simple`;
    const hostUserId = "host-user-unsupported-size";

    // Try to use 5x5 board (not supported by deep-wallwars 8x8 model)
    const gameConfig: GameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "classic",
      rated: false,
      boardWidth: 5, // Not supported
      boardHeight: 5, // Not supported
    };

    const {
      gameId,
      socketToken: hostSocketToken,
      hostToken,
      customBotSeatToken,
    } = await createGameWithCustomBot(hostUserId, gameConfig, {
      hostIsPlayer1: true,
    });

    await markHostReady(hostUserId, gameId, hostToken);

    const humanSocket = await openHumanSocket(
      hostUserId,
      gameId,
      hostSocketToken,
    );

    await humanSocket.waitForMessage("state");

    const botClient = spawnBotClient(
      customBotSeatToken!,
      baseUrl,
      engineCommand,
    );

    await humanSocket.waitForMessage("match-status");

    // Human makes a move
    await submitHumanMove(humanSocket, "---", 5);
    await waitForMoveCount(humanSocket, 1);

    // Bot should resign because board size is not supported
    const finalState = await humanSocket.waitForState(
      (state) => state.state.status === "finished",
      { timeoutMs: 10000 },
    );
    expect(finalState.state.result?.reason).toBe("resignation");
    expect(finalState.state.result?.winner).toBe(1); // Human wins (bot resigned)

    humanSocket.close();
    botClient.kill();
    await botClient.waitForExit();
  }, 30000);
});
