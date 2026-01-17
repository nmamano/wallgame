/**
 * Eval Bar Integration Tests
 *
 * Tests the evaluation bar functionality using the V3 BGS protocol.
 * Uses the dummy engine which returns distance-based evaluations:
 *   +0.5 if P1 is closer to their goal
 *    0.0 if both players are equidistant
 *   -0.5 if P2 is closer to their goal
 *
 * Tests:
 * 1. Human vs Bot: Human enables eval bar, makes a move, receives evaluation updates
 * 2. Human vs Human: Both players make moves, then enable eval bar and receive history
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
  EvalServerMessage,
  EvalHistoryEntry,
} from "../../shared/contracts/eval-protocol";
import type {
  GameConfiguration,
  PlayerId,
} from "../../shared/domain/game-types";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";

// ================================
// --- Test Harness ---
// ================================

// Set official bot token for testing eval bar (must be set before importing server)
const TEST_OFFICIAL_TOKEN = "test-official-bot-token-12345";
process.env.OFFICIAL_BOT_TOKEN = TEST_OFFICIAL_TOKEN;

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

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
    port: 0,
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
}

async function createGameVsBot(
  userId: string,
  botId: string,
  config: GameConfiguration,
  hostIsPlayer1: boolean,
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
    throw new Error(`Expected 201 but got ${res.status}. Error: ${text}`);
  }
  return (await res.json()) as PlayVsBotResponse;
}

interface GameCreateResponse {
  gameId: string;
  token: string;
  socketToken: string;
  role: "host" | "joiner";
  playerId: 1 | 2;
  shareUrl: string;
}

async function createFriendGame(
  userId: string,
  config: GameConfiguration,
  hostIsPlayer1: boolean,
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
      hostIsPlayer1,
    }),
  });

  if (res.status !== 201) {
    const text = await res.text();
    throw new Error(`Expected 201 but got ${res.status}. Error: ${text}`);
  }
  return (await res.json()) as GameCreateResponse;
}

async function joinFriendGame(
  userId: string,
  gameId: string,
): Promise<{ playerId: PlayerId; socketToken: string }> {
  const res = await fetch(`${baseUrl}/api/games/${gameId}/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    body: JSON.stringify({
      displayName: `Player ${userId}`,
    }),
  });

  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(`Expected 200 but got ${res.status}. Error: ${text}`);
  }
  const json = (await res.json()) as {
    role: string;
    playerId: PlayerId;
    socketToken: string;
  };
  return { playerId: json.playerId, socketToken: json.socketToken };
}

async function listBots(filters: { variant: string }): Promise<{
  bots: { id: string; botId: string; name: string; clientId: string }[];
}> {
  const params = new URLSearchParams();
  params.set("variant", filters.variant);
  const res = await fetch(`${baseUrl}/api/bots?${params.toString()}`);
  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(`Expected 200 but got ${res.status}. Error: ${text}`);
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
                      `Expected "${expectedType}" but got "${msg.type}". Message: ${JSON.stringify(msg)}`,
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
                rejectWait(new Error(`Timeout waiting for "${expectedType}"`));
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

        waitForState: (
          predicate: (
            state: Extract<ServerMessage, { type: "state" }>,
          ) => boolean,
          options?: { timeoutMs?: number },
        ) => {
          const timeoutMs = options?.timeoutMs ?? 10000;

          return new Promise<Extract<ServerMessage, { type: "state" }>>(
            (resolveWait, rejectWait) => {
              const processMessage = (msg: ServerMessage): boolean => {
                if (
                  msg.type === "state" &&
                  predicate(msg as Extract<ServerMessage, { type: "state" }>)
                ) {
                  resolveWait(msg as Extract<ServerMessage, { type: "state" }>);
                  return true;
                }
                return false;
              };

              while (buffer.length > 0) {
                const msg = buffer.shift()!;
                if (processMessage(msg)) return;
              }

              const timeout = setTimeout(() => {
                waitingResolve = null;
                rejectWait(new Error(`Timeout waiting for state`));
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
// --- Eval WebSocket ---
// ================================

interface EvalSocket {
  ws: WebSocket;
  sendHandshake: (
    gameId: string,
    variant: string,
    boardWidth: number,
    boardHeight: number,
  ) => void;
  waitForMessage: <T extends EvalServerMessage["type"]>(
    expectedType: T,
    options?: { timeoutMs?: number },
  ) => Promise<Extract<EvalServerMessage, { type: T }>>;
  close: () => void;
}

async function openEvalSocket(gameId: string): Promise<EvalSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl = baseUrl.replace("http", "ws") + `/ws/eval/${gameId}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: "http://localhost:5173",
      },
    });

    const buffer: EvalServerMessage[] = [];
    let waitingResolve: ((msg: EvalServerMessage) => void) | null = null;

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as EvalServerMessage;
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

        sendHandshake: (
          gameId: string,
          variant: string,
          boardWidth: number,
          boardHeight: number,
        ) => {
          ws.send(
            JSON.stringify({
              type: "eval-handshake",
              gameId,
              variant,
              boardWidth,
              boardHeight,
            }),
          );
        },

        waitForMessage: <T extends EvalServerMessage["type"]>(
          expectedType: T,
          options?: { timeoutMs?: number },
        ) => {
          const timeoutMs = options?.timeoutMs ?? 10000;

          return new Promise<Extract<EvalServerMessage, { type: T }>>(
            (resolveWait, rejectWait) => {
              const processMessage = (msg: EvalServerMessage): boolean => {
                if (msg.type === expectedType) {
                  resolveWait(msg as Extract<EvalServerMessage, { type: T }>);
                  return true;
                }
                return false;
              };

              while (buffer.length > 0) {
                const msg = buffer.shift()!;
                if (processMessage(msg)) return;
              }

              const timeout = setTimeout(() => {
                waitingResolve = null;
                rejectWait(new Error(`Timeout waiting for "${expectedType}"`));
              }, timeoutMs);

              const waitForNext = () => {
                waitingResolve = (msg: EvalServerMessage) => {
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
    boardWidth: { min: 3, max: 15 },
    boardHeight: { min: 3, max: 15 },
    recommended: [{ boardWidth: 5, boardHeight: 5 }],
  },
};

async function createBotConfigFile(args: {
  serverUrl: string;
  botId: string;
  botName: string;
  engine: string;
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
    engineCommands: {
      [args.botId]: { default: args.engine },
    },
  };

  await writeFile(path, JSON.stringify(config, null, 2));

  return {
    path,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function spawnBotClient(
  configPath: string,
  clientId: string,
  officialToken?: string,
): BotClientProcess {
  const cmd = [
    "bun",
    "run",
    "src/index.ts",
    "--client-id",
    clientId,
    "--config",
    configPath,
    "--log-level",
    "debug",
  ];
  if (officialToken) {
    cmd.push("--official-token", officialToken);
  }
  const proc = spawn({
    cmd,
    cwd: "./official-custom-bot-client",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Log stdout/stderr for debugging
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

async function submitHumanMove(
  humanSocket: HumanSocket,
  moveNotation: string,
  boardHeight: number,
): Promise<void> {
  const { moveFromStandardNotation } = await import(
    "../../shared/domain/standard-notation"
  );
  const move = moveFromStandardNotation(moveNotation, boardHeight);
  humanSocket.ws.send(JSON.stringify({ type: "submit-move", move }));
}

async function waitForTurn(
  humanSocket: HumanSocket,
  playerId: PlayerId,
): Promise<Extract<ServerMessage, { type: "state" }>> {
  return humanSocket.waitForState(
    (state) =>
      state.state.status !== "playing" || state.state.turn === playerId,
  );
}

async function waitForBotRegistration(
  botId: string,
  filters: { variant: string },
  timeoutMs = 10000,
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const { bots } = await listBots(filters);
    if (bots.some((b) => b.id === botId)) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`Bot ${botId} did not register within ${timeoutMs}ms`);
}

// ================================
// --- Main Tests ---
// ================================

describe("eval bar integration tests", () => {
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

  it("human vs bot: eval bar receives initial evaluation and updates after moves", async () => {
    const hostUserId = "eval-test-user";
    const clientId = "eval-test-client";
    const botId = "eval-bot";
    const compositeId = `${clientId}:${botId}`;
    let botClient: BotClientProcess | null = null;
    let humanSocket: HumanSocket | null = null;
    let evalSocket: EvalSocket | null = null;
    let configFile: BotConfigFile | null = null;

    // 5x5 board - standard setup
    const gameConfig: GameConfiguration = {
      timeControl: { initialSeconds: 600, incrementSeconds: 0, preset: "rapid" },
      variant: "standard",
      rated: false,
      boardWidth: 5,
      boardHeight: 5,
      variantConfig: buildStandardInitialState(5, 5),
    };

    try {
      // 1. Start bot client with dummy engine (official for eval bar access)
      configFile = await createBotConfigFile({
        serverUrl: baseUrl,
        botId,
        botName: "Eval Test Bot",
        engine: "bun run ../dummy-engine/src/index.ts",
      });

      botClient = spawnBotClient(configFile.path, clientId, TEST_OFFICIAL_TOKEN);
      await waitForBotRegistration(compositeId, { variant: "standard" });

      // 2. Create game (human is P1, moves first)
      const { gameId, socketToken, playerId } = await createGameVsBot(
        hostUserId,
        compositeId,
        gameConfig,
        true, // hostIsPlayer1
      );
      expect(playerId).toBe(1);

      // 3. Connect human player
      humanSocket = await openHumanSocket(hostUserId, gameId, socketToken);

      // Wait for initial state (human's turn)
      const initialState = await humanSocket.waitForMessage("state", {
        ignore: ["match-status"],
      });
      expect(initialState.state.status).toBe("playing");
      expect(initialState.state.turn).toBe(1); // Human's turn

      // Wait for engine to initialize
      await sleep(1000);

      // 4. Connect eval bar BEFORE making moves
      evalSocket = await openEvalSocket(gameId);
      // Small delay to ensure WebSocket is fully ready
      await sleep(100);
      evalSocket.sendHandshake(gameId, "standard", 5, 5);

      // 5. Wait for handshake acceptance and history
      await evalSocket.waitForMessage("eval-handshake-accepted");
      const historyMsg = await evalSocket.waitForMessage("eval-history");

      // Should have 1 entry (ply 0 = initial position)
      expect(historyMsg.entries.length).toBe(1);
      expect(historyMsg.entries[0].ply).toBe(0);
      // Initial position: both players equidistant from goals
      expect(historyMsg.entries[0].evaluation).toBe(0);

      // 6. Human makes a double-walk move (cat: a5 → b5 → c5)
      // P1 cat starts at a5 [0,0], moves toward P2 mouse at e1 [4,4]
      // Standard notation: "Cb5.Cc5" = cat to b5, then cat to c5
      await submitHumanMove(humanSocket, "Cb5.Cc5", 5);

      // Wait for human's move to be confirmed by server
      await humanSocket.waitForState((s) => s.state.turn === 2);

      // 7. Wait for eval update after human's move (ply 1)
      const evalUpdate1 = await evalSocket.waitForMessage("eval-update");
      expect(evalUpdate1.ply).toBe(1);
      // After P1 moves closer: P1 is now closer to goal
      expect(evalUpdate1.evaluation).toBe(0.5);

      // 8. Wait for bot's turn to complete and state update
      const stateAfterBot = await humanSocket.waitForState(
        (state) => state.state.turn === 1 || state.state.status !== "playing",
      );
      expect(stateAfterBot.state.status).toBe("playing");

      // 9. Wait for eval update after bot's move (ply 2)
      const evalUpdate2 = await evalSocket.waitForMessage("eval-update");
      expect(evalUpdate2.ply).toBe(2);
      // After both players made one double-walk: should be equidistant again
      expect(evalUpdate2.evaluation).toBe(0);

      // 10. Clean up - resign the game
      humanSocket.ws.send(JSON.stringify({ type: "resign" }));
      await humanSocket.waitForState((s) => s.state.status === "finished");
    } finally {
      evalSocket?.close();
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

  it("human vs human: both players receive evaluation history after enabling eval bar", async () => {
    const hostUserId = "eval-hvh-host";
    const joinerUserId = "eval-hvh-joiner";
    const clientId = "eval-hvh-client";
    const botId = "eval-hvh-bot";
    const compositeId = `${clientId}:${botId}`;
    let botClient: BotClientProcess | null = null;
    let hostSocket: HumanSocket | null = null;
    let joinerSocket: HumanSocket | null = null;
    let hostEvalSocket: EvalSocket | null = null;
    let joinerEvalSocket: EvalSocket | null = null;
    let configFile: BotConfigFile | null = null;

    // 5x5 board - standard setup
    const gameConfig: GameConfiguration = {
      timeControl: { initialSeconds: 600, incrementSeconds: 0, preset: "rapid" },
      variant: "standard",
      rated: false,
      boardWidth: 5,
      boardHeight: 5,
      variantConfig: buildStandardInitialState(5, 5),
    };

    try {
      // 1. Start bot client (needed for eval bar even in human vs human games)
      configFile = await createBotConfigFile({
        serverUrl: baseUrl,
        botId,
        botName: "Eval HvH Bot",
        engine: "bun run ../dummy-engine/src/index.ts",
      });

      botClient = spawnBotClient(configFile.path, clientId, TEST_OFFICIAL_TOKEN);
      await waitForBotRegistration(compositeId, { variant: "standard" });

      // 2. Create friend game (host is P1)
      const hostGame = await createFriendGame(hostUserId, gameConfig, true);
      const gameId = hostGame.gameId;

      // 3. Joiner joins the game
      const joinerGame = await joinFriendGame(joinerUserId, gameId);

      // 4. Connect both players
      hostSocket = await openHumanSocket(
        hostUserId,
        gameId,
        hostGame.socketToken,
      );
      joinerSocket = await openHumanSocket(
        joinerUserId,
        gameId,
        joinerGame.socketToken,
      );

      // Wait for initial state
      const hostInitial = await hostSocket.waitForMessage("state", {
        ignore: ["match-status"],
      });
      expect(hostInitial.state.status).toBe("playing");
      expect(hostInitial.state.turn).toBe(1); // P1 (host) starts

      // 5. Host (P1) makes a double-walk move (cat: a5 → b5 → c5)
      // P1 cat starts at a5 [0,0], walks right toward P2 mouse at e1 [4,4]
      await submitHumanMove(hostSocket, "Cb5.Cc5", 5);

      // Wait for state update showing it's P2's turn
      await hostSocket.waitForState((s) => s.state.turn === 2);
      await joinerSocket.waitForState((s) => s.state.turn === 2);

      // 6. Joiner (P2) makes a double-walk move (cat: e5 → d5 → c5)
      // P2 cat starts at e5 [0,4], walks left toward P1 mouse at a1 [4,0]
      await submitHumanMove(joinerSocket, "Cd5.Cc5", 5);

      // Wait for state update showing it's P1's turn again
      await hostSocket.waitForState((s) => s.state.turn === 1);
      await joinerSocket.waitForState((s) => s.state.turn === 1);

      // 7. Now both players enable eval bar (after 2 moves)
      hostEvalSocket = await openEvalSocket(gameId);
      joinerEvalSocket = await openEvalSocket(gameId);
      // Small delay to ensure WebSockets are fully ready
      await sleep(100);

      hostEvalSocket.sendHandshake(gameId, "standard", 5, 5);
      joinerEvalSocket.sendHandshake(gameId, "standard", 5, 5);

      // 8. Both should receive handshake acceptance and full history
      await hostEvalSocket.waitForMessage("eval-handshake-accepted");
      await joinerEvalSocket.waitForMessage("eval-handshake-accepted");

      const hostHistory = await hostEvalSocket.waitForMessage("eval-history");
      const joinerHistory =
        await joinerEvalSocket.waitForMessage("eval-history");

      // 9. Verify history has 3 entries (ply 0, 1, 2)
      expect(hostHistory.entries.length).toBe(3);
      expect(joinerHistory.entries.length).toBe(3);

      // Verify evaluations match expected values
      const expectedEvals: EvalHistoryEntry[] = [
        { ply: 0, evaluation: 0, bestMove: expect.any(String) },
        { ply: 1, evaluation: 0.5, bestMove: expect.any(String) },
        { ply: 2, evaluation: 0, bestMove: expect.any(String) },
      ];

      for (let i = 0; i < 3; i++) {
        expect(hostHistory.entries[i].ply).toBe(expectedEvals[i].ply);
        expect(hostHistory.entries[i].evaluation).toBe(
          expectedEvals[i].evaluation,
        );
        expect(joinerHistory.entries[i].ply).toBe(expectedEvals[i].ply);
        expect(joinerHistory.entries[i].evaluation).toBe(
          expectedEvals[i].evaluation,
        );
      }

      // 10. Clean up - resign the game
      hostSocket.ws.send(JSON.stringify({ type: "resign" }));
      await hostSocket.waitForState((s) => s.state.status === "finished");
    } finally {
      hostEvalSocket?.close();
      joinerEvalSocket?.close();
      hostSocket?.close();
      joinerSocket?.close();
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
