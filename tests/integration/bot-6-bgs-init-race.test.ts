/**
 * Regression test for the BGS initialization race (found 2026-07-26).
 *
 * The bug: when the human's first move arrives while the initial
 * evaluate_position request is still in flight, the game store applies the
 * move (turn flips to the bot), and when initialization finishes the
 * bot-turn trigger used to check only "is it the bot's turn now" — firing
 * executeBotTurnV3 with the engine still at ply 0. The engine then played
 * its stale ply-0 best move from the position BEFORE the human's move, the
 * human-move handler's ply-count idempotency guard swallowed the human move
 * ("already up-to-date"), and the engine desynced from the game until the
 * bot force-resigned on the next human move.
 *
 * The fix: executeBotTurnV3 refuses to play unless the BGS ply matches the
 * game history length; the human-move handler catches the BGS up and
 * re-triggers the bot turn itself.
 *
 * This test holds the initial evaluate_position response, submits the
 * human's first move, then releases the response — and asserts the first
 * apply_move the bot client receives carries the HUMAN's move at ply 0
 * (not the bot's stale ply-0 best move), and that the game then proceeds
 * in sync for a further full round.
 *
 * Database note: no assertion in this test depends on database persistence
 * (the game is unrated and never completed). When Docker is available the
 * standard ephemeral Postgres is used (parity with the rest of the suite);
 * when no container runtime exists (e.g. a Linux box without Docker), a
 * placeholder DATABASE_URL is set instead — postgres-js connects lazily, and
 * the incidental writes that do occur (bot-listing registration, the
 * disconnect-resign persistence at teardown) fail with a caught-and-logged
 * connection error that does not affect the test.
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
  EvaluateResponseMessage,
  MoveAppliedMessage,
} from "../../shared/contracts/custom-bot-protocol";

// ================================
// --- Test Harness ---
// ================================

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

let createApp: typeof import("../../server/app").createApp;

async function importServerModules() {
  const serverModule = await import("../../server/app");
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
  if (!server) {
    return;
  }
  const stopResult = await Promise.race([
    server.stop(true).then(() => "stopped" as const),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 5000),
    ),
  ]);
  if (stopResult === "timeout") {
    await server.stop(false);
  }
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
}

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

async function listBots(filters: {
  variant: string;
}): Promise<{ bots: { id: string }[] }> {
  const params = new URLSearchParams();
  params.set("variant", filters.variant);
  const res = await fetch(`${baseUrl}/api/bots?${params.toString()}`);
  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(
      `Expected status 200 but got ${res.status}. Error: ${text}`,
    );
  }
  return (await res.json()) as { bots: { id: string }[] };
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
        const resolveNow = waitingResolve;
        waitingResolve = null;
        resolveNow(msg);
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
                rejectWait(
                  new Error(
                    `Timeout waiting for "${expectedType}". Buffer: ${
                      buffer.map((m) => m.type).join(", ") || "(empty)"
                    }`,
                  ),
                );
              }, 10000);

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
  sendAttach: (clientId: string, bots: BotConfig[]) => void;
  sendGameSessionStarted: (bgsId: string, success: boolean) => void;
  sendEvaluateResponse: (
    bgsId: string,
    ply: number,
    bestMove: string,
    evaluation: number,
  ) => void;
  sendMoveApplied: (bgsId: string, ply: number) => void;
  close: () => void;
}

async function openBotSocket(): Promise<BotSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl = baseUrl.replace("http", "ws") + `/ws/custom-bot`;
    const ws = new WebSocket(wsUrl, {
      headers: { Origin: "http://localhost:5173" },
    });

    const buffer: CustomBotServerMessage[] = [];
    let waitingResolve: ((msg: CustomBotServerMessage) => void) | null = null;

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as CustomBotServerMessage;
      if (waitingResolve) {
        const resolveNow = waitingResolve;
        waitingResolve = null;
        resolveNow(msg);
      } else {
        buffer.push(msg);
      }
    });

    ws.on("open", () => {
      resolve({
        ws,
        close: () => ws.close(),
        sendAttach: (clientId: string, bots: BotConfig[]) => {
          const msg: CustomBotClientMessage = {
            type: "attach",
            protocolVersion: 3,
            clientId,
            bots,
            client: { name: "test-bot", version: "3.0.0" },
          };
          ws.send(JSON.stringify(msg));
        },
        sendGameSessionStarted: (bgsId: string, success: boolean) => {
          const msg: GameSessionStartedMessage = {
            type: "game_session_started",
            bgsId,
            success,
            error: "",
          };
          ws.send(JSON.stringify(msg));
        },
        sendEvaluateResponse: (
          bgsId: string,
          ply: number,
          bestMove: string,
          evaluation: number,
        ) => {
          const msg: EvaluateResponseMessage = {
            type: "evaluate_response",
            bgsId,
            ply,
            bestMove,
            evaluation,
            success: true,
            error: "",
          };
          ws.send(JSON.stringify(msg));
        },
        sendMoveApplied: (bgsId: string, ply: number) => {
          const msg: MoveAppliedMessage = {
            type: "move_applied",
            bgsId,
            ply,
            success: true,
            error: "",
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
                rejectWait(
                  new Error(
                    `Timeout waiting for "${expectedType}". Buffer: ${
                      buffer.map((m) => m.type).join(", ") || "(empty)"
                    }`,
                  ),
                );
              }, 10000);

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
): Promise<Extract<ServerMessage, { type: "state" }>> {
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

function createTestBotConfig(botId: string, name: string): BotConfig {
  return {
    botId,
    name,
    username: null,
    variants: {
      standard: {
        boardWidth: { min: 3, max: 15 },
        boardHeight: { min: 3, max: 15 },
        recommended: [{ boardWidth: 3, boardHeight: 3 }],
      },
    },
  };
}

// ================================
// --- Main Test ---
// ================================

describe("BGS initialization race", () => {
  beforeAll(async () => {
    try {
      const handle = await setupEphemeralDb();
      container = handle.container;
      console.log("[bot-6] using ephemeral Postgres container");
    } catch (error) {
      // Fall back ONLY when no container runtime exists. Any other failure
      // (broken migration, container crash, ...) is a real regression and
      // must fail the suite, not be masked.
      const message = error instanceof Error ? error.message : String(error);
      const isNoContainerRuntime =
        message.includes("Could not find a working container runtime") ||
        message.includes("Docker is not running");
      if (!isNoContainerRuntime) {
        throw error;
      }
      // No assertion depends on the database (see file header); a
      // placeholder URL keeps the server importable — postgres-js connects
      // lazily, and the incidental writes fail with caught-and-logged errors.
      process.env.DATABASE_URL ??=
        "postgres://unused:unused@127.0.0.1:9/unused";
      console.log("[bot-6] no container runtime — running without a database");
    }
    await importServerModules();
    startTestServer();
  }, 120_000);

  afterAll(async () => {
    await stopTestServer();
    await teardownEphemeralDb(container);
  }, 60_000);

  it("does not play the bot's stale ply-0 move when the human moves during BGS initialization", async () => {
    const hostUserId = "host-user-race";
    const clientId = "test-client-race";
    const botId = "race-bot";
    const compositeId = `${clientId}:${botId}`;
    let botSocket: BotSocket | null = null;
    let humanSocket: HumanSocket | null = null;

    // The human's first move must be distinguishable from the bot's held
    // best move, so the apply_move assertion below is unambiguous.
    const humanFirstMove = "^a1.^b2";
    const botStaleBestMove = "---";

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

      // Human is Player 1 and moves first — the precondition for the race.
      const { gameId, socketToken } = await createGameVsBot(
        hostUserId,
        compositeId,
        gameConfig,
        true,
      );

      humanSocket = await openHumanSocket(hostUserId, gameId, socketToken);
      const initialState = await humanSocket.waitForMessage("state", {
        ignore: ["match-status"],
      });
      expect(initialState.state.status).toBe("playing");
      expect(initialState.state.turn).toBe(1);

      const startSession = await botSocket.waitForMessage("start_game_session");
      const bgsId = startSession.bgsId;
      botSocket.sendGameSessionStarted(bgsId, true);

      // Initial evaluation request arrives — HOLD the response to keep the
      // BGS initialization in flight.
      const initialEval = await botSocket.waitForMessage("evaluate_position");
      expect(initialEval.expectedPly).toBe(0);

      // Human moves while initialization is still pending. The game store
      // applies the move (turn flips to the bot) but the BGS has not seen it.
      const afterHumanMove = await humanMove(humanSocket, humanFirstMove, 3);
      expect(afterHumanMove.state.turn).toBe(2);
      expect(afterHumanMove.state.history.length).toBe(1);

      // Release the held initial evaluation. Before the fix, the server
      // reacted by playing botStaleBestMove from ply 0 — a move computed for
      // the position BEFORE the human's move — and silently dropped the
      // human's move from the engine.
      botSocket.sendEvaluateResponse(bgsId, 0, botStaleBestMove, 0.0);

      // The first apply_move must be the HUMAN's move at ply 0.
      const applyHumanMove = await botSocket.waitForMessage("apply_move");
      expect(applyHumanMove.bgsId).toBe(bgsId);
      expect(applyHumanMove.expectedPly).toBe(0);
      expect(applyHumanMove.move).toBe(humanFirstMove);
      botSocket.sendMoveApplied(bgsId, 1);

      // Bot's real turn proceeds from the post-human-move position (ply 1).
      const evalForBotTurn =
        await botSocket.waitForMessage("evaluate_position");
      expect(evalForBotTurn.expectedPly).toBe(1);
      botSocket.sendEvaluateResponse(bgsId, 1, "---", -0.1);

      const applyBotMove = await botSocket.waitForMessage("apply_move");
      expect(applyBotMove.expectedPly).toBe(1);
      expect(applyBotMove.move).toBe("---");
      botSocket.sendMoveApplied(bgsId, 2);

      const evalForHumanTurn =
        await botSocket.waitForMessage("evaluate_position");
      expect(evalForHumanTurn.expectedPly).toBe(2);
      botSocket.sendEvaluateResponse(bgsId, 2, "---", 0.0);

      // Human sees both moves, in order, and it is their turn again.
      const backToHuman = await waitForTurn(humanSocket, 1);
      expect(backToHuman.state.status).toBe("playing");
      expect(backToHuman.state.history.length).toBe(2);
      expect(backToHuman.state.history[0].notation).toBe(humanFirstMove);
      expect(backToHuman.state.history[1].notation).toBe("---");

      // One more full round proves the engine stayed in sync (before the
      // fix, the next human move failed engine-side and the bot resigned).
      const afterSecondMove = await humanMove(humanSocket, "---", 3);
      expect(afterSecondMove.state.status).toBe("playing");
      expect(afterSecondMove.state.history.length).toBe(3);

      const applySecondHumanMove = await botSocket.waitForMessage("apply_move");
      expect(applySecondHumanMove.expectedPly).toBe(2);
      expect(applySecondHumanMove.move).toBe("---");
      botSocket.sendMoveApplied(bgsId, 3);

      const evalForBotTurn2 =
        await botSocket.waitForMessage("evaluate_position");
      expect(evalForBotTurn2.expectedPly).toBe(3);
      botSocket.sendEvaluateResponse(bgsId, 3, "---", -0.1);

      const applyBotMove2 = await botSocket.waitForMessage("apply_move");
      expect(applyBotMove2.expectedPly).toBe(3);
      botSocket.sendMoveApplied(bgsId, 4);

      const evalForHumanTurn2 =
        await botSocket.waitForMessage("evaluate_position");
      expect(evalForHumanTurn2.expectedPly).toBe(4);
      botSocket.sendEvaluateResponse(bgsId, 4, "---", 0.0);

      const finalHumanState = await waitForTurn(humanSocket, 1);
      expect(finalHumanState.state.status).toBe("playing");
      expect(finalHumanState.state.history.length).toBe(4);
      // The game is deliberately left unfinished: completion would trigger
      // persistence, which requires the database this test may run without.
    } finally {
      humanSocket?.close();
      botSocket?.close();
    }
  }, 60000);
});
