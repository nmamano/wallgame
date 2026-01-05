/**
 * This is the third of 4 tests for the proactive bot protocol (V2):
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
 * Integration test for the official custom bot client CLI using the dummy engine.
 * V2: Bots use proactive protocol with clientId and bots array.
 *
 * Uses Testcontainers to spin up an ephemeral PostgreSQL database.
 * Spawns the actual CLI client process with --engine and verifies moves.
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

const defaultVariants = {
  standard: {
    timeControls: ["bullet", "blitz", "rapid", "classical"],
    boardWidth: { min: 3, max: 15 },
    boardHeight: { min: 3, max: 15 },
    recommended: [{ boardWidth: 5, boardHeight: 5 }],
  },
  classic: {
    timeControls: ["bullet", "blitz", "rapid", "classical"],
    boardWidth: { min: 3, max: 15 },
    boardHeight: { min: 3, max: 15 },
    recommended: [{ boardWidth: 5, boardHeight: 5 }],
  },
  freestyle: {
    timeControls: ["bullet", "blitz", "rapid", "classical"],
    boardWidth: { min: 3, max: 15 },
    boardHeight: { min: 3, max: 15 },
    recommended: [],
  },
};

async function createBotConfigFile(args: {
  serverUrl: string;
  botId: string;
  botName: string;
  engine?: string;
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
 * V2: Spawns bot client using a config file.
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
  botId: string,
  filters: { variant: string; timeControl: string },
  timeoutMs = 10000,
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const { bots } = await listBots(filters);
    if (bots.some((b) => b.id === botId)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Bot ${botId} did not register within ${timeoutMs}ms`);
}

// ================================
// --- Main Test ---
// ================================

describe("custom bot client CLI integration V2 (dummy engine)", () => {
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

  it("plays a game using the V2 proactive bot protocol with dummy engine", async () => {
    const hostUserId = "host-user-v2";
    const clientId = "test-client-v2";
    const botId = "dummy-bot";
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
      // V2: Start bot client first (proactive connection)
      configFile = await createBotConfigFile({
        serverUrl: baseUrl,
        botId,
        botName: botId,
        engine: "bun ../dummy-engine/src/index.ts",
      });
      botClient = spawnBotClient(configFile.path, clientId);

      // Wait for bot to register
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

      // V2: Create game via /api/bots/play
      const {
        gameId,
        socketToken: hostSocketToken,
        playerId,
      } = await createGameVsBot(hostUserId, compositeId, gameConfig);

      expect(gameId).toBeDefined();

      humanSocket = await openHumanSocket(hostUserId, gameId, hostSocketToken);

      // Wait for initial state (game should start immediately since bot is connected)
      const initialState = await humanSocket.waitForMessage("state", {
        ignore: ["match-status"],
      });
      expect(initialState.state.status).toBe("playing");

      const botPlayerId = playerId === 1 ? 2 : 1;
      let currentState = initialState;

      const playNoopRound = async () => {
        currentState = await waitForTurn(humanSocket, playerId, currentState);
        await submitHumanMove(humanSocket, "---", 5);
        currentState = await waitForTurn(
          humanSocket,
          botPlayerId,
          currentState,
        );
        currentState = await waitForTurn(humanSocket, playerId, currentState);
      };

      await playNoopRound();
      await playNoopRound();

      // Human resigns
      humanSocket.ws.send(JSON.stringify({ type: "resign" }));

      const finalState = await humanSocket.waitForState(
        (state) => state.state.status === "finished",
      );
      expect(finalState.state.result?.reason).toBe("resignation");
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
  }, 60000);

  it("bot discovery works with variant filtering", async () => {
    const clientId = "test-client-filter";
    const botId = "filter-bot";
    const compositeId = `${clientId}:${botId}`;
    let botClient: BotClientProcess | null = null;
    let configFile: BotConfigFile | null = null;

    try {
      // Start bot client
      configFile = await createBotConfigFile({
        serverUrl: baseUrl,
        botId,
        botName: botId,
        engine: "bun ../dummy-engine/src/index.ts",
      });
      botClient = spawnBotClient(configFile.path, clientId);

      // Wait for bot to register
      await waitForBotRegistration(compositeId, {
        variant: "standard",
        timeControl: "rapid",
      });

      // Verify bot appears in listing with standard variant
      const { bots: standardBots } = await listBots({
        variant: "standard",
        timeControl: "rapid",
      });
      expect(standardBots.some((b) => b.id === compositeId)).toBe(true);

      // Verify filtering works with different time controls
      const { bots: blitzBots } = await listBots({
        variant: "standard",
        timeControl: "blitz",
      });
      expect(blitzBots.some((b) => b.id === compositeId)).toBe(true);
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
