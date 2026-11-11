/**
 * Regression tests for the bot-client connection lifecycle (S-CX, 2026-07-26):
 *
 * 1. Reattach race: teardown used to be keyed by clientId, so a stale
 *    connection's close event (arriving after a new attach took over the
 *    same clientId) resigned the new registration's games, ended its BGS
 *    sessions, and unregistered the client. This was the reason bot restarts
 *    needed a 15-second kill-to-start gap. Teardown is now connection-scoped
 *    (a superseded socket's close touches nothing).
 *
 * 2. Disconnect grace: a routine websocket drop used to resign every active
 *    game instantly. Now the client gets BOT_DISCONNECT_GRACE_MS (default
 *    60s; 30s before task 43d8c5ae) to reattach; its games survive and are healed by a full BGS
 *    rebuild (resync) on the new connection. Grace expiry performs the old
 *    teardown, owned by a generation token so a reattach can never be torn
 *    down by a stale timer.
 *
 * The mock bot here is an "autopilot": it auto-answers every protocol
 *    request (sessions started, evaluations "---", moves applied) and records
 *    a transcript, because reconnect flows interleave messages in orders a
 *    strict expect-next-message harness cannot express.
 *
 * Database note: no assertion depends on database persistence. With Docker
 * the standard ephemeral Postgres is used; without a container runtime a
 * placeholder DATABASE_URL is set (postgres-js connects lazily; incidental
 * writes fail with caught-and-logged errors).
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

// Short grace so expiry tests run fast. Must be set before the server
// modules load (the constant is read at module initialization).
const TEST_GRACE_MS = 1500;
// Read at module initialization too.
const TEST_OFFICIAL_TOKEN = "lifecycle-official-token";

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
  /** Send a raw protocol message on this socket. */
  send: (msg: CustomBotClientMessage) => void;
  waitFor: (
    pred: (m: CustomBotServerMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<CustomBotServerMessage>;
  /** Simulate a connection drop (client-side close). */
  drop: () => void;
}

interface AutoBotOptions {
  /** Sent as every bot's officialToken. */
  officialToken?: string;
  /** Leave the evaluate_position for this ply unanswered (the test answers). */
  holdEvaluationAtPly?: number;
}

function botConfigFor(botId: string, officialToken?: string): BotConfig {
  return {
    botId,
    name: `Bot ${botId}`,
    officialToken,
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
  options: AutoBotOptions = {},
): Promise<AutoBot> {
  const { bot, reply } = await connectAutoBot(clientId, botIds, options);
  if (reply.type !== "attached") {
    throw new Error(`attach failed: ${JSON.stringify(reply)}`);
  }
  return bot;
}

type AttachReply = Extract<
  CustomBotServerMessage,
  { type: "attached" } | { type: "attach-rejected" }
>;

/** Sends an attach and resolves with the server's answer, either kind. */
async function connectAutoBot(
  clientId: string,
  botIds: string[],
  options: AutoBotOptions,
): Promise<{ bot: AutoBot; reply: AttachReply }> {
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
    let attachedResolve: ((reply: AttachReply) => void) | null = null;

    const sendMsg = (msg: CustomBotClientMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    const bot: AutoBot = {
      ws,
      clientId,
      transcript,
      send: sendMsg,
      drop: () => ws.close(),
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
      if (
        (msg.type === "attached" || msg.type === "attach-rejected") &&
        attachedResolve
      ) {
        const r = attachedResolve;
        attachedResolve = null;
        r(msg);
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
      } else if (
        msg.type === "evaluate_position" &&
        msg.expectedPly !== options.holdEvaluationAtPly
      ) {
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
      attachedResolve = (reply) => resolve({ bot, reply });
      sendMsg({
        type: "attach",
        protocolVersion: 3,
        clientId,
        bots: botIds.map((id) => botConfigFor(id, options.officialToken)),
        client: { name: "lifecycle-test-bot", version: "3.0.0" },
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

describe("bot connection lifecycle", () => {
  beforeAll(async () => {
    process.env.BOT_DISCONNECT_GRACE_MS = String(TEST_GRACE_MS);
    process.env.OFFICIAL_BOT_TOKEN = TEST_OFFICIAL_TOKEN;
    try {
      const handle = await setupEphemeralDb();
      container = handle.container;
      console.log("[bot-7] using ephemeral Postgres container");
    } catch (error) {
      // Fall back ONLY when no container runtime exists; any other failure
      // is a real regression and must fail the suite.
      const message = error instanceof Error ? error.message : String(error);
      const isNoContainerRuntime =
        message.includes("Could not find a working container runtime") ||
        message.includes("Docker is not running");
      if (!isNoContainerRuntime) {
        throw error;
      }
      process.env.DATABASE_URL ??=
        "postgres://unused:unused@127.0.0.1:9/unused";
      console.log("[bot-7] no container runtime — running without a database");
    }
    await importServerModules();
    startTestServer();
  }, 120_000);

  afterAll(async () => {
    await stopTestServer();
    await teardownEphemeralDb(container);
  }, 60_000);

  it("T1: a superseded connection's close does not tear down the new attach (reattach race)", async () => {
    const clientId = "lc-race";
    const compositeId = `${clientId}:b`;

    const official = { officialToken: TEST_OFFICIAL_TOKEN };
    const bot1 = await openAutoBot(clientId, ["b"], official);
    const human = await startGameWithOneRound("user-t1", compositeId);

    // New connection attaches with the SAME clientId and the token — the
    // server force-closes bot1 and resyncs the game onto bot2.
    const bot2 = await openAutoBot(clientId, ["b"], official);

    // bot1's socket gets closed by the server; its close event must not
    // destroy bot2's registration or the game.
    await bot2.waitFor((m) => m.type === "start_game_session");
    // Let bot1's close event and the resync fully settle.
    await sleep(300);

    expect(await listBotIds("standard")).toContain(compositeId);
    expect(latestState(human).status).toBe("playing");

    // The game continues over the new connection.
    await humanMove(human, "---", 3, 3);
    await human.waitForState(
      (s) => s.state.history.length >= 4 && s.state.turn === 1,
    );
    expect(latestState(human).status).toBe("playing");

    human.close();
    bot2.drop();
    bot1.drop();
  }, 30000);

  it("T2: games survive a drop and are healed by resync on reattach within grace", async () => {
    const clientId = "lc-grace";
    const compositeId = `${clientId}:b`;

    const bot1 = await openAutoBot(clientId, ["b"]);
    const human = await startGameWithOneRound("user-t2", compositeId);

    bot1.drop();
    await sleep(200); // let the server process the close

    // During grace: game alive, bot hidden from listings.
    expect(latestState(human).status).toBe("playing");
    expect(await listBotIds("standard")).not.toContain(compositeId);

    // Reattach within grace — resync rebuilds the BGS on the new socket.
    const bot2 = await openAutoBot(clientId, ["b"]);
    await bot2.waitFor((m) => m.type === "start_game_session");
    expect(await listBotIds("standard")).toContain(compositeId);

    // The game continues.
    await humanMove(human, "---", 3, 3);
    await human.waitForState(
      (s) => s.state.history.length >= 4 && s.state.turn === 1,
    );
    expect(latestState(human).status).toBe("playing");

    human.close();
    bot2.drop();
  }, 30000);

  it("T3: grace expiry resigns the games and a later reattach starts fresh", async () => {
    const clientId = "lc-expiry";
    const compositeId = `${clientId}:b`;

    const bot1 = await openAutoBot(clientId, ["b"]);
    const human = await startGameWithOneRound("user-t3", compositeId);

    bot1.drop();

    // The expiry observable: the human sees the bot resign.
    const finished = await human.waitForState(
      (s) => s.state.status === "finished",
      TEST_GRACE_MS + 8000,
    );
    expect(finished.state.result?.reason).toBe("resignation");
    expect(finished.state.result?.winner).toBe(1);
    expect(await listBotIds("standard")).not.toContain(compositeId);

    // The stored game must say WHY. A bot cannot resign as a game decision, so
    // every one of these is the server forfeiting on its behalf - and
    // game_players.outcome_reason records only the word "resignation", which
    // cannot tell a client restart from an engine that died. Fly keeps no
    // historical logs, so if the cause is not on the row it is unrecoverable.
    // The human is told the game is over BEFORE the row lands: resignBotGames
    // broadcasts the finished state and only then awaits the persist. So poll
    // rather than reading once off the back of the state message.
    const detail = await waitForGameDetail(human.gameId);
    expect(detail.botResignCause).toBe("client-disconnect");

    human.close();

    // Post-expiry reattach (stale-teardown ownership check): a fresh
    // registration works and can play a brand-new game.
    const bot2 = await openAutoBot(clientId, ["b"]);
    expect(await listBotIds("standard")).toContain(compositeId);
    const human2 = await startGameWithOneRound("user-t3b", compositeId);
    expect(latestState(human2).status).toBe("playing");

    human2.close();
    bot2.drop();
  }, 30000);

  it("T4: a human move made during the drop window is healed by the reattach resync", async () => {
    const clientId = "lc-midmove";
    const compositeId = `${clientId}:b`;

    const bot1 = await openAutoBot(clientId, ["b"]);
    const human = await startGameWithOneRound("user-t4", compositeId);

    bot1.drop();
    await sleep(200);

    // Human moves while the bot client is down: the game store accepts the
    // move, the BGS update fails quietly (grace), and no resignation fires.
    await humanMove(human, "---", 3, 3);
    await sleep(200);
    expect(latestState(human).status).toBe("playing");
    expect(latestState(human).history.length).toBe(3);

    // Reattach: the resync replays all three moves and the bot answers.
    const bot2 = await openAutoBot(clientId, ["b"]);
    await human.waitForState(
      (s) => s.state.history.length >= 4 && s.state.turn === 1,
    );
    expect(latestState(human).status).toBe("playing");

    human.close();
    bot2.drop();
  }, 30000);

  it("T5: a bot dropped by the replacement attach has its games resigned, kept bots carry on", async () => {
    const clientId = "lc-orphan";
    const keptId = `${clientId}:kept`;
    const droppedId = `${clientId}:dropped`;

    const official = { officialToken: TEST_OFFICIAL_TOKEN };
    const bot1 = await openAutoBot(clientId, ["kept", "dropped"], official);
    const humanKept = await startGameWithOneRound("user-t5a", keptId);
    const humanDropped = await startGameWithOneRound("user-t5b", droppedId);

    // Reattach declaring only "kept": the dropped bot's game must be
    // resigned, the kept bot's game must survive and resync.
    const bot2 = await openAutoBot(clientId, ["kept"], official);

    const dropFinished = await humanDropped.waitForState(
      (s) => s.state.status === "finished",
    );
    expect(dropFinished.state.result?.reason).toBe("resignation");

    await bot2.waitFor((m) => m.type === "start_game_session");
    await humanMove(humanKept, "---", 3, 3);
    await humanKept.waitForState(
      (s) => s.state.history.length >= 4 && s.state.turn === 1,
    );
    expect(latestState(humanKept).status).toBe("playing");

    const listed = await listBotIds("standard");
    expect(listed).toContain(keptId);
    expect(listed).not.toContain(droppedId);

    humanKept.close();
    humanDropped.close();
    bot2.drop();
    bot1.drop();
  }, 30000);

  it("T6: a cached composite id cannot start a game against a client in grace", async () => {
    const clientId = "lc-cached";
    const compositeId = `${clientId}:b`;

    const bot1 = await openAutoBot(clientId, ["b"]);
    expect(await listBotIds("standard")).toContain(compositeId);

    bot1.drop();
    await sleep(200);

    const { status, body } = await playVsBot(
      "user-t6",
      compositeId,
      gameConfig,
      true,
    );
    expect(status).toBe(404);
    expect((body as { error: string }).error).toContain("reconnecting");
  }, 30000);
  it("T7: a re-attach to an official client without the token is refused; the client keeps its games", async () => {
    const clientId = "lc-official";
    const compositeId = `${clientId}:b`;
    const official = { officialToken: TEST_OFFICIAL_TOKEN };

    const bot1 = await openAutoBot(clientId, ["b"], official);
    const human = await startGameWithOneRound("user-t7", compositeId);

    // No token, then a wrong token: both refused while bot1 is live.
    for (const officialToken of [undefined, "not-the-token"]) {
      const { bot, reply } = await connectAutoBot(clientId, ["b"], {
        officialToken,
      });
      expect(reply.type).toBe("attach-rejected");
      if (reply.type === "attach-rejected") {
        expect(reply.code).toBe("INVALID_OFFICIAL_TOKEN");
      }
      bot.drop();
    }
    await sleep(200);

    // The old connection was not touched and still plays the game.
    expect(bot1.ws.readyState).toBe(WebSocket.OPEN);
    expect(await listBotIds("standard")).toContain(compositeId);
    await humanMove(human, "---", 3, 3);
    await human.waitForState(
      (s) => s.state.history.length >= 4 && s.state.turn === 1,
    );
    expect(latestState(human).status).toBe("playing");

    // In the disconnect grace a tokenless attach is refused too, and the
    // client's own re-attach with the token still heals the game.
    bot1.drop();
    await sleep(200);
    const { bot: intruder, reply } = await connectAutoBot(clientId, ["b"], {});
    expect(reply.type).toBe("attach-rejected");
    intruder.drop();

    const bot2 = await openAutoBot(clientId, ["b"], official);
    await bot2.waitFor((m) => m.type === "start_game_session");
    expect(await listBotIds("standard")).toContain(compositeId);
    await humanMove(human, "---", 3, 5);
    await human.waitForState(
      (s) => s.state.history.length >= 6 && s.state.turn === 1,
    );
    expect(latestState(human).status).toBe("playing");

    human.close();
    bot2.drop();
  }, 30000);

  it("T8: a second connection cannot take over a live non-official client", async () => {
    const clientId = "lc-inuse";
    const compositeId = `${clientId}:b`;

    const bot1 = await openAutoBot(clientId, ["b"]);
    const human = await startGameWithOneRound("user-t8", compositeId);

    const { bot, reply } = await connectAutoBot(clientId, ["b"], {});
    expect(reply.type).toBe("attach-rejected");
    if (reply.type === "attach-rejected") {
      expect(reply.code).toBe("CLIENT_ID_IN_USE");
    }
    bot.drop();
    await sleep(200);

    expect(bot1.ws.readyState).toBe(WebSocket.OPEN);
    await humanMove(human, "---", 3, 3);
    await human.waitForState(
      (s) => s.state.history.length >= 4 && s.state.turn === 1,
    );
    expect(latestState(human).status).toBe("playing");

    human.close();
    bot1.drop();
  }, 30000);

  it("T9: a client whose id is a prefix of another's cannot answer its requests", async () => {
    const victimId = "lc-prefix-victim";
    const compositeId = `${victimId}:b`;

    // The victim leaves its move request (ply 1) for the test to answer.
    const victim = await openAutoBot(victimId, ["b"], {
      holdEvaluationAtPly: 1,
    });
    const intruder = await openAutoBot("lc-prefix", ["b"]);

    const { body } = await playVsBot("user-t9", compositeId, gameConfig, true);
    const play = body as PlayVsBotResponse;
    const human = await openHumanSocket(
      "user-t9",
      play.gameId,
      play.socketToken,
    );
    await human.waitForState((s) => s.state.status === "playing");
    await humanMove(human, "---", 3, 1);

    const request = await victim.waitFor(
      (m) => m.type === "evaluate_position" && m.expectedPly === 1,
    );
    if (request.type !== "evaluate_position") throw new Error("unreachable");
    const answer = {
      type: "evaluate_response",
      bgsId: request.bgsId,
      ply: request.expectedPly,
      bestMove: "---",
      evaluation: 0,
      success: true,
      error: "",
    } as const;

    // The intruder's answer is dropped: the bot does not move.
    intruder.send(answer);
    await sleep(300);
    expect(latestState(human).history.length).toBe(1);

    // The victim's own answer is still awaited and plays the move.
    victim.send(answer);
    await human.waitForState(
      (s) => s.state.history.length >= 2 && s.state.turn === 1,
    );
    expect(latestState(human).status).toBe("playing");

    human.close();
    intruder.drop();
    victim.drop();
  }, 30000);
  it("T10: an official clientId stays reserved for the token after its grace ends", async () => {
    const clientId = "lc-official-expired";
    const compositeId = `${clientId}:b`;
    const official = { officialToken: TEST_OFFICIAL_TOKEN };

    const bot1 = await openAutoBot(clientId, ["b"], official);
    bot1.drop();
    // Past the grace: the registration is gone.
    await sleep(TEST_GRACE_MS + 500);
    expect(await listBotIds("standard")).not.toContain(compositeId);

    const { bot: intruder, reply } = await connectAutoBot(clientId, ["b"], {});
    expect(reply.type).toBe("attach-rejected");
    if (reply.type === "attach-rejected") {
      expect(reply.code).toBe("INVALID_OFFICIAL_TOKEN");
    }
    intruder.drop();
    expect(await listBotIds("standard")).not.toContain(compositeId);

    const bot2 = await openAutoBot(clientId, ["b"], official);
    expect(await listBotIds("standard")).toContain(compositeId);
    bot2.drop();
  }, 30000);

  it("T11: ten anonymous clients attached first cannot keep the official client out", async () => {
    // Past the grace: the clients of the earlier tests are gone.
    await sleep(TEST_GRACE_MS + 500);

    const anonymous: AutoBot[] = [];
    for (let i = 0; i < 10; i++) {
      anonymous.push(await openAutoBot(`lc-cap-${i}`, ["b"]));
    }
    const { bot: eleventh, reply } = await connectAutoBot(
      "lc-cap-10",
      ["b"],
      {},
    );
    expect(reply.type).toBe("attach-rejected");
    if (reply.type === "attach-rejected") {
      expect(reply.code).toBe("TOO_MANY_CLIENTS");
    }
    eleventh.drop();

    // At the cap, a known anonymous clientId still reattaches in its grace.
    anonymous[0].drop();
    await sleep(200);
    anonymous[0] = await openAutoBot("lc-cap-0", ["b"]);

    // A fresh official clientId, as after a server restart.
    const official = await openAutoBot("lc-cap-official", ["b"], {
      officialToken: TEST_OFFICIAL_TOKEN,
    });
    expect(await listBotIds("standard")).toContain("lc-cap-official:b");

    official.drop();
    for (const bot of anonymous) bot.drop();
  }, 30000);

  it("T12: an official client attached first takes no anonymous slot", async () => {
    // Past the grace: the clients of T11 are gone.
    await sleep(TEST_GRACE_MS + 500);

    const official = await openAutoBot("lc-cap2-official", ["b"], {
      officialToken: TEST_OFFICIAL_TOKEN,
    });
    const anonymous: AutoBot[] = [];
    for (let i = 0; i < 10; i++) {
      anonymous.push(await openAutoBot(`lc-cap2-${i}`, ["b"]));
    }
    const { bot: eleventh, reply } = await connectAutoBot(
      "lc-cap2-10",
      ["b"],
      {},
    );
    expect(reply.type).toBe("attach-rejected");
    if (reply.type === "attach-rejected") {
      expect(reply.code).toBe("TOO_MANY_CLIENTS");
    }
    eleventh.drop();
    expect(await listBotIds("standard")).toContain("lc-cap2-official:b");

    official.drop();
    for (const bot of anonymous) bot.drop();
  }, 30000);

  it("T13: a community bot client is held to its share; an official bot game still starts", async () => {
    // Past the grace: the clients of the earlier tests are gone.
    await sleep(TEST_GRACE_MS + 500);
    const limit = 16; // MAX_SESSIONS_PER_COMMUNITY_CLIENT (bgs-store.ts)

    const community = await openAutoBot("lc-pool-community", ["b"]);
    const official = await openAutoBot("lc-pool-official", ["b"], {
      officialToken: TEST_OFFICIAL_TOKEN,
    });
    const humans: HumanSocket[] = [];
    const startsOf = (bot: AutoBot) =>
      bot.transcript.filter((m) => m.type === "start_game_session").length;

    // Each host connect starts the game's engine session.
    for (let i = 0; i < limit; i++) {
      const userId = `user-pool-${i}`;
      const { status, body } = await playVsBot(
        userId,
        "lc-pool-community:b",
        gameConfig,
        true,
      );
      expect(status).toBe(201);
      const play = body as PlayVsBotResponse;
      const human = await openHumanSocket(
        userId,
        play.gameId,
        play.socketToken,
      );
      humans.push(human);
      await human.waitForState((s) => s.state.status === "playing");
    }
    expect(startsOf(community)).toBe(limit);

    // One game more is refused at creation, with a reason.
    const refused = await playVsBot(
      "user-pool-extra",
      "lc-pool-community:b",
      gameConfig,
      true,
    );
    expect(refused.status).toBe(429);
    expect((refused.body as { error: string }).error).toContain("Try again");

    // The official bot is not held to the community client's share.
    const officialHuman = await startGameWithOneRound(
      "user-pool-official",
      "lc-pool-official:b",
    );
    humans.push(officialHuman);
    expect(startsOf(official)).toBe(1);
    expect(latestState(officialHuman).status).toBe("playing");

    for (const human of humans) human.close();
    community.drop();
    official.drop();
  }, 60000);

  it("T14: one requester is held to its official games in progress; another requester still starts one", async () => {
    // Past the grace: the clients of the earlier tests are gone.
    await sleep(TEST_GRACE_MS + 500);
    const limit = 8; // MAX_OFFICIAL_GAMES_PER_REQUESTER (bgs-store.ts)
    const compositeId = "lc-req-official:b";
    const official = await openAutoBot("lc-req-official", ["b"], {
      officialToken: TEST_OFFICIAL_TOKEN,
    });
    const humans: HumanSocket[] = [];
    const starts = () =>
      official.transcript.filter((m) => m.type === "start_game_session").length;

    // One signed-in requester; each host connect starts the game's session.
    for (let i = 0; i < limit; i++) {
      const { status, body } = await playVsBot(
        "user-req-a",
        compositeId,
        gameConfig,
        true,
      );
      expect(status).toBe(201);
      const play = body as PlayVsBotResponse;
      const human = await openHumanSocket(
        "user-req-a",
        play.gameId,
        play.socketToken,
      );
      humans.push(human);
      await human.waitForState((s) => s.state.status === "playing");
    }
    await official.waitFor(() => starts() === limit);

    const refused = await playVsBot(
      "user-req-a",
      compositeId,
      gameConfig,
      true,
    );
    expect(refused.status).toBe(429);
    expect((refused.body as { error: string }).error).toContain(
      "too many bot games",
    );

    const other = await startGameWithOneRound("user-req-b", compositeId);
    humans.push(other);
    expect(starts()).toBe(limit + 1);
    expect(latestState(other).status).toBe("playing");

    for (const human of humans) human.close();
    official.drop();
  }, 60000);
});
