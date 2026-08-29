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
import { buildOrdinaryInitialState } from "../../shared/domain/game-configuration";
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

// ================================
// --- Test Harness ---
// ================================

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

// These will be dynamically imported after DB is set up
let createApp: typeof import("../../server/app").createApp;
let db: typeof import("../../server/db").db;
let usersTable: typeof import("../../server/db/schema/users").usersTable;
let userAuthTable: typeof import("../../server/db/schema/users").userAuthTable;
let globalRatingsTable: typeof import("../../server/db/schema/global-ratings").globalRatingsTable;

async function importServerModules() {
  const serverModule = await import("../../server/app");
  createApp = serverModule.createApp;
  db = (await import("../../server/db")).db;
  const users = await import("../../server/db/schema/users");
  usersTable = users.usersTable;
  userAuthTable = users.userAuthTable;
  globalRatingsTable = (await import("../../server/db/schema/global-ratings"))
    .globalRatingsTable;
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
  userId: string | undefined,
  botId: string,
  config: GameConfiguration,
  hostIsPlayer1?: boolean,
): Promise<PlayVsBotResponse> {
  const res = await fetch(`${baseUrl}/api/bots/play`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(userId ? { "x-test-user-id": userId } : {}),
    },
    body: JSON.stringify({
      botId,
      config,
      hostDisplayName: userId ? `Player ${userId}` : "Guest",
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
  userId: string | undefined,
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
        ...(userId ? { "x-test-user-id": userId } : {}),
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
  /**
   * Everything buffered since the last drain, emptied.
   *
   * `waitForMessage` cannot answer two questions these BGS-lifecycle tests
   * need. It gives up after 5 s, which is shorter than the server's 10 s
   * BGS_REQUEST_TIMEOUT_MS, so it cannot see a message the server sends when
   * that timeout fires. And it cannot assert an ABSENCE at all: a test that
   * needs "no end_game_session was sent here" has nothing to wait for.
   */
  drainMessages: () => CustomBotServerMessage[];
  sendAttach: (
    clientId: string,
    bots: BotConfig[],
    options?: { protocolVersion?: number },
  ) => void;
  // V3 BGS response methods
  sendGameSessionStarted: (
    bgsId: string,
    success: boolean,
    error?: string,
  ) => void;
  sendGameSessionEnded: (
    bgsId: string,
    success: boolean,
    error?: string,
  ) => void;
  sendEvaluateResponse: (
    bgsId: string,
    ply: number,
    bestMove: string,
    evaluation: number,
    success?: boolean,
    error?: string,
  ) => void;
  sendMoveApplied: (
    bgsId: string,
    ply: number,
    success?: boolean,
    error?: string,
  ) => void;
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

        drainMessages: () => buffer.splice(0, buffer.length),

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

        sendGameSessionStarted: (
          bgsId: string,
          success: boolean,
          error = "",
        ) => {
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

        sendEvaluateResponse: (
          bgsId: string,
          ply: number,
          bestMove: string,
          evaluation: number,
          success = true,
          error = "",
        ) => {
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

        sendMoveApplied: (
          bgsId: string,
          ply: number,
          success = true,
          error = "",
        ) => {
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
    appearance: {
      dogStyle: "dog-puppy-07.svg",
      elephantStyle: "elephant-19.svg",
    },
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
      "animal-cycle": {
        boardWidth: { min: 4, max: 15 },
        boardHeight: { min: 4, max: 15 },
        recommended: [{ boardWidth: 9, boardHeight: 9 }],
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

  it("hydrates authoritative global Elo through bot creation, reconnect, and rematch", async () => {
    const clientId = "rating-authority-client";
    const botId = "rating-authority-bot";
    const compositeId = `${clientId}:${botId}`;
    const existingAuthId = "rating-authority-existing";
    const newAuthId = "rating-authority-new";
    let botSocket: BotSocket | null = null;
    const humanSockets: HumanSocket[] = [];

    const [existingUser] = await db
      .insert(usersTable)
      .values({
        displayName: "rating_authority_existing",
        capitalizedDisplayName: "RATING_AUTHORITY_EXISTING",
        authProvider: "test",
      })
      .returning({ userId: usersTable.userId });
    await db.insert(userAuthTable).values({
      userId: existingUser.userId,
      authProvider: "test",
      authUserId: existingAuthId,
    });
    await db.insert(globalRatingsTable).values({
      userId: existingUser.userId,
      rating: 1742,
      ratingDeviation: 80,
    });

    const config = (
      variant: "standard" | "classic" | "animal-cycle",
      boardWidth: number,
      boardHeight: number,
    ): GameConfiguration => {
      const base = {
        timeControl: {
          initialSeconds: 600,
          incrementSeconds: 0,
          preset: "rapid" as const,
        },
        variant,
        randomStart: false,
        rated: false,
        boardWidth,
        boardHeight,
      };
      return { ...base, variantConfig: buildOrdinaryInitialState(base) };
    };

    const openAndReadSnapshot = async (
      authUserId: string | undefined,
      game: PlayVsBotResponse,
    ) => {
      const socket = await openHumanSocket(
        authUserId,
        game.gameId,
        game.socketToken,
      );
      humanSockets.push(socket);
      await socket.waitForMessage("state");
      const status = await socket.waitForMessage("match-status");
      return { socket, snapshot: status.snapshot };
    };

    try {
      botSocket = await openBotSocket();
      botSocket.sendAttach(clientId, [
        createTestBotConfig(botId, "Rating Authority Bot"),
      ]);
      await botSocket.waitForMessage("attached");
      await waitForBotRegistration(compositeId, { variant: "animal-cycle" });

      const existingGame = await createGameVsBot(
        existingAuthId,
        compositeId,
        config("animal-cycle", 9, 9),
        true,
      );
      const existing = await openAndReadSnapshot(existingAuthId, existingGame);
      const existingHuman = existing.snapshot.players.find(
        (player) => player.configType === "human",
      );
      const existingBot = existing.snapshot.players.find(
        (player) => player.configType === "bot",
      );
      expect(existing.snapshot.config.rated).toBe(false);
      expect(existingHuman?.elo).toBe(1742);
      expect(existingHuman?.ratingAtStart).toBe(1742);
      expect(existingBot).toMatchObject({
        displayName: "Rating Authority Bot",
        configType: "bot",
      });
      expect(existingBot?.elo).toBeUndefined();
      expect(existingBot?.ratingAtStart).toBeUndefined();

      existing.socket.close();
      const reconnected = await openAndReadSnapshot(
        existingAuthId,
        existingGame,
      );
      const reconnectedHuman = reconnected.snapshot.players.find(
        (player) => player.configType === "human",
      );
      expect(reconnectedHuman?.elo).toBe(1742);
      expect(reconnectedHuman?.ratingAtStart).toBe(1742);

      for (const [variant, width, height] of [
        ["standard", 5, 5],
        ["classic", 7, 6],
      ] as const) {
        const game = await createGameVsBot(
          existingAuthId,
          compositeId,
          config(variant, width, height),
          true,
        );
        const { snapshot } = await openAndReadSnapshot(existingAuthId, game);
        const human = snapshot.players.find(
          (player) => player.configType === "human",
        );
        expect(human?.elo).toBe(1742);
        expect(human?.ratingAtStart).toBe(1742);
      }

      const newMemberGame = await createGameVsBot(
        newAuthId,
        compositeId,
        config("standard", 4, 4),
        true,
      );
      const newMember = await openAndReadSnapshot(newAuthId, newMemberGame);
      const newMemberHuman = newMember.snapshot.players.find(
        (player) => player.configType === "human",
      );
      expect(newMemberHuman?.elo).toBe(1500);
      expect(newMemberHuman?.ratingAtStart).toBe(1500);

      const guestGame = await createGameVsBot(
        undefined,
        compositeId,
        config("classic", 4, 5),
        true,
      );
      const guest = await openAndReadSnapshot(undefined, guestGame);
      const guestHuman = guest.snapshot.players.find(
        (player) => player.configType === "human",
      );
      expect(guestHuman?.elo).toBeUndefined();
      expect(guestHuman?.ratingAtStart).toBeUndefined();

      reconnected.socket.ws.send(JSON.stringify({ type: "resign" }));
      const finished = await reconnected.socket.waitForMessage("state", {
        ignore: ["match-status"],
      });
      expect(finished.state.status).toBe("finished");
      reconnected.socket.ws.send(JSON.stringify({ type: "rematch-offer" }));
      const rematch = await reconnected.socket.waitForMessage(
        "rematch-started",
        { ignore: ["match-status"] },
      );
      expect(rematch.seat).toBeDefined();
      const rematchSocket = await openHumanSocket(
        existingAuthId,
        rematch.newGameId,
        rematch.seat!.socketToken,
      );
      humanSockets.push(rematchSocket);
      await rematchSocket.waitForMessage("state");
      const rematchStatus = await rematchSocket.waitForMessage("match-status");
      const rematchHuman = rematchStatus.snapshot.players.find(
        (player) => player.configType === "human",
      );
      expect(rematchHuman?.elo).toBe(1742);
      expect(rematchHuman?.ratingAtStart).toBe(1742);
    } finally {
      for (const socket of humanSockets) socket.close();
      botSocket?.close();
    }
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
      randomStart: false,
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

      // 4. Connect human player - this triggers BGS initialization
      humanSocket = await openHumanSocket(hostUserId, gameId, hostSocketToken);

      // 5. Bot receives start_game_session
      const startSession = await botSocket.waitForMessage("start_game_session");
      expect(startSession.bgsId).toBeDefined();
      expect(startSession.botId).toBe(botId);
      expect(startSession.config.variant).toBe("standard");
      expect(startSession.config.boardWidth).toBe(3);
      expect(startSession.config.boardHeight).toBe(3);

      const bgsId = startSession.bgsId;

      // Bot confirms session started
      botSocket.sendGameSessionStarted(bgsId, true);

      // 6. Bot receives initial evaluate_position request (ply 0)
      const initialEval = await botSocket.waitForMessage("evaluate_position");
      expect(initialEval.bgsId).toBe(bgsId);
      expect(initialEval.expectedPly).toBe(0);

      // Bot responds with evaluation and best move for human's turn
      botSocket.sendEvaluateResponse(bgsId, 0, "---", 0.0);

      // Wait for initial state
      const initialState = await humanSocket.waitForMessage("state");
      expect(initialState.state.status).toBe("playing");
      expect(initialState.state.turn).toBe(1); // Human's turn first
      const initialMatchStatus =
        await humanSocket.waitForMessage("match-status");
      expect(
        initialMatchStatus.snapshot.players.find(
          (player) => player.configType === "bot",
        )?.appearance,
      ).toMatchObject({
        dogSkin: "dog-puppy-07.svg",
        elephantSkin: "elephant-19.svg",
      });

      const humanPlayerId = 1;
      const botPlayerId = 2;

      // 7. Human makes a noop move ("---")
      const afterHumanMove = await humanMove(humanSocket, "---", 3);
      expect(afterHumanMove.state.turn).toBe(botPlayerId);

      // 8. Bot receives apply_move for human's move
      const applyHumanMove = await botSocket.waitForMessage("apply_move");
      expect(applyHumanMove.bgsId).toBe(bgsId);
      expect(applyHumanMove.expectedPly).toBe(0);
      expect(applyHumanMove.move).toBe("---");

      // Bot confirms move applied (new ply is 1)
      botSocket.sendMoveApplied(bgsId, 1);

      // 9. Bot receives evaluate_position for bot's turn (ply 1)
      const evalForBotTurn =
        await botSocket.waitForMessage("evaluate_position");
      expect(evalForBotTurn.bgsId).toBe(bgsId);
      expect(evalForBotTurn.expectedPly).toBe(1);

      // Bot responds with its best move - server will execute this move
      botSocket.sendEvaluateResponse(bgsId, 1, "---", -0.2);

      // 10. Bot receives apply_move for its own move (to sync internal state)
      const applyBotMove = await botSocket.waitForMessage("apply_move");
      expect(applyBotMove.bgsId).toBe(bgsId);
      expect(applyBotMove.expectedPly).toBe(1);
      expect(applyBotMove.move).toBe("---");

      // Bot confirms its move applied (new ply is 2)
      botSocket.sendMoveApplied(bgsId, 2);

      // 11. Bot receives evaluate_position for human's next turn (ply 2)
      // This is critical: server always has one evaluation "ahead"
      const evalForHumanTurn =
        await botSocket.waitForMessage("evaluate_position");
      expect(evalForHumanTurn.bgsId).toBe(bgsId);
      expect(evalForHumanTurn.expectedPly).toBe(2);

      // Bot responds with evaluation for human's position
      botSocket.sendEvaluateResponse(bgsId, 2, "---", 0.1);

      // Wait for state showing human's turn
      await waitForTurn(humanSocket, humanPlayerId);

      // 12. Human resigns to end game
      humanSocket.ws.send(JSON.stringify({ type: "resign" }));

      // Wait for game to end
      const finalState = await humanSocket.waitForMessage("state", {
        ignore: ["match-status"],
      });
      expect(finalState.state.status).toBe("finished");
      expect(finalState.state.result?.reason).toBe("resignation");
      expect(finalState.state.result?.winner).toBe(botPlayerId);

      // 13. Bot receives end_game_session
      const endSession = await botSocket.waitForMessage("end_game_session");
      expect(endSession.bgsId).toBe(bgsId);

      // Bot confirms session ended
      botSocket.sendGameSessionEnded(bgsId, true);
    } finally {
      humanSocket?.close();
      botSocket?.close();
    }
  }, 60000);

  /**
   * A human who moves before the engine answers must not cost the bot the game
   * (investigated for board task 5d076a25).
   *
   * The server keeps "one evaluation ahead": after the bot moves it asks the
   * engine to evaluate the position the HUMAN is about to move from. That
   * request is outstanding for as long as the human is thinking, so a human
   * who moves quickly lands on a BGS that already has one in flight — and
   * applyBgsMove and requestEvaluation both THROW rather than queue when
   * pendingResolvers already holds an entry for the game. Any throw on that
   * path resigns the bot.
   *
   * What saves it is the poll in the move handler, which waits up to 10s for
   * the in-flight request to clear before touching the BGS. This pins that:
   * without it, every human faster than their opponent's engine would hand the
   * bot a resignation.
   */
  it("does not resign the bot when the human moves during the look-ahead evaluation", async () => {
    const hostUserId = "host-race-probe";
    const clientId = "test-client-race";
    const botId = "race-bot";
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
      randomStart: false,
      rated: false,
      boardWidth: 3,
      boardHeight: 3,
      variantConfig: buildStandardInitialState(3, 3),
    };

    try {
      botSocket = await openBotSocket();
      botSocket.sendAttach(clientId, [createTestBotConfig(botId, "Race Bot")]);
      await botSocket.waitForMessage("attached");
      await waitForBotRegistration(compositeId, { variant: "standard" });

      const { gameId, socketToken } = await createGameVsBot(
        hostUserId,
        compositeId,
        gameConfig,
        true,
      );
      humanSocket = await openHumanSocket(hostUserId, gameId, socketToken);

      const startSession = await botSocket.waitForMessage("start_game_session");
      const bgsId = startSession.bgsId;
      botSocket.sendGameSessionStarted(bgsId, true);

      // The look-ahead evaluation for the human's first turn.
      const lookAhead = await botSocket.waitForMessage("evaluate_position");
      expect(lookAhead.expectedPly).toBe(0);

      // DELIBERATELY LEAVE IT OUTSTANDING and move as a fast human would.
      const { moveFromStandardNotation } =
        await import("../../shared/domain/standard-notation");
      const move = moveFromStandardNotation("---", 3);
      humanSocket.ws.send(JSON.stringify({ type: "submit-move", move }));

      // Give the server time to reach the move handler with the request still
      // in flight, then answer the evaluation as a real engine eventually would.
      await sleep(300);
      botSocket.sendEvaluateResponse(bgsId, 0, "---", 0.0);

      // The game must still be live. A regression here shows up as
      // result.reason "resignation" with the bot as the loser.
      const outcome = await waitForTurn(humanSocket, 1);
      expect(outcome.state.result).toBeUndefined();
      expect(outcome.state.status).toBe("playing");
    } finally {
      humanSocket?.close();
      botSocket?.close();
    }
  }, 60000);

  /**
   * A human who tries an illegal backtrack must be told no. The BOT must not
   * pay for it.
   *
   * Before board task 59a8c5a2, `applyMove` accepted a pawn that stepped to a
   * neighbour and back inside one submitted move, even though the rules forbid
   * it. The server then sent that move to the engine as notation, which collapses
   * a pawn's steps to its final cell — so the engine was handed a term naming the
   * cell the pawn already stood on, found no path of length zero, and refused it.
   * The server reads a refused apply_move as engine failure and resigns the bot
   * (`bgs-update-failed-after-human-move`). 17 bot games ended that way between
   * 2026-02-18 and 2026-08-09, each one a win the player never earned.
   *
   * With the rule fixed, the move dies in `applyPlayerMove`, which `handleMove`
   * calls BEFORE it touches the BGS. So the assertion that matters is not only
   * that the human gets an error: it is that the engine is never asked at all.
   */
  it("refuses a human backtrack without resigning the bot", async () => {
    const hostUserId = "host-backtrack";
    const clientId = "test-client-backtrack";
    const botId = "backtrack-bot";
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
      randomStart: false,
      rated: false,
      boardWidth: 3,
      boardHeight: 3,
      variantConfig: buildStandardInitialState(3, 3),
    };

    try {
      botSocket = await openBotSocket();
      botSocket.sendAttach(clientId, [
        createTestBotConfig(botId, "Backtrack Bot"),
      ]);
      await botSocket.waitForMessage("attached");
      await waitForBotRegistration(compositeId, { variant: "standard" });

      const { gameId, socketToken } = await createGameVsBot(
        hostUserId,
        compositeId,
        gameConfig,
        true,
      );
      humanSocket = await openHumanSocket(hostUserId, gameId, socketToken);

      const startSession = await botSocket.waitForMessage("start_game_session");
      const bgsId = startSession.bgsId;
      botSocket.sendGameSessionStarted(bgsId, true);

      const lookAhead = await botSocket.waitForMessage("evaluate_position");
      expect(lookAhead.expectedPly).toBe(0);
      botSocket.sendEvaluateResponse(bgsId, 0, "---", 0.0);

      const opening = await humanSocket.waitForMessage("state");
      expect(opening.state.turn).toBe(1);

      // The human's cat is on [0,0]. It steps to [0,1] and straight back — the
      // exact shape of the four stored rows that cannot be replayed.
      humanSocket.ws.send(
        JSON.stringify({
          type: "submit-move",
          move: {
            actions: [
              { type: "cat", target: [0, 1] },
              { type: "cat", target: [0, 0] },
            ],
          },
        }),
      );

      // 1. The human is told no, in as many words.
      const rejection = await humanSocket.waitForMessage("error", {
        ignore: ["state", "match-status"],
      });
      expect(rejection.message).toBe(
        "A pawn cannot immediately return to its previous cell",
      );

      // 2. THE ENGINE WAS NEVER ASKED. This is what makes the forfeit
      //    impossible rather than merely unlikely: no apply_move can fail if no
      //    apply_move is ever sent. A timeout is the pass; any message arriving
      //    (an apply_move, or an end_game_session from a resignation) fails with
      //    a different error, so this cannot pass for the wrong reason.
      let engineWasAsked: CustomBotServerMessage | null = null;
      let silence: Error | null = null;
      try {
        engineWasAsked = await botSocket.waitForMessage("apply_move");
      } catch (error) {
        silence = error as Error;
      }
      expect(engineWasAsked).toBeNull();
      expect(silence?.message).toMatch(/Timeout waiting for "apply_move"/);

      // 3. The session is unharmed: the same seat plays a LEGAL move and the
      //    game goes on. A refusal broadcasts no state of its own, so this is
      //    what shows the human was not left wedged — and it is the sharper
      //    assertion anyway, because it pins that the engine IS asked for a
      //    legal move. The silence above was the illegal move being stopped,
      //    not a dead socket.
      const afterLegal = await humanMove(humanSocket, "Cb3", 3);
      expect(afterLegal.state.status).toBe("playing");
      expect(afterLegal.state.result).toBeUndefined();
      expect(afterLegal.state.history).toHaveLength(1);
      expect(afterLegal.state.turn).toBe(2);

      const applied = await botSocket.waitForMessage("apply_move");
      expect(applied.bgsId).toBe(bgsId);
      expect(applied.move).toBe("Cb3");
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

  /**
   * The engine-session leak of board 8e148564.
   *
   * When start_game_session does not answer inside BGS_REQUEST_TIMEOUT_MS, the
   * server used to delete its local BGS and send the engine nothing. The
   * engine's own request could still complete afterwards, leaving it holding a
   * session the server had forgotten - and Deep Wallwars refuses new games past
   * 256 sessions per process.
   *
   * The timeout handler has to send explicitly because endBgs removes the
   * record that every later ORDINARY cleanup path uses to DISCOVER the remote
   * session: notifyBotGameEnded looks it up with getBgs(gameId), so once the
   * timeout handler had deleted it, the game ending later found nothing and
   * sent nothing. The placement before endBgs preserves the natural cleanup
   * order, but the direct send() does not depend on that order today.
   *
   * Measured 2026-08-16 across 7,378 games: this has fired ZERO times in
   * production. It is a correctness fix, not an incident response, which is why
   * the change is one send and not a drain protocol.
   *
   * These tests use drainMessages rather than waitForMessage because the server
   * acts at ten seconds and waitForMessage gives up at five.
   */
  const startTimeoutGameConfig: GameConfiguration = {
    timeControl: { initialSeconds: 600, incrementSeconds: 0, preset: "rapid" },
    variant: "standard",
    randomStart: false,
    rated: false,
    boardWidth: 3,
    boardHeight: 3,
    variantConfig: buildStandardInitialState(3, 3),
  };

  it("asks the engine to end a BGS whose start timed out", async () => {
    const clientId = "test-client-start-timeout";
    const botId = "timeout-bot";
    const compositeId = `${clientId}:${botId}`;
    let botSocket: BotSocket | null = null;
    let humanSocket: HumanSocket | null = null;

    try {
      botSocket = await openBotSocket();
      botSocket.sendAttach(clientId, [
        createTestBotConfig(botId, "Timeout Bot"),
      ]);
      await botSocket.waitForMessage("attached");
      await waitForBotRegistration(compositeId, { variant: "standard" });

      const { gameId, socketToken } = await createGameVsBot(
        "host-start-timeout",
        compositeId,
        startTimeoutGameConfig,
        true,
      );
      humanSocket = await openHumanSocket(
        "host-start-timeout",
        gameId,
        socketToken,
      );

      const start = await botSocket.waitForMessage("start_game_session");
      const { bgsId } = start;

      // The whole fixture: answer NOTHING, so the server's start request times
      // out. A wedged engine is exactly the case that used to leak.
      botSocket.drainMessages();
      await sleep(12_000);

      const afterTimeout = botSocket.drainMessages();
      const ends = afterTimeout.filter((m) => m.type === "end_game_session");
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({ type: "end_game_session", bgsId });

      // A late response now arrives, as it would from an engine that finished
      // after the server gave up. The server must not act on it: the BGS is
      // gone and the game is already over.
      botSocket.sendGameSessionStarted(bgsId, true);
      await sleep(500);
      const afterLate = botSocket.drainMessages();
      expect(
        afterLate.filter((m) => m.type === "evaluate_position"),
      ).toHaveLength(0);
    } finally {
      humanSocket?.close();
      botSocket?.close();
    }
  }, 60_000);

  it("sends no end_game_session when the start succeeds normally", async () => {
    // The control. Without it the test above is satisfied by a server that
    // sends end_game_session on EVERY start, which would tear down every
    // healthy game - so the new send has to be observed being conditional.
    const clientId = "test-client-start-ok";
    const botId = "ok-bot";
    const compositeId = `${clientId}:${botId}`;
    let botSocket: BotSocket | null = null;
    let humanSocket: HumanSocket | null = null;

    try {
      botSocket = await openBotSocket();
      botSocket.sendAttach(clientId, [createTestBotConfig(botId, "OK Bot")]);
      await botSocket.waitForMessage("attached");
      await waitForBotRegistration(compositeId, { variant: "standard" });

      const { gameId, socketToken } = await createGameVsBot(
        "host-start-ok",
        compositeId,
        startTimeoutGameConfig,
        true,
      );
      humanSocket = await openHumanSocket("host-start-ok", gameId, socketToken);

      const start = await botSocket.waitForMessage("start_game_session");
      botSocket.sendGameSessionStarted(start.bgsId, true);

      // The initial look-ahead must be answered or the game does not stay
      // healthy: an unanswered evaluate_position times out at ten seconds too,
      // resigns the bot, and ends the game - which sends end_game_session
      // through the ordinary game-end cleanup and would fail this test for a
      // reason that has nothing to do with the change. The first run did
      // exactly that. After this the human is on turn, so the server asks the
      // bot nothing more and the game simply waits.
      const initialEval = await botSocket.waitForMessage("evaluate_position");
      botSocket.sendEvaluateResponse(initialEval.bgsId, 0, "---", 0.0);
      botSocket.drainMessages();

      // Well past the ten-second BGS timeout, so a server that sent the end
      // unconditionally, or that failed to cancel the start timer on success,
      // would have shown it by now. The game is timed with 600 s and at move
      // zero, so neither its clock nor the five-minute unstarted-timed band can
      // end it inside this window either.
      await sleep(12_000);

      const seen = botSocket.drainMessages();
      expect(seen.filter((m) => m.type === "end_game_session")).toHaveLength(0);
    } finally {
      humanSocket?.close();
      botSocket?.close();
    }
  }, 60_000);

  it("still ends the BGS through game-end cleanup when the engine refuses", async () => {
    // The explicit success:false path, and the finding that kept it out of this
    // fix. handleGameSessionStarted clears the resolver without calling endBgs,
    // so the local BGS survives the refusal - which means the game ending
    // immediately afterwards DOES find it and sends the remote end. That is a
    // transient window, not a leak, and it must stay that way: this test is
    // what would notice if a later change deleted the BGS on refusal and
    // silently recreated the leak on a second path.
    //
    // All 7 production rows of this shape (2026-08-13) ended cleanly.
    const clientId = "test-client-refuse";
    const botId = "refuse-bot";
    const compositeId = `${clientId}:${botId}`;
    let botSocket: BotSocket | null = null;
    let humanSocket: HumanSocket | null = null;

    try {
      botSocket = await openBotSocket();
      botSocket.sendAttach(clientId, [
        createTestBotConfig(botId, "Refusing Bot"),
      ]);
      await botSocket.waitForMessage("attached");
      await waitForBotRegistration(compositeId, { variant: "standard" });

      const { gameId, socketToken } = await createGameVsBot(
        "host-refuse",
        compositeId,
        startTimeoutGameConfig,
        true,
      );
      humanSocket = await openHumanSocket("host-refuse", gameId, socketToken);

      const start = await botSocket.waitForMessage("start_game_session");
      botSocket.drainMessages();
      botSocket.sendGameSessionStarted(start.bgsId, false, "engine refused");

      await sleep(2_000);

      const seen = botSocket.drainMessages();
      const ends = seen.filter((m) => m.type === "end_game_session");
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({ bgsId: start.bgsId });
    } finally {
      humanSocket?.close();
      botSocket?.close();
    }
  }, 60_000);
});
