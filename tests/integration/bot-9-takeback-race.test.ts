/**
 * Regression test for the takeback replay race (found 2026-07-31, from the
 * production game Cb4nYTIS where "Easy Bot" resigned unprompted).
 *
 * The bug: a takeback in a bot game rebuilds the engine's game session and
 * replays the whole history into it. When a SECOND takeback arrived while
 * that replay was still in flight, the second takeback's endBgsSession
 * cancelled the first replay's pending request ("Request cancelled - session
 * ending"). The replay loop read that cancellation as an engine failure and
 * resigned the bot — handing the human a win they never played for.
 *
 * The supersede guard at the top of the replay loop could not catch it: the
 * cancellation always lands while the loop is parked on an await, so control
 * never reaches the guard. The fix checks the reset generation in the failure
 * branches too, where the two sibling paths (executeBotTurnV3 and the
 * human-move handler) already bail gracefully.
 *
 * The second test pins the other half: when a replay failure is REAL, the bot
 * resigns and the engine session must be released. resignBotOnFailure used to
 * skip notifyBotsGameEnded, so every forced resignation leaked a session on
 * the engine (capped at 256 per process) — visible in the production bot log
 * as a "Starting game session" with no matching "Ending game session".
 *
 * Harness (server bootstrap, sockets, helpers) mirrors
 * bot-6-bgs-init-race.test.ts, including its database note: no assertion here
 * depends on persistence, so a box without a container runtime runs it with a
 * placeholder DATABASE_URL.
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

describe("takeback replay race", () => {
  beforeAll(async () => {
    try {
      const handle = await setupEphemeralDb();
      container = handle.container;
      console.log("[bot-9] using ephemeral Postgres container");
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
      process.env.DATABASE_URL ??=
        "postgres://unused:unused@127.0.0.1:9/unused";
      console.log("[bot-9] no container runtime — running without a database");
    }
    await importServerModules();
    startTestServer();
  }, 120_000);

  afterAll(async () => {
    await stopTestServer();
    await teardownEphemeralDb(container);
  }, 60_000);

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

  /**
   * Play `rounds` full rounds of pass moves ("---"), answering every engine
   * request. Leaves the game with `rounds * 2` plies and the human to move.
   */
  async function playRounds(
    humanSocket: HumanSocket,
    botSocket: BotSocket,
    bgsId: string,
    rounds: number,
  ): Promise<void> {
    for (let round = 0; round < rounds; round++) {
      const plyBefore = round * 2;
      await humanMove(humanSocket, "---", 3);

      const applyHuman = await botSocket.waitForMessage("apply_move");
      expect(applyHuman.expectedPly).toBe(plyBefore);
      botSocket.sendMoveApplied(bgsId, plyBefore + 1);

      const evalBot = await botSocket.waitForMessage("evaluate_position");
      expect(evalBot.expectedPly).toBe(plyBefore + 1);
      botSocket.sendEvaluateResponse(bgsId, plyBefore + 1, "---", 0);

      const applyBot = await botSocket.waitForMessage("apply_move");
      expect(applyBot.expectedPly).toBe(plyBefore + 1);
      botSocket.sendMoveApplied(bgsId, plyBefore + 2);

      const evalHuman = await botSocket.waitForMessage("evaluate_position");
      expect(evalHuman.expectedPly).toBe(plyBefore + 2);
      botSocket.sendEvaluateResponse(bgsId, plyBefore + 2, "---", 0);
    }
  }

  /** Answer one takeback rebuild: session ended, restarted, history replayed. */
  async function serveReplay(
    botSocket: BotSocket,
    plies: number,
  ): Promise<string> {
    const end = await botSocket.waitForMessage("end_game_session");
    botSocket.ws.send(
      JSON.stringify({
        type: "game_session_ended",
        bgsId: end.bgsId,
        success: true,
        error: "",
      }),
    );
    const ended = await botSocket.waitForMessage("start_game_session");
    botSocket.sendGameSessionStarted(ended.bgsId, true);

    const initialEval = await botSocket.waitForMessage("evaluate_position");
    expect(initialEval.expectedPly).toBe(0);
    botSocket.sendEvaluateResponse(ended.bgsId, 0, "---", 0);

    for (let i = 0; i < plies; i++) {
      const apply = await botSocket.waitForMessage("apply_move");
      expect(apply.expectedPly).toBe(i);
      botSocket.sendMoveApplied(ended.bgsId, i + 1);

      const evaluate = await botSocket.waitForMessage("evaluate_position");
      expect(evaluate.expectedPly).toBe(i + 1);
      botSocket.sendEvaluateResponse(ended.bgsId, i + 1, "---", 0);
    }
    return ended.bgsId;
  }

  /** Record every state broadcast the human receives from now on. */
  function recordStates(
    humanSocket: HumanSocket,
  ): Extract<ServerMessage, { type: "state" }>[] {
    const states: Extract<ServerMessage, { type: "state" }>[] = [];
    humanSocket.ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      if (msg.type === "state") {
        states.push(msg);
      }
    });
    return states;
  }

  /** Wait for a recorded state matching `predicate` (states arrive async). */
  async function waitForState(
    states: Extract<ServerMessage, { type: "state" }>[],
    predicate: (
      state: Extract<ServerMessage, { type: "state" }>["state"],
    ) => boolean,
    timeoutMs = 5000,
  ): Promise<Extract<ServerMessage, { type: "state" }>["state"]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = states.find((s) => predicate(s.state));
      if (match) return match.state;
      await sleep(25);
    }
    throw new Error(
      `Timeout waiting for state. Seen: ${states
        .map((s) => `${s.state.status}/${s.state.history.length}`)
        .join(", ")}`,
    );
  }

  async function startBotGame(
    userId: string,
    clientId: string,
    botId: string,
  ): Promise<{
    botSocket: BotSocket;
    humanSocket: HumanSocket;
    bgsId: string;
  }> {
    const compositeId = `${clientId}:${botId}`;
    const botSocket = await openBotSocket();
    botSocket.sendAttach(clientId, [
      createTestBotConfig(botId, "Takeback Bot"),
    ]);
    await botSocket.waitForMessage("attached");
    await waitForBotRegistration(compositeId, { variant: "standard" });

    const { gameId, socketToken } = await createGameVsBot(
      userId,
      compositeId,
      gameConfig,
      true,
    );

    const humanSocket = await openHumanSocket(userId, gameId, socketToken);
    const initialState = await humanSocket.waitForMessage("state", {
      ignore: ["match-status"],
    });
    expect(initialState.state.status).toBe("playing");

    const startSession = await botSocket.waitForMessage("start_game_session");
    const bgsId = startSession.bgsId;
    botSocket.sendGameSessionStarted(bgsId, true);

    const initialEval = await botSocket.waitForMessage("evaluate_position");
    expect(initialEval.expectedPly).toBe(0);
    botSocket.sendEvaluateResponse(bgsId, 0, "---", 0);

    return { botSocket, humanSocket, bgsId };
  }

  it("does not resign the bot when a second takeback interrupts the first replay", async () => {
    let botSocket: BotSocket | null = null;
    let humanSocket: HumanSocket | null = null;

    try {
      const game = await startBotGame(
        "host-user-takeback",
        "test-client-takeback",
        "takeback-bot",
      );
      botSocket = game.botSocket;
      humanSocket = game.humanSocket;

      await playRounds(humanSocket, botSocket, game.bgsId, 4);

      const states = recordStates(humanSocket);

      // Takeback #1 (8 plies -> 6): serve the rebuild up to the first
      // replayed move, then HOLD that request in flight.
      humanSocket.ws.send(JSON.stringify({ type: "takeback-offer" }));

      await botSocket.waitForMessage("end_game_session");
      botSocket.ws.send(
        JSON.stringify({
          type: "game_session_ended",
          bgsId: game.bgsId,
          success: true,
          error: "",
        }),
      );
      const restart = await botSocket.waitForMessage("start_game_session");
      botSocket.sendGameSessionStarted(restart.bgsId, true);
      const replayEval = await botSocket.waitForMessage("evaluate_position");
      expect(replayEval.expectedPly).toBe(0);
      botSocket.sendEvaluateResponse(restart.bgsId, 0, "---", 0);

      const heldReplayMove = await botSocket.waitForMessage("apply_move");
      expect(heldReplayMove.expectedPly).toBe(0);

      // Takeback #2 (6 plies -> 4) lands while that request is pending. The
      // server cancels it; the first replay must recognise it was superseded
      // instead of reading the cancellation as an engine failure.
      humanSocket.ws.send(JSON.stringify({ type: "takeback-offer" }));

      // Drain the cancelled request the way a real client does — the engine
      // answers the request it was handed.
      await sleep(200);
      botSocket.sendMoveApplied(restart.bgsId, 1);

      // Second rebuild replays the surviving 4 plies.
      const secondBgsId = await serveReplay(botSocket, 4);

      // The game is alive and in sync: a further full round plays out.
      await humanMove(humanSocket, "---", 3);
      const applyHuman = await botSocket.waitForMessage("apply_move");
      expect(applyHuman.expectedPly).toBe(4);
      botSocket.sendMoveApplied(secondBgsId, 5);
      const evalBot = await botSocket.waitForMessage("evaluate_position");
      expect(evalBot.expectedPly).toBe(5);
      botSocket.sendEvaluateResponse(secondBgsId, 5, "---", 0);
      const applyBot = await botSocket.waitForMessage("apply_move");
      expect(applyBot.expectedPly).toBe(5);
      botSocket.sendMoveApplied(secondBgsId, 6);
      const evalHuman = await botSocket.waitForMessage("evaluate_position");
      expect(evalHuman.expectedPly).toBe(6);
      botSocket.sendEvaluateResponse(secondBgsId, 6, "---", 0);

      // The bot's move is broadcast only after its engine round-trip, which
      // is the response we just sent — wait for that final state.
      const last = await waitForState(
        states,
        (state) => state.history.length === 6,
      );
      expect(last.status).toBe("playing");
      expect(last.turn).toBe(1);

      const finished = states.filter((s) => s.state.status === "finished");
      expect(finished.map((s) => s.state.result)).toEqual([]);
    } finally {
      humanSocket?.close();
      botSocket?.close();
      await sleep(100);
    }
  }, 60_000);

  it("releases the engine session when a real replay failure resigns the bot", async () => {
    let botSocket: BotSocket | null = null;
    let humanSocket: HumanSocket | null = null;

    try {
      const game = await startBotGame(
        "host-user-resign",
        "test-client-resign",
        "resign-bot",
      );
      botSocket = game.botSocket;
      humanSocket = game.humanSocket;

      await playRounds(humanSocket, botSocket, game.bgsId, 2);

      const states = recordStates(humanSocket);

      // Takeback (4 plies -> 2), then fail the first replayed move for real:
      // no second takeback, so this IS an engine failure and resigning is
      // correct. What must not happen is the engine session being left open.
      humanSocket.ws.send(JSON.stringify({ type: "takeback-offer" }));

      await botSocket.waitForMessage("end_game_session");
      botSocket.ws.send(
        JSON.stringify({
          type: "game_session_ended",
          bgsId: game.bgsId,
          success: true,
          error: "",
        }),
      );
      const restart = await botSocket.waitForMessage("start_game_session");
      botSocket.sendGameSessionStarted(restart.bgsId, true);
      const replayEval = await botSocket.waitForMessage("evaluate_position");
      expect(replayEval.expectedPly).toBe(0);
      botSocket.sendEvaluateResponse(restart.bgsId, 0, "---", 0);

      const replayMove = await botSocket.waitForMessage("apply_move");
      expect(replayMove.expectedPly).toBe(0);
      botSocket.ws.send(
        JSON.stringify({
          type: "move_applied",
          bgsId: restart.bgsId,
          ply: 0,
          success: false,
          error: "engine rejected the move",
        }),
      );

      // The bot resigns...
      const endSession = await botSocket.waitForMessage("end_game_session");
      expect(endSession.bgsId).toBe(restart.bgsId);
      botSocket.ws.send(
        JSON.stringify({
          type: "game_session_ended",
          bgsId: restart.bgsId,
          success: true,
          error: "",
        }),
      );

      await sleep(300);
      const finished = states.filter((s) => s.state.status === "finished");
      expect(finished.length).toBeGreaterThan(0);
      expect(finished[0].state.result).toEqual({
        winner: 1,
        reason: "resignation",
      });
    } finally {
      humanSocket?.close();
      botSocket?.close();
      await sleep(100);
    }
  }, 60_000);
});
