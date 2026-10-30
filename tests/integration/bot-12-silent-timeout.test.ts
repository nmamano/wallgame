/**
 * A bot request that times out on a SILENT connection is a lost connection,
 * not an engine failure (task 43d8c5ae).
 *
 * Game E56U_8Ds (2026-10-25): the server sent apply_move during a network
 * stall, heard nothing for BGS_REQUEST_TIMEOUT_MS (10 s) and forfeited the bot
 * as an engine failure. The server had not seen the socket close, so the
 * disconnect grace never started. The client found the dead socket on its
 * next ping and reattached 13 s after the forfeit.
 *
 * Now a timeout with no frame at all since the request starts the disconnect
 * grace (60 s), and the reattach resync heals the game. A timeout after which
 * the socket still sent something (a ping) stays an engine failure.
 *
 * The harness is bot-7's autopilot bot, plus a `silent` switch that stops it
 * answering while its socket stays open. Times are scaled (see below).
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
} from "../../shared/contracts/custom-bot-protocol";

// Scaled time, so the file runs in seconds: request timeout 10 s -> 400 ms,
// grace 60 s -> 2400 ms. What matters is the order (a timeout, then a reattach
// inside the grace), and that the production grace is 60 s (asserted below).
// Both must be set before the server modules load (read at module init).
const TEST_REQUEST_TIMEOUT_MS = 400;
const TEST_GRACE_MS = 2400;

// ================================
// --- Test Harness ---
// ================================

let container: StartedTestContainer | undefined;
// Imported only after DATABASE_URL points at the ephemeral container.
let db: typeof import("../../server/db").db;
let gameDetailsTable: typeof import("../../server/db/schema/game-details").gameDetailsTable;
let eq: typeof import("drizzle-orm").eq;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

let createApp: typeof import("../../server/app").createApp;

async function importServerModules() {
  const serverModule = await import("../../server/app");
  createApp = serverModule.createApp;
  db = (await import("../../server/db")).db;
  gameDetailsTable = (await import("../../server/db/schema/game-details"))
    .gameDetailsTable;
  eq = (await import("drizzle-orm")).eq;
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
// --- HTTP Helpers ---
// ================================

interface PlayVsBotResponse {
  gameId: string;
  token: string;
  socketToken: string;
  role: "host" | "joiner";
  playerId: 1 | 2;
}

async function playVsBot(
  userId: string,
  botId: string,
  config: GameConfiguration,
  hostIsPlayer1?: boolean,
): Promise<{ status: number; body: PlayVsBotResponse | { error: string } }> {
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
  return {
    status: res.status,
    body: (await res.json()) as PlayVsBotResponse | { error: string },
  };
}

async function listBotIds(variant: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/api/bots?variant=${variant}`);
  const body = (await res.json()) as { bots: { id: string }[] };
  return body.bots.map((b) => b.id);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ================================
// --- Human Player WebSocket ---
// ================================

interface HumanSocket {
  ws: WebSocket;
  /** The game this socket is watching, for assertions against stored rows. */
  gameId: string;
  /** All states received, newest last. */
  states: Extract<ServerMessage, { type: "state" }>[];
  waitForState: (
    pred: (s: Extract<ServerMessage, { type: "state" }>) => boolean,
    timeoutMs?: number,
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

    const states: Extract<ServerMessage, { type: "state" }>[] = [];
    const waiters: {
      pred: (s: Extract<ServerMessage, { type: "state" }>) => boolean;
      resolve: (s: Extract<ServerMessage, { type: "state" }>) => void;
    }[] = [];

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      if (msg.type !== "state") return;
      states.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(msg)) {
          const w = waiters[i];
          waiters.splice(i, 1);
          w.resolve(msg);
        }
      }
    });

    ws.on("open", () => {
      resolve({
        ws,
        gameId,
        states,
        close: () => ws.close(),
        waitForState: (pred, timeoutMs = 10000) => {
          const existing = states.find(pred);
          if (existing) return Promise.resolve(existing);
          return new Promise((resolveWait, rejectWait) => {
            const timeout = setTimeout(() => {
              rejectWait(
                new Error(
                  `Timeout waiting for state. Seen: ${states
                    .map((s) => `n=${s.state.history.length}:${s.state.status}`)
                    .join(", ")}`,
                ),
              );
            }, timeoutMs);
            waiters.push({
              pred,
              resolve: (s) => {
                clearTimeout(timeout);
                resolveWait(s);
              },
            });
          });
        },
      });
    });

    ws.on("error", (err) => reject(err));
  });
}

async function humanMove(
  humanSocket: HumanSocket,
  moveNotation: string,
  boardHeight: number,
  expectedLength: number,
): Promise<void> {
  const { moveFromStandardNotation } =
    await import("../../shared/domain/standard-notation");
  const move = moveFromStandardNotation(moveNotation, boardHeight);
  humanSocket.ws.send(JSON.stringify({ type: "submit-move", move }));
  await humanSocket.waitForState(
    (s) => s.state.history.length >= expectedLength,
  );
}

// ================================
// --- Autopilot Bot WebSocket ---
// ================================

interface AutoBot {
  ws: WebSocket;
  clientId: string;
  transcript: CustomBotServerMessage[];
  waitFor: (
    pred: (m: CustomBotServerMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<CustomBotServerMessage>;
  /** Simulate a connection drop (client-side close). */
  drop: () => void;
  /**
   * While true the bot answers nothing and sends nothing, with its socket left
   * open: a stalled network, where the server sees no close.
   */
  silent: boolean;
  /** Requests this bot leaves unanswered (a hung engine), socket quiet. */
  hangs: (msg: CustomBotServerMessage) => boolean;
  /** The official client's keepalive frame (sent every 30 s in production). */
  ping: () => void;
}

function botConfigFor(botId: string): BotConfig {
  return {
    botId,
    name: `Bot ${botId}`,
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

/**
 * Opens a bot socket that automatically answers every protocol request and
 * records a transcript. Resolves once the server confirms the attach.
 */
async function openAutoBot(
  clientId: string,
  botIds: string[],
): Promise<AutoBot> {
  return new Promise((resolve, reject) => {
    const wsUrl = baseUrl.replace("http", "ws") + `/ws/custom-bot`;
    const ws = new WebSocket(wsUrl, {
      headers: { Origin: "http://localhost:5173" },
    });

    const transcript: CustomBotServerMessage[] = [];
    const waiters: {
      pred: (m: CustomBotServerMessage) => boolean;
      resolve: (m: CustomBotServerMessage) => void;
    }[] = [];
    let attachedResolve: ((bot: AutoBot) => void) | null = null;

    const sendMsg = (msg: CustomBotClientMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    const bot: AutoBot = {
      ws,
      clientId,
      transcript,
      drop: () => ws.close(),
      silent: false,
      hangs: () => false,
      ping: () => {
        if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}');
      },
      waitFor: (pred, timeoutMs = 10000) => {
        const existing = transcript.find(pred);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolveWait, rejectWait) => {
          const timeout = setTimeout(() => {
            rejectWait(
              new Error(
                `Timeout waiting for bot message. Transcript: ${transcript
                  .map((m) => m.type)
                  .join(", ")}`,
              ),
            );
          }, timeoutMs);
          waiters.push({
            pred,
            resolve: (m) => {
              clearTimeout(timeout);
              resolveWait(m);
            },
          });
        });
      },
    };

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as CustomBotServerMessage;
      transcript.push(msg);

      // Autopilot responses
      if (bot.silent || bot.hangs(msg)) {
        // A stalled connection or a hung engine: nothing goes back.
      } else if (msg.type === "attached" && attachedResolve) {
        const r = attachedResolve;
        attachedResolve = null;
        r(bot);
      } else if (msg.type === "start_game_session") {
        sendMsg({
          type: "game_session_started",
          bgsId: msg.bgsId,
          success: true,
          error: "",
        });
      } else if (msg.type === "end_game_session") {
        sendMsg({
          type: "game_session_ended",
          bgsId: msg.bgsId,
          success: true,
          error: "",
        });
      } else if (msg.type === "evaluate_position") {
        sendMsg({
          type: "evaluate_response",
          bgsId: msg.bgsId,
          ply: msg.expectedPly,
          bestMove: "---",
          evaluation: 0,
          success: true,
          error: "",
        });
      } else if (msg.type === "apply_move") {
        sendMsg({
          type: "move_applied",
          bgsId: msg.bgsId,
          ply: msg.expectedPly + 1,
          success: true,
          error: "",
        });
      }

      // Wake waiters
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(msg)) {
          const w = waiters[i];
          waiters.splice(i, 1);
          w.resolve(msg);
        }
      }
    });

    ws.on("open", () => {
      attachedResolve = resolve;
      sendMsg({
        type: "attach",
        protocolVersion: 3,
        clientId,
        bots: botIds.map(botConfigFor),
        client: { name: "silent-timeout-test-bot", version: "3.0.0" },
      });
    });

    ws.on("error", (err) => reject(err));
  });
}

// ================================
// --- Shared game setup ---
// ================================

const gameConfig: GameConfiguration = {
  timeControl: { initialSeconds: 600, incrementSeconds: 0, preset: "rapid" },
  variant: "standard",
  randomStart: false,
  rated: false,
  boardWidth: 3,
  boardHeight: 3,
  variantConfig: buildStandardInitialState(3, 3),
};

/** Create a game vs the bot and play one full round (human "---", bot "---"). */
async function startGameWithOneRound(
  userId: string,
  compositeId: string,
): Promise<HumanSocket> {
  const { status, body } = await playVsBot(
    userId,
    compositeId,
    gameConfig,
    true,
  );
  expect(status).toBe(201);
  const play = body as PlayVsBotResponse;
  const human = await openHumanSocket(userId, play.gameId, play.socketToken);
  await human.waitForState((s) => s.state.status === "playing");
  await humanMove(human, "---", 3, 1);
  // Bot's autopilot reply arrives as history length 2, back to human's turn.
  await human.waitForState(
    (s) => s.state.history.length >= 2 && s.state.turn === 1,
  );
  return human;
}

/**
 * The persisted game_details row, once it exists. Finish paths broadcast the
 * finished state before awaiting the write, so a read taken straight off the
 * state message finds nothing.
 */
async function waitForGameDetail(
  gameId: string,
  timeoutMs = 5000,
): Promise<typeof gameDetailsTable.$inferSelect> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await db
      .select()
      .from(gameDetailsTable)
      .where(eq(gameDetailsTable.gameId, gameId));
    if (row) return row;
    if (Date.now() > deadline) {
      throw new Error(`no game_details row for ${gameId} after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const latestState = (human: HumanSocket) =>
  human.states[human.states.length - 1].state;

// ================================
// --- Tests ---
// ================================

const reattachAfter = (ms: number) => sleep(ms);

describe("a bot request that times out on a silent connection", () => {
  beforeAll(async () => {
    process.env.BGS_REQUEST_TIMEOUT_MS = String(TEST_REQUEST_TIMEOUT_MS);
    process.env.BOT_DISCONNECT_GRACE_MS = String(TEST_GRACE_MS);
    const handle = await setupEphemeralDb();
    container = handle.container;
    await importServerModules();
    startTestServer();
  }, 120_000);

  afterAll(async () => {
    await stopTestServer();
    await teardownEphemeralDb(container);
  }, 60_000);

  it("uses a 60 s grace in production, so a reattach at ~45 s heals", async () => {
    const { DEFAULT_BOT_DISCONNECT_GRACE_MS } =
      await import("../../server/routes/custom-bot-socket");
    // The client finds a dead socket only on its next 30 s ping: up to about
    // 60 s after a stall starts, 50 s after a 10 s request timeout.
    expect(DEFAULT_BOT_DISCONNECT_GRACE_MS).toBe(60_000);
  });

  /**
   * The E56U_8Ds sequence: the human moves, the bot gets apply_move and goes
   * silent, the request times out. Returns once the timeout has passed.
   */
  const stallOnHumanMove = async (bot: AutoBot, human: HumanSocket) => {
    bot.silent = true;
    await humanMove(human, "---", 3, 3);
    await bot.waitFor((m) => m.type === "apply_move" && m.expectedPly === 2);
    await sleep(TEST_REQUEST_TIMEOUT_MS + 200);
  };

  const expectHealed = async (human: HumanSocket) => {
    // The resync replays the three moves and the bot plays its due turn.
    await human.waitForState(
      (s) => s.state.history.length >= 4 && s.state.turn === 1,
    );
    expect(latestState(human).status).toBe("playing");
  };

  it("keeps the game when the bot reattaches soon after the timeout", async () => {
    const clientId = "st-soon";
    const bot1 = await openAutoBot(clientId, ["b"]);
    const human = await startGameWithOneRound("user-st1", `${clientId}:b`);

    await stallOnHumanMove(bot1, human);
    // The timeout did not forfeit: the game waits in the grace.
    expect(latestState(human).status).toBe("playing");
    expect(await listBotIds("standard")).not.toContain(`${clientId}:b`);

    await reattachAfter(TEST_GRACE_MS * 0.1);
    const bot2 = await openAutoBot(clientId, ["b"]);
    await expectHealed(human);

    human.close();
    bot2.drop();
    bot1.drop();
  }, 30000);

  it("keeps the game when the bot reattaches late in the grace (the ~45 s of 60 s case)", async () => {
    const clientId = "st-late";
    const bot1 = await openAutoBot(clientId, ["b"]);
    const human = await startGameWithOneRound("user-st4", `${clientId}:b`);

    await stallOnHumanMove(bot1, human);
    // 45 s of a 60 s grace, scaled. The timeout already used part of the
    // stall, so this is later in the grace than the client would need.
    await reattachAfter(TEST_GRACE_MS * 0.75 - TEST_REQUEST_TIMEOUT_MS);
    expect(latestState(human).status).toBe("playing");
    const bot2 = await openAutoBot(clientId, ["b"]);
    await expectHealed(human);

    human.close();
    bot2.drop();
    bot1.drop();
  }, 30000);

  it("forfeits at grace expiry when the bot never comes back", async () => {
    const clientId = "st-gone";
    const bot1 = await openAutoBot(clientId, ["b"]);
    const human = await startGameWithOneRound("user-st2", `${clientId}:b`);

    await stallOnHumanMove(bot1, human);
    const finished = await human.waitForState(
      (s) => s.state.status === "finished",
      TEST_GRACE_MS + 8000,
    );
    expect(finished.state.result).toEqual({
      winner: 1,
      reason: "resignation",
    });
    const detail = await waitForGameDetail(human.gameId);
    expect(detail.botResignCause).toBe("client-disconnect");

    human.close();
    bot1.drop();
  }, 30000);

  it("forfeits after one reconnect cycle when the engine is hung on a quiet socket", async () => {
    // Without a bound this loops: the resync's request times out on the new
    // socket before its first ping, which looks silent again.
    const clientId = "st-loop";
    const bot1 = await openAutoBot(clientId, ["b"]);
    const human = await startGameWithOneRound("user-st5", `${clientId}:b`);

    await stallOnHumanMove(bot1, human);
    // The client comes back, but its engine answers no evaluation.
    const bot2 = await openAutoBot(clientId, ["b"]);
    bot2.hangs = (m) => m.type === "evaluate_position";

    const finished = await human.waitForState(
      (s) => s.state.status === "finished",
      TEST_REQUEST_TIMEOUT_MS * 2 + 5000,
    );
    expect(finished.state.result).toEqual({
      winner: 1,
      reason: "resignation",
    });
    const detail = await waitForGameDetail(human.gameId);
    expect(detail.botResignCause).toBe("bgs-initial-eval-failed:reattach");
    // The second timeout did not disconnect the client again.
    expect(await listBotIds("standard")).toContain(`${clientId}:b`);

    human.close();
    bot2.drop();
    bot1.drop();
  }, 30000);

  it("rebuilds a healthy game at most once while another game's engine hangs", async () => {
    // The collateral of one reconnect cycle: every silent disconnect makes the
    // reattach rebuild ALL games of the client. A healthy game is rebuilt once
    // and plays on. (This does not guard the once-per-grace bound: B's resync
    // traffic makes A's timeout non-silent. Test "forfeits after one reconnect
    // cycle" guards it.)
    const clientId = "st-two";
    const compositeId = `${clientId}:b`;
    const bot1 = await openAutoBot(clientId, ["b"]);
    const humanA = await startGameWithOneRound("user-st6a", compositeId);
    const humanB = await startGameWithOneRound("user-st6b", compositeId);

    await stallOnHumanMove(bot1, humanA);
    // The client comes back; game A's engine is hung, game B's is fine.
    const bot2 = await openAutoBot(clientId, ["b"]);
    bot2.hangs = (m) =>
      m.type === "evaluate_position" && m.bgsId === humanA.gameId;

    const finishedA = await humanA.waitForState(
      (s) => s.state.status === "finished",
      TEST_REQUEST_TIMEOUT_MS * 2 + 5000,
    );
    expect(finishedA.state.result).toEqual({
      winner: 1,
      reason: "resignation",
    });
    const detailA = await waitForGameDetail(humanA.gameId);
    expect(detailA.botResignCause).toBe("bgs-initial-eval-failed:reattach");

    // Game B still plays, and nothing rebuilds it again.
    await humanMove(humanB, "---", 3, 3);
    await humanB.waitForState(
      (s) => s.state.history.length >= 4 && s.state.turn === 1,
    );
    await sleep(TEST_REQUEST_TIMEOUT_MS * 3);
    const startsForB = bot2.transcript.filter(
      (m) => m.type === "start_game_session" && m.bgsId === humanB.gameId,
    );
    expect(startsForB).toHaveLength(1);
    expect(latestState(humanB).status).toBe("playing");

    humanA.close();
    humanB.close();
    bot2.drop();
    bot1.drop();
  }, 30000);

  it("forfeits at the timeout, as an engine failure, when the socket still talks", async () => {
    const clientId = "st-hung";
    const bot1 = await openAutoBot(clientId, ["b"]);
    const human = await startGameWithOneRound("user-st3", `${clientId}:b`);

    bot1.silent = true;
    await humanMove(human, "---", 3, 3);
    await bot1.waitFor((m) => m.type === "apply_move" && m.expectedPly === 2);
    // The engine is stuck, but the connection works: the keepalive arrives.
    bot1.ping();

    const finished = await human.waitForState(
      (s) => s.state.status === "finished",
      TEST_REQUEST_TIMEOUT_MS + 5000,
    );
    expect(finished.state.result).toEqual({
      winner: 1,
      reason: "resignation",
    });
    const detail = await waitForGameDetail(human.gameId);
    expect(detail.botResignCause).toBe("bgs-update-failed-after-human-move");
    // No disconnect: the client is still registered.
    expect(await listBotIds("standard")).toContain(`${clientId}:b`);

    human.close();
    bot1.drop();
  }, 30000);
});
