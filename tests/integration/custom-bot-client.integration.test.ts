/**
 * Integration tests for the official custom bot client CLI.
 *
 * Uses Testcontainers to spin up an ephemeral PostgreSQL database.
 * Spawns the actual CLI client process and lets the built-in dumb bot play.
 *
 * Test flow:
 * 1. Creates game with joinerConfig: { type: "custom-bot" }
 * 2. Marks host ready
 * 3. Human connects via regular game WebSocket
 * 4. Spawns CLI client with seat token (no --engine flag, uses dumb bot)
 * 5. Human plays moves, bot responds automatically
 * 6. Verifies game progresses correctly
 * 7. Human resigns to end game cleanly
 *
 * Test 1 - "plays a game using the actual CLI client with built-in dumb bot" - Bot as Player 2, human moves first
 * Test 2 - "bot handles being Player 1 (moving first)" - Bot as Player 1, bot moves first
 * Test 3 - "bot auto-accepts rematch offers" - Verifies the rematch flow
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type { GameCreateResponse } from "../../shared/contracts/games";
import type { ServerMessage } from "../../shared/contracts/websocket-messages";
import type { GameConfiguration } from "../../shared/domain/game-types";

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
        displayName: "Dumb Bot",
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
                // Ignore all other messages, keep waiting
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
): Promise<Extract<ServerMessage, { type: "state" }>> {
  return humanSocket.waitForState(
    (state) => state.state.moveCount >= moveCount,
  );
}

// ================================
// --- Main Tests ---
// ================================

describe("custom bot client CLI integration", () => {
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

  it("plays a game using the actual CLI client with built-in dumb bot", async () => {
    const hostUserId = "host-user";

    // 1. Create a game with custom bot as joiner
    // Use a small board for quick testing
    const gameConfig: GameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "standard",
      rated: false,
      boardWidth: 5,
      boardHeight: 5,
    };

    // Force host to be Player 1 so we know who goes first
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

    // 4. Spawn the CLI client (no --engine flag, uses dumb bot)
    const botClient = spawnBotClient(customBotSeatToken!, baseUrl);

    // Wait for bot to connect (server broadcasts match-status on connection)
    await humanSocket.waitForMessage("match-status");

    // 5. Play several moves
    // Board is 5x5:
    //   C1 .. .. .. C2    (row 5, top)
    //   .. .. .. .. ..
    //   .. .. .. .. ..
    //   .. .. .. .. ..
    //   M1 .. .. .. M2    (row 1, bottom)
    //
    // Human is Player 1 (left side): Cat at a5, Mouse at a1
    // Bot is Player 2 (right side): Cat at e5, Mouse at e1
    //
    // Human's cat goal: opponent's mouse at e1
    // Bot's cat goal: opponent's mouse at a1

    // Human (Player 1) moves first
    // Move 1: Human moves cat towards bot's mouse
    await submitHumanMove(humanSocket, "Cb4", 5);

    // Wait for game to reach move count 2 (human moved, bot moved)
    await waitForMoveCount(humanSocket, 2);

    // Move 2: Human continues moving cat
    await submitHumanMove(humanSocket, "Cc3", 5);

    // Wait for move count 4
    await waitForMoveCount(humanSocket, 4);

    // Move 3: Human continues
    await submitHumanMove(humanSocket, "Cd2", 5);

    // Wait for move count 6
    const midGameState = await waitForMoveCount(humanSocket, 6);

    // Verify game is still in progress
    expect(midGameState.state.status).toBe("playing");
    expect(midGameState.state.moveCount).toBeGreaterThanOrEqual(6);

    // 6. Human resigns to end the game cleanly
    humanSocket.ws.send(JSON.stringify({ type: "resign" }));

    // Wait for game to end
    const finalState = await humanSocket.waitForState(
      (state) => state.state.status === "finished",
    );
    expect(finalState.state.result?.reason).toBe("resignation");
    expect(finalState.state.result?.winner).toBe(2); // Bot wins

    // 7. Cleanup
    humanSocket.close();
    botClient.kill();

    // Wait for bot process to exit
    await botClient.waitForExit();
  }, 60000);

  it("bot handles being Player 1 (moving first)", async () => {
    const hostUserId = "host-user-2";

    // Create game where bot is Player 1 (moves first)
    const gameConfig: GameConfiguration = {
      timeControl: {
        initialSeconds: 600,
        incrementSeconds: 0,
        preset: "rapid",
      },
      variant: "standard",
      rated: false,
      boardWidth: 5,
      boardHeight: 5,
    };

    // Force host to be Player 2 so bot is Player 1
    const {
      gameId,
      socketToken: hostSocketToken,
      hostToken,
      customBotSeatToken,
    } = await createGameWithCustomBot(hostUserId, gameConfig, {
      hostIsPlayer1: false,
    });

    expect(gameId).toBeDefined();
    expect(customBotSeatToken).toBeDefined();

    // Mark host as ready
    await markHostReady(hostUserId, gameId, hostToken);

    // Connect human player first
    const humanSocket = await openHumanSocket(
      hostUserId,
      gameId,
      hostSocketToken,
    );

    // Wait for initial state
    const initialState = await humanSocket.waitForMessage("state");
    expect(initialState.state.status).toBe("playing");
    expect(initialState.state.turn).toBe(1); // Player 1's turn (bot)

    // Spawn the CLI client - bot is Player 1 so it should move first
    const botClient = spawnBotClient(customBotSeatToken!, baseUrl);

    // Wait for the bot to make the first move (server will send request after attach)
    // Use a long timeout since the bot needs to: connect, attach, receive request, respond
    const afterBotMove = await humanSocket.waitForState(
      (state) => state.state.moveCount >= 1,
      { timeoutMs: 20000 },
    );
    expect(afterBotMove.state.turn).toBe(2); // Now it's human's (Player 2) turn

    // Human makes a move
    await submitHumanMove(humanSocket, "Cd4", 5);

    // Wait for bot's response
    const afterExchange = await waitForMoveCount(humanSocket, 3);
    expect(afterExchange.state.status).toBe("playing");

    // Cleanup - human resigns
    humanSocket.ws.send(JSON.stringify({ type: "resign" }));
    await humanSocket.waitForState((s) => s.state.status === "finished");

    humanSocket.close();
    botClient.kill();
    await botClient.waitForExit();
  }, 60000);

  it("bot auto-accepts rematch offers", async () => {
    const hostUserId = "host-user-3";

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

    // Spawn the CLI client
    const botClient = spawnBotClient(customBotSeatToken!, baseUrl);

    // Wait for bot to connect (server broadcasts match-status on connection)
    await humanSocket.waitForMessage("match-status");

    // Give bot time to process attached message before we resign
    await sleep(500);

    // Human resigns to end the game
    humanSocket.ws.send(JSON.stringify({ type: "resign" }));

    const resignState = await humanSocket.waitForMessage("state", {
      ignore: ["match-status"],
    });
    expect(resignState.state.status).toBe("finished");

    // Human offers rematch
    humanSocket.ws.send(JSON.stringify({ type: "rematch-offer" }));

    // Bot should auto-accept (per spec)
    // Human receives rematch-started
    const rematchStarted = await humanSocket.waitForMessage("rematch-started", {
      ignore: ["match-status", "state"],
      timeoutMs: 10000,
    });
    expect(rematchStarted.newGameId).toBeDefined();
    expect(rematchStarted.newGameId).not.toBe(gameId);

    // Cleanup
    humanSocket.close();
    botClient.kill();
    await botClient.waitForExit();
  }, 60000);
});
