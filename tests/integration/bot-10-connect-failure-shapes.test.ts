/**
 * Board 916af5bd: "a bot game can be created but never start, leaving the
 * player on a dead board."
 *
 * On 2026-08-03 three Guest vs bot games were created inside five seconds and
 * none of them ever moved. All three shared one shape: status "ready",
 * moveCount 0, `createdAt` EXACTLY EQUAL to `updatedAt`, and no mention of the
 * game id anywhere in the bot client's log. The prior investigation ruled out
 * the engine and the bot client, and located the break upstream of the bot -
 * the game was created over HTTP and the play session never began - but could
 * not say WHY, because the shape does not distinguish a browser that never
 * opened its websocket from a server that refused or dropped the handshake.
 *
 * This file settles what that shape proves. It creates a real bot game against
 * an autopilot mock bot client, then fails the websocket connect five different
 * ways, and measures the same four things for each:
 *
 *   - the session status
 *   - whether `createdAt === updatedAt`
 *   - whether the bot client was ever asked to start a session for the game
 *     (`start_game_session` carries the bgsId, which for these games IS the
 *     game id - the same evidence class as the incident's "zero mentions in
 *     the bot-client log")
 *   - whether the game is listed in /api/games/live
 *
 * It also demonstrates the instrumentation added with it: `socketConnects` on
 * the session, a per-game history of connect attempts. Every variant asserts
 * the recorded event sequence, because that sequence is the whole point - it
 * is what tells the four failure modes apart when the fingerprint cannot.
 *
 * Database note: as in bot-7, no assertion depends on database persistence.
 */

import { describe, it, beforeAll, afterAll, expect, spyOn } from "bun:test";
import { connect } from "node:net";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type {
  CustomBotServerMessage,
  CustomBotClientMessage,
  BotConfig,
} from "../../shared/contracts/custom-bot-protocol";
import type { LiveGameSummary } from "../../shared/contracts/games";
import type {
  SocketConnectEvent,
  SocketConnectRecord,
} from "../../server/games/store";

/**
 * The origin the app is served from in tests. `checkOrigin` allows only this
 * one when NODE_ENV is not "production".
 */
const ALLOWED_ORIGIN = "http://localhost:5173";

/**
 * An origin that is NOT on the allowlist. Chosen to look like the real thing:
 * production allows exactly `https://wallgame.io` and `https://wallgame.fly.dev`,
 * so any other host serving the same SPA is refused the socket while the
 * game-creating POST, which has no origin check at all, succeeds.
 */
const FOREIGN_ORIGIN = "https://www.wallgame.io";

/** How long to let any asynchronous bot-session start happen before judging it absent. */
const SETTLE_MS = 750;

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;
/** Captured at start so the raw-socket variant does not re-derive it. */
let serverPort: number;

let createApp: typeof import("../../server/app").createApp;
let getSession: typeof import("../../server/games/store").getSession;
let recordSocketConnect: typeof import("../../server/games/store").recordSocketConnect;
let summarizeSocketConnects: typeof import("../../server/games/store").summarizeSocketConnects;

async function importServerModules() {
  createApp = (await import("../../server/app")).createApp;
  const store = await import("../../server/games/store");
  getSession = store.getSession;
  recordSocketConnect = store.recordSocketConnect;
  summarizeSocketConnects = store.summarizeSocketConnects;
}

function startTestServer() {
  const { app, websocket } = createApp();
  server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  // `port` is optional in Bun's type because a unix-socket server has none.
  // This one is TCP on an ephemeral port, so an absent port is a broken setup,
  // not a case to paper over with a sentinel.
  if (server.port === undefined) {
    throw new Error("test server started without a TCP port");
  }
  serverPort = server.port;
  baseUrl = `http://localhost:${serverPort}`;
}

async function stopTestServer() {
  if (!server) return;
  const stopResult = await Promise.race([
    server.stop(true).then(() => "stopped" as const),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 5000),
    ),
  ]);
  if (stopResult === "timeout") await server.stop(false);
  server = null;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ================================
// --- Autopilot bot client ---
// ================================

interface AutoBot {
  ws: WebSocket;
  transcript: CustomBotServerMessage[];
  drop: () => void;
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
        recommended: [{ boardWidth: 8, boardHeight: 8 }],
      },
    },
  };
}

/** Answers every protocol request and records what it was asked. */
async function openAutoBot(
  clientId: string,
  botIds: string[],
): Promise<AutoBot> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace("http", "ws") + `/ws/custom-bot`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const transcript: CustomBotServerMessage[] = [];
    const bot: AutoBot = { ws, transcript, drop: () => ws.close() };

    const send = (msg: CustomBotClientMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as CustomBotServerMessage;
      transcript.push(msg);
      if (msg.type === "attached") {
        resolve(bot);
      } else if (msg.type === "start_game_session") {
        send({
          type: "game_session_started",
          bgsId: msg.bgsId,
          success: true,
          error: "",
        });
      } else if (msg.type === "evaluate_position") {
        send({
          type: "evaluate_response",
          bgsId: msg.bgsId,
          ply: msg.expectedPly,
          bestMove: "---",
          evaluation: 0,
          success: true,
          error: "",
        });
      } else if (msg.type === "apply_move") {
        send({
          type: "move_applied",
          bgsId: msg.bgsId,
          ply: msg.expectedPly + 1,
          success: true,
          error: "",
        });
      }
    });

    ws.on("open", () => {
      send({
        type: "attach",
        protocolVersion: 3,
        clientId,
        bots: botIds.map(botConfigFor),
        client: { name: "connect-shape-test-bot", version: "3.0.0" },
      });
    });
    ws.on("error", reject);
  });
}

/** Did the bot client get asked to start a session for this game? */
const botWasAskedToStart = (bot: AutoBot, gameId: string): boolean =>
  bot.transcript.some(
    (m) => m.type === "start_game_session" && m.bgsId === gameId,
  );

// ================================
// --- Game creation ---
// ================================

interface PlayVsBotResponse {
  gameId: string;
  token: string;
  socketToken: string;
}

/** The incident's configuration exactly: Standard Random Start 8x8 (bot games are untimed). */
async function createIncidentShapeGame(
  botCompositeId: string,
): Promise<PlayVsBotResponse> {
  const res = await fetch(`${baseUrl}/api/bots/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      botId: botCompositeId,
      config: {
        variant: "standard",
        randomStart: true,
        boardWidth: 8,
        boardHeight: 8,
      },
      hostDisplayName: "Guest",
      hostIsPlayer1: true,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as PlayVsBotResponse;
}

async function isListedLive(gameId: string): Promise<boolean> {
  const res = await fetch(`${baseUrl}/api/games/live`);
  const body = (await res.json()) as { games: LiveGameSummary[] };
  return body.games.some((g) => g.id === gameId);
}

// ================================
// --- Connect attempts ---
// ================================

const wsUrlFor = (gameId: string, token?: string): string =>
  baseUrl.replace("http", "ws") +
  `/ws/games/${gameId}${token === undefined ? "" : `?token=${token}`}`;

/**
 * Open a real player websocket. Resolves on open, rejects on a refused
 * handshake - which is the outcome most of these variants are after.
 */
async function openPlayerSocket(
  gameId: string,
  token: string,
  origin: string = ALLOWED_ORIGIN,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrlFor(gameId, token), {
      headers: { Origin: origin },
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/**
 * Assert that a handshake was refused. If it opened instead, the variant's
 * premise is wrong and the socket is closed before the failure is raised.
 */
async function expectHandshakeRefused(
  attempt: Promise<WebSocket>,
): Promise<void> {
  let opened: WebSocket;
  try {
    opened = await attempt;
  } catch {
    return;
  }
  opened.close();
  throw new Error("expected the websocket handshake to be refused");
}

/**
 * Reach the websocket endpoint with an ordinary GET: correct path, correct
 * origin, correct token if given, no upgrade headers.
 *
 * This is the "attempted and failed after the server said yes" case. The auth
 * middleware runs to completion and authorizes the connection; the upgrade
 * never happens, so `onOpen` never fires and no bot session ever starts.
 *
 * With no token it takes the spectator branch, which is the one that resolves
 * its outcome inside a try/catch.
 */
async function reachEndpointWithoutUpgrading(
  gameId: string,
  token?: string,
): Promise<number> {
  const query = token === undefined ? "" : `?token=${token}`;
  const res = await fetch(`${baseUrl}/ws/games/${gameId}${query}`, {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  return res.status;
}

/**
 * Open a TCP connection, send an incomplete HTTP request (no terminating blank
 * line), and destroy it. The server never dispatches the request at all.
 */
async function dropBeforeRequestCompletes(
  gameId: string,
  token: string,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = connect(serverPort, "localhost", () => {
      socket.write(
        `GET /ws/games/${gameId}?token=${token} HTTP/1.1\r\n` +
          `Host: localhost:${serverPort}\r\n` +
          `Origin: ${ALLOWED_ORIGIN}\r\n` +
          `Upgrade: websocket\r\n`,
        // deliberately no final CRLF
      );
      socket.destroy();
      resolve();
    });
    socket.on("error", () => resolve());
  });
  await sleep(100);
}

// ================================
// --- Measuring the fingerprint ---
// ================================

interface Fingerprint {
  variant: string;
  /** Printed so a reader can grep it against the `[ws-connect]` lines above. */
  gameId: string;
  status: string;
  createdEqualsUpdated: boolean;
  botAskedToStart: boolean;
  listedLive: boolean;
  connectEvents: string;
}

async function fingerprint(
  variant: string,
  gameId: string,
  bot: AutoBot,
): Promise<Fingerprint> {
  const session = getSession(gameId);
  return {
    variant,
    gameId,
    status: session.status,
    createdEqualsUpdated: session.createdAt === session.updatedAt,
    botAskedToStart: botWasAskedToStart(bot, gameId),
    listedLive: await isListedLive(gameId),
    connectEvents: summarizeSocketConnects(session.socketConnects),
  };
}

const outcomes = (record: SocketConnectRecord): string[] =>
  record.first.map((e: SocketConnectEvent) => `${e.role}:${e.outcome}`);

const measured: Fingerprint[] = [];

// ================================
// --- Tests ---
// ================================

describe("connect-failure shapes for a bot game that never starts", () => {
  const clientId = "connect-shapes";
  const compositeId = `${clientId}:b`;
  let bot: AutoBot;

  beforeAll(async () => {
    try {
      const handle = await setupEphemeralDb();
      container = handle.container;
      console.log("[bot-10] using ephemeral Postgres container");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNoContainerRuntime =
        message.includes("Could not find a working container runtime") ||
        message.includes("Docker is not running");
      if (!isNoContainerRuntime) throw error;
      process.env.DATABASE_URL ??=
        "postgres://unused:unused@127.0.0.1:9/unused";
      console.log("[bot-10] no container runtime — running without a database");
    }
    await importServerModules();
    startTestServer();
    bot = await openAutoBot(clientId, ["b"]);
  }, 120_000);

  afterAll(async () => {
    bot?.drop();
    await stopTestServer();
    await teardownEphemeralDb(container);

    // The repro transcript. Printed rather than asserted so a reader can see
    // every variant side by side, which is what makes the finding legible:
    // four different failures leave one indistinguishable fingerprint.
    console.log("\n=== board 916af5bd: connect-failure fingerprints ===");
    for (const f of measured) {
      console.log(
        [
          f.variant.padEnd(28),
          `game=${f.gameId}`.padEnd(16),
          `status=${f.status}`.padEnd(16),
          `createdAt==updatedAt=${String(f.createdEqualsUpdated)}`.padEnd(27),
          `botAskedToStart=${String(f.botAskedToStart)}`.padEnd(24),
          `listedLive=${String(f.listedLive)}`.padEnd(18),
          `events=[${f.connectEvents}]`,
        ].join(" "),
      );
    }
    console.log("=== end fingerprints ===\n");
  }, 60_000);

  it("V1: the game is never connected to at all", async () => {
    const play = await createIncidentShapeGame(compositeId);
    await sleep(SETTLE_MS);

    const f = await fingerprint("V1 never-attempted", play.gameId, bot);
    measured.push(f);

    // The incident fingerprint, reproduced.
    expect(f.status).toBe("ready");
    expect(f.createdEqualsUpdated).toBe(true);
    expect(f.botAskedToStart).toBe(false);
    expect(f.listedLive).toBe(true);
    expect(getSession(play.gameId).gameState.moveCount).toBe(0);

    // An empty record is what "nobody ever tried" looks like, and before this
    // record existed there was nothing that could say so.
    expect(outcomes(getSession(play.gameId).socketConnects)).toEqual([]);
    expect(getSession(play.gameId).socketConnects.total).toBe(0);

    // The exact string the abandon-timer line carries when it reaps a game
    // like this one half an hour later. The 30-minute timer itself is not
    // exercised here - only the summary it prints.
    expect(
      summarizeSocketConnects(getSession(play.gameId).socketConnects),
    ).toBe("none (total 0)");
  });

  it("V2: the websocket is refused for an invalid seat token", async () => {
    const play = await createIncidentShapeGame(compositeId);
    await expectHandshakeRefused(
      openPlayerSocket(play.gameId, "not-the-real-token"),
    );
    await sleep(SETTLE_MS);

    const f = await fingerprint("V2 rejected-token", play.gameId, bot);
    measured.push(f);

    // Same fingerprint as V1 in every respect the incident could observe.
    expect(f.status).toBe("ready");
    expect(f.createdEqualsUpdated).toBe(true);
    expect(f.botAskedToStart).toBe(false);
    expect(f.listedLive).toBe(true);

    // The record is what separates it from V1.
    expect(outcomes(getSession(play.gameId).socketConnects)).toEqual([
      "player:rejected-token",
    ]);
  });

  it("V3: the websocket is refused for an origin the allowlist omits", async () => {
    const play = await createIncidentShapeGame(compositeId);
    await expectHandshakeRefused(
      openPlayerSocket(play.gameId, play.socketToken, FOREIGN_ORIGIN),
    );
    await sleep(SETTLE_MS);

    const f = await fingerprint("V3 rejected-origin", play.gameId, bot);
    measured.push(f);

    expect(f.status).toBe("ready");
    expect(f.createdEqualsUpdated).toBe(true);
    expect(f.botAskedToStart).toBe(false);
    expect(f.listedLive).toBe(true);

    expect(outcomes(getSession(play.gameId).socketConnects)).toEqual([
      "player:rejected-origin",
    ]);
  });

  it("V4: the endpoint is reached and authorized but never upgraded", async () => {
    const play = await createIncidentShapeGame(compositeId);
    await reachEndpointWithoutUpgrading(play.gameId, play.socketToken);
    await sleep(SETTLE_MS);

    const f = await fingerprint("V4 authorized-not-upgraded", play.gameId, bot);
    measured.push(f);

    expect(f.status).toBe("ready");
    expect(f.createdEqualsUpdated).toBe(true);
    expect(f.botAskedToStart).toBe(false);
    expect(f.listedLive).toBe(true);

    // `authorized` with no `opened` after it: the server said yes and the
    // connection never arrived. This is the case the board asked to be able
    // to see, and it is invisible in every other measurement above.
    expect(outcomes(getSession(play.gameId).socketConnects)).toEqual([
      "player:authorized",
    ]);
  });

  it("V5: the connection is dropped before the request completes", async () => {
    const play = await createIncidentShapeGame(compositeId);
    await dropBeforeRequestCompletes(play.gameId, play.socketToken);
    await sleep(SETTLE_MS);

    const f = await fingerprint("V5 dropped-pre-dispatch", play.gameId, bot);
    measured.push(f);

    expect(f.status).toBe("ready");
    expect(f.createdEqualsUpdated).toBe(true);
    expect(f.botAskedToStart).toBe(false);
    expect(f.listedLive).toBe(true);

    // An honest limit of the instrumentation: a request the server never
    // finished reading is never dispatched, so nothing can record it. This is
    // the one failure mode that remains indistinguishable from V1.
    expect(outcomes(getSession(play.gameId).socketConnects)).toEqual([]);
  });

  it("V6 CONTROL: a normal connect starts the bot session and moves updatedAt", async () => {
    const play = await createIncidentShapeGame(compositeId);
    const created = getSession(play.gameId).createdAt;
    const ws = await openPlayerSocket(play.gameId, play.socketToken);
    await sleep(SETTLE_MS);

    const f = await fingerprint("V6 control normal-connect", play.gameId, bot);
    measured.push(f);

    // The control differs from V1-V5 on both observable axes, which is what
    // makes those five a finding rather than an untested setup.
    expect(f.botAskedToStart).toBe(true);
    expect(f.createdEqualsUpdated).toBe(false);
    expect(getSession(play.gameId).updatedAt).toBeGreaterThan(created);
    expect(outcomes(getSession(play.gameId).socketConnects)).toEqual([
      "player:authorized",
      "player:opened",
    ]);

    // ...and a close is recorded too, so "connected and left" reads
    // differently from "connected and still here" without consulting
    // `players[].connected`, which only ever describes the present.
    ws.close();
    await sleep(SETTLE_MS);
    expect(outcomes(getSession(play.gameId).socketConnects)).toEqual([
      "player:authorized",
      "player:opened",
      "player:closed",
    ]);
    measured.push(
      await fingerprint("V6b control after-close", play.gameId, bot),
    );
  });

  it("a spectator connect is recorded as a spectator, not as the seat", async () => {
    const play = await createIncidentShapeGame(compositeId);
    const spectator = new WebSocket(wsUrlFor(play.gameId), {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    await new Promise((resolve) => spectator.on("open", resolve));
    await sleep(SETTLE_MS);

    // A watched game is not a played game: the seat never connected, so no bot
    // session starts and `createdAt === updatedAt` still holds.
    expect(outcomes(getSession(play.gameId).socketConnects)).toEqual([
      "spectator:authorized",
      "spectator:opened",
    ]);
    expect(botWasAskedToStart(bot, play.gameId)).toBe(false);
    expect(getSession(play.gameId).createdAt).toBe(
      getSession(play.gameId).updatedAt,
    );
    spectator.close();
  });

  it("the record keeps the first events and counts every one past the cap", async () => {
    const play = await createIncidentShapeGame(compositeId);
    const record = getSession(play.gameId).socketConnects;

    // 30 attempts against a cap of 20, through the same writer the routes use.
    for (let i = 0; i < 30; i++) {
      recordSocketConnect(play.gameId, {
        role: "player",
        outcome: "rejected-token",
      });
    }

    expect(record.total).toBe(30);
    expect(record.first.length).toBe(20);
    // The FIRST events survive: how the game opened is what a dead-board
    // report is about, and a reconnect loop must not push it out.
    expect(record.first[0].outcome).toBe("rejected-token");
    expect(summarizeSocketConnects(record)).toContain("(total 30)");
  });

  it("a spectator that authorizes and never upgrades is not recorded as game-not-found", async () => {
    const play = await createIncidentShapeGame(compositeId);
    const status = await reachEndpointWithoutUpgrading(play.gameId);
    await sleep(SETTLE_MS);

    // The spectator branch resolves its outcome inside a try whose catch
    // records `game-not-found`. Anything that throws AFTER `getSession`
    // succeeded - an upgrade or dispatch failure, for instance - would be
    // recorded against a game that demonstrably exists, and the false pair
    // `spectator:authorized, spectator:game-not-found` would land on exactly
    // the authorized-but-never-opened class this record exists to identify.
    const record = getSession(play.gameId).socketConnects;
    expect(outcomes(record)).toEqual(["spectator:authorized"]);
    expect(outcomes(record)).not.toContain("spectator:game-not-found");

    measured.push(
      await fingerprint(
        `V7 spectator-not-upgraded (HTTP ${status})`,
        play.gameId,
        bot,
      ),
    );
  });

  it("socketConnects reaches no surface a player or spectator can read", async () => {
    const play = await createIncidentShapeGame(compositeId);
    const ws = await openPlayerSocket(play.gameId, play.socketToken);
    const socketPayloads: string[] = [];
    ws.on("message", (data: Buffer) => socketPayloads.push(data.toString()));

    const spectator = new WebSocket(wsUrlFor(play.gameId), {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    spectator.on("message", (data: Buffer) =>
      socketPayloads.push(data.toString()),
    );
    await new Promise((resolve) => spectator.on("open", resolve));

    const liveGamesSocket = new WebSocket(
      baseUrl.replace("http", "ws") + "/ws/live-games",
      { headers: { Origin: ALLOWED_ORIGIN } },
    );
    liveGamesSocket.on("message", (data: Buffer) =>
      socketPayloads.push(data.toString()),
    );
    await new Promise((resolve) => liveGamesSocket.on("open", resolve));

    const lobbySocket = new WebSocket(
      baseUrl.replace("http", "ws") + "/ws/lobby",
      { headers: { Origin: ALLOWED_ORIGIN } },
    );
    lobbySocket.on("message", (data: Buffer) =>
      socketPayloads.push(data.toString()),
    );
    await new Promise((resolve) => lobbySocket.on("open", resolve));

    await sleep(SETTLE_MS);

    // Enumerated rather than sampled: the risk with a "does the string appear"
    // check is not the string, it is a surface nobody listed. These are the
    // reads that carry live game data - HTTP first, then every socket above.
    const surfaces: { name: string; body: string }[] = [
      {
        name: "GET /api/games/live",
        body: await (await fetch(`${baseUrl}/api/games/live`)).text(),
      },
      {
        name: "GET /api/games/matchmaking",
        body: await (await fetch(`${baseUrl}/api/games/matchmaking`)).text(),
      },
      {
        name: "GET /api/games/:id (seat token)",
        body: await (
          await fetch(`${baseUrl}/api/games/${play.gameId}?token=${play.token}`)
        ).text(),
      },
      {
        name: "GET /api/games/:id (no token, spectator)",
        body: await (await fetch(`${baseUrl}/api/games/${play.gameId}`)).text(),
      },
      ...socketPayloads.map((body, i) => ({ name: `websocket #${i}`, body })),
    ];

    // The guarantee is structural - every builder in store.ts field-picks into
    // a GameSnapshot or LiveGameSummary rather than serializing a session - so
    // this test exists to notice the day somebody spreads a session instead.
    expect(socketPayloads.length).toBeGreaterThan(0);
    for (const surface of surfaces) {
      expect(`${surface.name}: ${surface.body}`).not.toContain(
        "socketConnects",
      );
    }

    ws.close();
    spectator.close();
    liveGamesSocket.close();
    lobbySocket.close();
  });

  it("a spectator naming a game that does not exist is still recorded as game-not-found", async () => {
    // The other direction of the test above, and the reason it is needed: a
    // fix that simply stopped recording `game-not-found` would satisfy that
    // one. The outcome has to survive for the case it was written for.
    //
    // It can only be observed in the log, because by definition there is no
    // session to hold it - which is itself the invariant after the flag went
    // in: `game-not-found` can no longer be stored against a real game.
    const infoSpy = spyOn(console, "info");
    try {
      await expectHandshakeRefused(
        new Promise<WebSocket>((resolve, reject) => {
          const ws = new WebSocket(wsUrlFor("no-such-game-id"), {
            headers: { Origin: ALLOWED_ORIGIN },
          });
          ws.on("open", () => resolve(ws));
          ws.on("error", reject);
        }),
      );

      const logged = infoSpy.mock.calls.some(
        (call) =>
          call[0] === "[ws-connect]" &&
          typeof call[1] === "object" &&
          call[1] !== null &&
          (call[1] as Record<string, unknown>).sessionId ===
            "no-such-game-id" &&
          (call[1] as Record<string, unknown>).outcome === "game-not-found" &&
          (call[1] as Record<string, unknown>).knownGame === false,
      );
      expect(logged).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("an attempt naming a game that does not exist is logged, not stored", () => {
    // Must not throw: an unknown id is exactly what a stale tab retries with.
    expect(() =>
      recordSocketConnect("no-such-game", {
        role: "player",
        outcome: "rejected-origin",
      }),
    ).not.toThrow();
  });
});
