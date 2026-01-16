/**
 * This is the second of 4 tests for the proactive bot protocol (V3):
 *
 * 1. bot-1-mock-client.test.ts: Mocks the bot client's WS messages.
 *    It tests the server-client protocol.
 * 2. bot-2-official-client.test.ts: Uses the official bot client WITHOUT an external engine.
 *    It tests the built-in dumb-bot fallback end-to-end.
 * 3. bot-3-dummy-engine.test.ts: Uses the official bot client with the dummy engine
 *    and tests engine integration in detail (state tracking, multiple rounds).
 * 4. bot-4-deep-wallwars-engine.test.ts: Uses the official bot client with the
 *    C++ deep-wallwars engine. It tests the Deep Wallwars adapter.
 *    Note that this requires C++ compilation and GPU setup.
 */

/**
 * Integration tests for the official custom bot client CLI (V3 Bot Game Session Protocol).
 *
 * Uses Testcontainers to spin up an ephemeral PostgreSQL database.
 * Spawns the actual CLI client process WITHOUT an external engine - testing the
 * built-in dumb-bot fallback that uses simple AI logic.
 *
 * V3 Protocol Flow:
 * 1. Spawns CLI client with --client-id and a config file (no engine)
 * 2. Waits for bot to appear in listing API
 * 3. Creates game against bot via /api/bots/play endpoint
 * 4. Human connects via regular game WebSocket
 * 5. Human plays moves, bot responds using built-in dumb-bot
 * 6. Verifies game progresses correctly (dumb-bot returns "---" noop moves)
 * 7. Human resigns to end game cleanly
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type { ServerMessage } from "../../shared/contracts/websocket-messages";
import type {
  GameConfiguration,
  PlayerId,
} from "../../shared/domain/game-types";

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
 * V3: Creates a game against a registered bot via /api/bots/play.
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
 * TimeControl is no longer used in V3 - bot games are untimed.
 */
async function listBots(filters: {
  variant: string;
  boardWidth?: number;
  boardHeight?: number;
}): Promise<{
  bots: { id: string; botId: string; name: string; clientId: string }[];
}> {
  const params = new URLSearchParams();
  params.set("variant", filters.variant);
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
          let lastState: Extract<ServerMessage, { type: "state" }> | null =
            null;

          return new Promise<Extract<ServerMessage, { type: "state" }>>(
            (resolveWait, rejectWait) => {
              const processMessage = (msg: ServerMessage): boolean => {
                if (msg.type === "state") {
                  const stateMsg = msg;
                  lastState = stateMsg;
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
                const lastStateSummary = lastState
                  ? JSON.stringify({
                      status: lastState.state.status,
                      turn: lastState.state.turn,
                      moveCount: lastState.state.moveCount,
                      result: lastState.state.result,
                    })
                  : "(none)";
                rejectWait(
                  new Error(
                    `Timeout waiting for state matching predicate. Last state: ${lastStateSummary}. Buffer: ${
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

/** V3: Bot variant configs - no timeControls (bot games are untimed) */
const defaultVariants = {
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
  freestyle: {
    boardWidth: { min: 3, max: 15 },
    boardHeight: { min: 3, max: 15 },
    recommended: [],
  },
};

async function createBotConfigFile(args: {
  serverUrl: string;
  botId: string;
  botName: string;
  engine?: string; // Optional - if not provided, client uses built-in dumb-bot
}): Promise<BotConfigFile> {
  const dir = await mkdtemp(join(tmpdir(), "wallgame-bot-"));
  const path = join(dir, "bot-config.json");
  const config = {
    server: args.serverUrl,
    bots: [
      {
        botId: args.botId,
        name: args.botName,
        username: null,
        variants: defaultVariants,
      },
    ],
    // Only include engineCommands if an engine is specified
    engineCommands: args.engine
      ? { [args.botId]: { default: args.engine } }
      : {},
  };

  await writeFile(path, JSON.stringify(config, null, 2));

  return {
    path,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * V3: Spawns bot client using a config file with engine command.
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Plays a move for the human player and waits for the next state.
 */
async function submitHumanMove(
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
  playerId: PlayerId,
  currentState?: Extract<ServerMessage, { type: "state" }>,
  timeoutMs?: number,
): Promise<Extract<ServerMessage, { type: "state" }>> {
  if (
    currentState?.state.status === "playing" &&
    currentState.state.turn === playerId
  ) {
    return currentState;
  }
  if (currentState && currentState.state.status !== "playing") {
    return currentState;
  }
  return humanSocket.waitForState(
    (state) =>
      state.state.status !== "playing" || state.state.turn === playerId,
    { timeoutMs },
  );
}

/**
 * Wait for bot to appear in the bot listing.
 */
async function waitForBotRegistration(
  compositeId: string,
  filters: { variant: string },
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

// ================================
// --- Main Tests ---
// ================================

describe("custom bot client CLI integration V3 (dumb-bot fallback)", () => {
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

  it("plays a game using the actual CLI client with built-in dumb-bot", async () => {
    const hostUserId = "host-user-v3";
    const clientId = "test-client-v3";
    const botId = "dumb-bot";
    const compositeId = `${clientId}:${botId}`;
    let botClient: BotClientProcess | null = null;
    let humanSocket: HumanSocket | null = null;
    let configFile: BotConfigFile | null = null;

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

    try {
      // V3: Start bot client WITHOUT engine - uses built-in dumb-bot fallback
      configFile = await createBotConfigFile({
        serverUrl: baseUrl,
        botId,
        botName: "Dumb Bot",
        // No engine - client uses built-in dumb-bot
      });
      botClient = spawnBotClient(configFile.path, clientId);

      // Wait for bot to register
      await waitForBotRegistration(compositeId, {
        variant: "standard",
      });

      // Verify bot appears in listing
      const { bots } = await listBots({
        variant: "standard",
      });
      expect(bots.some((b) => b.id === compositeId)).toBe(true);

      // V3: Create game via /api/bots/play (human is Player 1, moves first)
      const {
        gameId,
        socketToken: hostSocketToken,
        playerId,
      } = await createGameVsBot(hostUserId, compositeId, gameConfig, true);

      expect(gameId).toBeDefined();
      expect(playerId).toBe(1); // Human is Player 1

      // Connect human player - this triggers BGS initialization
      humanSocket = await openHumanSocket(hostUserId, gameId, hostSocketToken);

      // Wait for initial state
      const initialState = await humanSocket.waitForMessage("state", {
        ignore: ["match-status"],
      });
      expect(initialState.state.status).toBe("playing");
      expect(initialState.state.turn).toBe(1); // Human's turn first

      const humanPlayerId = 1;
      const botPlayerId = 2;
      let currentState = initialState;

      // Play a few rounds of noop moves
      const playNoopRound = async () => {
        currentState = await waitForTurn(
          humanSocket!,
          humanPlayerId,
          currentState,
        );
        if (currentState.state.status !== "playing") return false;

        // Human makes noop move
        currentState = await submitHumanMove(humanSocket!, "---", 5);
        if (currentState.state.status !== "playing") return false;

        // Wait for bot's turn to complete (bot will also make a move)
        currentState = await waitForTurn(
          humanSocket!,
          humanPlayerId,
          currentState,
        );

        return currentState.state.status === "playing";
      };

      // Play 3 rounds of noop moves
      for (let i = 0; i < 3; i += 1) {
        const stillPlaying = await playNoopRound();
        if (!stillPlaying) break;
      }

      if (currentState.state.status === "playing") {
        // Human resigns to end the game cleanly
        humanSocket.ws.send(JSON.stringify({ type: "resign" }));

        const finalState = await humanSocket.waitForState(
          (state) => state.state.status === "finished",
        );
        expect(finalState.state.result?.reason).toBe("resignation");
        expect(finalState.state.result?.winner).toBe(botPlayerId);
      } else {
        // Game ended naturally (capture)
        expect(currentState.state.status).toBe("finished");
        expect(currentState.state.result?.reason).toBe("capture");
      }
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

  it("dumb-bot handles being Player 1 (moving first)", async () => {
    const hostUserId = "host-user-p1-v3";
    const clientId = "test-client-p1-v3";
    const botId = "dumb-bot-p1";
    const compositeId = `${clientId}:${botId}`;
    let botClient: BotClientProcess | null = null;
    let humanSocket: HumanSocket | null = null;
    let configFile: BotConfigFile | null = null;

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

    try {
      // Start bot client without engine - uses built-in dumb-bot
      configFile = await createBotConfigFile({
        serverUrl: baseUrl,
        botId,
        botName: "Dumb Bot P1",
        // No engine - uses dumb-bot fallback
      });
      botClient = spawnBotClient(configFile.path, clientId);

      // Wait for bot to register
      await waitForBotRegistration(compositeId, {
        variant: "standard",
      });

      // Create game - bot is Player 1 (moves first), human is Player 2
      const {
        gameId,
        socketToken: hostSocketToken,
        playerId,
      } = await createGameVsBot(hostUserId, compositeId, gameConfig, false);

      expect(gameId).toBeDefined();
      expect(playerId).toBe(2); // Human is Player 2

      humanSocket = await openHumanSocket(hostUserId, gameId, hostSocketToken);

      // Wait for initial state - bot's turn first
      const initialState = await humanSocket.waitForMessage("state", {
        ignore: ["match-status"],
      });
      expect(initialState.state.status).toBe("playing");
      expect(initialState.state.turn).toBe(1); // Bot's turn first

      const humanPlayerId = 2;

      // Wait for bot's first move to complete (turn should now be human's)
      // Server waits for BGS to be synchronized before broadcasting bot's move
      let currentState = await humanSocket.waitForState(
        (state) =>
          state.state.status !== "playing" || state.state.turn === humanPlayerId,
        { timeoutMs: 5000 },
      );

      const playNoopRound = async () => {
        // Wait for bot to move first
        currentState = await waitForTurn(
          humanSocket!,
          humanPlayerId,
          currentState,
        );
        if (currentState.state.status !== "playing") return false;

        // Human makes noop move
        currentState = await submitHumanMove(humanSocket!, "---", 5);
        if (currentState.state.status !== "playing") return false;

        // Wait for bot to move again
        currentState = await waitForTurn(
          humanSocket!,
          humanPlayerId,
          currentState,
        );

        return currentState.state.status === "playing";
      };

      // Play multiple rounds - game may end naturally if bot captures mouse
      for (let i = 0; i < 3; i += 1) {
        const stillPlaying = await playNoopRound();
        if (!stillPlaying) break;
      }

      if (currentState.state.status === "playing") {
        // Cleanup - human resigns
        humanSocket.ws.send(JSON.stringify({ type: "resign" }));
        const finalState = await humanSocket.waitForState(
          (s) => s.state.status === "finished",
        );
        expect(finalState.state.result?.reason).toBe("resignation");
      } else {
        // Game ended naturally (capture) - bot won by catching mouse
        expect(currentState.state.status).toBe("finished");
        expect(currentState.state.result?.reason).toBe("capture");
      }
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

  it("dumb-bot discovery works with variant filtering", async () => {
    const clientId = "test-client-filter-v3";
    const botId = "filter-bot";
    const compositeId = `${clientId}:${botId}`;

    let botClient: BotClientProcess | null = null;
    let configFile: BotConfigFile | null = null;

    try {
      // Start bot client without engine - uses dumb-bot fallback
      configFile = await createBotConfigFile({
        serverUrl: baseUrl,
        botId,
        botName: "Filter Bot",
        // No engine - uses dumb-bot
      });
      botClient = spawnBotClient(configFile.path, clientId);

      // Wait for bot to register
      await waitForBotRegistration(compositeId, {
        variant: "standard",
      });

      // Verify bot appears in listing with standard variant
      const { bots: standardBots } = await listBots({
        variant: "standard",
      });
      expect(standardBots.some((b) => b.id === compositeId)).toBe(true);

      // Verify bot also appears with classic variant (bot supports both)
      const { bots: classicBots } = await listBots({
        variant: "classic",
      });
      expect(classicBots.some((b) => b.id === compositeId)).toBe(true);
    } finally {
      if (botClient) {
        botClient.kill();
        await botClient.waitForExit();
      }
      if (configFile) {
        await configFile.cleanup();
      }
    }
  }, 30000);
});
