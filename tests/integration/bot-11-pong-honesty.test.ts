/**
 * Pong honesty (board 6f22001d).
 *
 * A pong is the bot client's ONLY liveness signal: ws-client.ts sends
 * {"type":"ping"} every 30s and closes the connection when a pong does not come
 * back. So a server that pongs a socket whose client it no longer has
 * registered is telling that client a lie it has no other way to check - the
 * bots vanish from /api/bots, the client sits there believing it is attached,
 * and only a human restarting it ends the outage.
 *
 * This is defence in depth rather than a live defect: the race that motivated
 * it is fixed at f082e18f, and the one function that could have produced the
 * state on purpose was deleted in cbd8eaca. The point is that the NEXT such
 * path, whatever it is, should heal itself in about 30 seconds.
 *
 * The zombie is forced here the way that deleted function would have produced
 * it - unregisterClient() on a healthy attached client, socket left open - so
 * the test measures the honesty of the pong rather than any particular bug.
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type {
  CustomBotServerMessage,
  BotConfig,
} from "../../shared/contracts/custom-bot-protocol";

// ================================
// --- Test Harness ---
// ================================

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

let createApp: typeof import("../../server/app").createApp;
let unregisterClient: typeof import("../../server/games/custom-bot-store").unregisterClient;

async function importServerModules() {
  const serverModule = await import("../../server/app");
  const storeModule = await import("../../server/games/custom-bot-store");

  createApp = serverModule.createApp;
  unregisterClient = storeModule.unregisterClient;
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

interface BotSocket {
  ws: WebSocket;
  /** Every frame the server sent, newest last. */
  received: string[];
  /** Resolves with the close code and reason, whenever the socket closes. */
  closed: Promise<{ code: number; reason: string }>;
  ping: () => void;
  drop: () => void;
}

/** Every socket this file opened, so teardown can close all of them. */
const openSockets: BotSocket[] = [];

/** Opens a bot socket and resolves once the server confirms the attach. */
async function attachBot(clientId: string, botId: string): Promise<BotSocket> {
  const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/custom-bot`, {
    headers: { Origin: "http://localhost:5173" },
  });

  const received: string[] = [];
  let onAttached: (() => void) | undefined;
  let onClosed:
    | ((result: { code: number; reason: string }) => void)
    | undefined;

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    onClosed = resolve;
  });

  ws.on("close", (code: number, reason: Buffer) => {
    onClosed?.({ code, reason: reason.toString() });
  });

  ws.on("message", (data: Buffer) => {
    const text = data.toString();
    received.push(text);
    const message = JSON.parse(text) as CustomBotServerMessage;
    if (message.type === "attached") {
      onAttached?.();
    }
  });

  await new Promise<void>((resolve, reject) => {
    onAttached = resolve;
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "attach",
          protocolVersion: 3,
          clientId,
          bots: [botConfigFor(botId)],
          client: { name: "pong-honesty-test-bot", version: "3.0.0" },
        }),
      );
    });
  });

  const socket: BotSocket = {
    ws,
    received,
    closed,
    // The exact frame ws-client.ts sends. The server matches it as a string
    // before any typed parse, so it has to be byte-identical.
    ping: () => ws.send('{"type":"ping"}'),
    drop: () => ws.close(),
  };
  openSockets.push(socket);
  return socket;
}

async function listedBotIds(): Promise<string[]> {
  const response = await fetch(`${baseUrl}/api/bots?variant=standard`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { bots: { id: string }[] };
  return body.bots.map((bot) => bot.id);
}

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

// Nothing here depends on the grace window, and the default 30s outlives the
// whole file - a socket closed at the end of a test would still be holding a
// pending teardown when afterAll runs. Must be set before the server modules
// load, since the constant is read at module initialization.
const TEST_GRACE_MS = 300;

beforeAll(async () => {
  process.env.BOT_DISCONNECT_GRACE_MS = String(TEST_GRACE_MS);

  const handle = await setupEphemeralDb();
  container = handle.container;
  await importServerModules();

  const { app, websocket } = createApp();
  server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
}, 120_000);

afterAll(async () => {
  for (const socket of openSockets) {
    socket.drop();
  }

  // A socket the SERVER closed leaves Bun's stop(true) pending indefinitely -
  // measured here at 60s, the whole hook budget, with every client socket
  // already closed and awaited. It is a property of the harness, not of this
  // change: bot-10-connect-failure-shapes.test.ts drives server-initiated
  // closes too and carries the same race. Copied from there rather than
  // reinvented.
  if (server) {
    const stopped = await Promise.race([
      server.stop(true).then(() => "stopped" as const),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 5_000),
      ),
    ]);
    if (stopped === "timeout") await server.stop(false);
    server = null;
  }

  await teardownEphemeralDb(container);
}, 60_000);

// ================================
// --- Tests ---
// ================================

describe("a socket whose client is no longer registered", () => {
  it("is closed rather than ponged, and the client heals by reattaching", async () => {
    const clientId = "pong-honesty-client";
    const botId = "ph-bot";
    const compositeId = `${clientId}:${botId}`;

    const bot = await attachBot(clientId, botId);
    expect(await listedBotIds()).toContain(compositeId);

    // Force the registry loss. This is precisely what the deleted
    // cleanupStaleEntries did: drop the client from the bot store and leave
    // its websocket open and unaware.
    const removed = unregisterClient(clientId);
    expect(removed).not.toBeNull();

    // The outage is real, and this assertion is what makes the rest meaningful
    // - without it the test could pass against a server that never lost
    // anything.
    expect(await listedBotIds()).not.toContain(compositeId);

    // THE ZOMBIE. Before the fix the server answers this ping with a pong and
    // the socket stays open, so the client's only liveness signal says
    // everything is fine while its bots are unreachable, forever.
    bot.ping();
    await settle();

    expect(bot.received).not.toContain('{"type":"pong"}');

    const closure = await Promise.race([
      bot.closed,
      settle(2_000).then(() => null),
    ]);
    expect(closure).not.toBeNull();
    expect(closure?.reason).toMatch(/registration|registered/i);

    // The client's existing reconnect path is a fresh attach, unchanged - this
    // fix adds no protocol and no client change, so healing is just the client
    // doing what it already does when a connection drops.
    const healed = await attachBot(clientId, botId);
    expect(await listedBotIds()).toContain(compositeId);

    healed.drop();
  }, 60_000);

  it("gives a superseded socket silence, which is why the mapping check is unreachable", async () => {
    // Documents WHY the mapping-ownership arm of unpongableReason() cannot be
    // reached today, rather than leaving it as an untested claim. A socket that
    // loses its clientId to a newer attach is marked superseded, and superseded
    // frames are dropped before handleMessage runs - so the ping never gets as
    // far as the pong branch, and the old socket is never closed by it. That
    // path heals on the client's own no-pong timeout instead, which is slower
    // than a close but not an outage.
    const clientId = "superseded-client";
    const first = await attachBot(clientId, "sup-bot");
    const second = await attachBot(clientId, "sup-bot");

    first.ping();
    await settle();

    expect(first.received).not.toContain('{"type":"pong"}');
    expect(second.received).not.toContain('{"type":"pong"}');

    // The registration is healthy throughout - the newer socket owns it.
    expect(await listedBotIds()).toContain(`${clientId}:sup-bot`);

    first.drop();
    second.drop();
  }, 60_000);

  it("still pongs a socket that has not attached yet", async () => {
    // A socket that has not attached has claimed nothing, so there is nothing
    // it could be wrong about and no reason to close it. The official client
    // never pings this early - startPingLoop() runs from the attached handler
    // - but ping is outside the typed protocol and this fix is not allowed to
    // change the protocol, so a third-party client that does ping first must
    // still get its pong.
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/custom-bot`, {
      headers: { Origin: "http://localhost:5173" },
    });
    const received: string[] = [];
    let closedEarly = false;

    ws.on("message", (data: Buffer) => received.push(data.toString()));
    ws.on("close", () => (closedEarly = true));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    ws.send('{"type":"ping"}');
    await settle();

    expect(received).toContain('{"type":"pong"}');
    expect(closedEarly).toBe(false);

    ws.close();
  }, 60_000);

  it("still pongs a socket that does own its registration", async () => {
    // The control. Without it, a fix that closed every socket on every ping
    // would pass the test above, and the keepalive would be broken for every
    // healthy bot on the site.
    const bot = await attachBot("healthy-client", "healthy-bot");
    expect(await listedBotIds()).toContain("healthy-client:healthy-bot");

    bot.ping();
    await settle();

    expect(bot.received).toContain('{"type":"pong"}');

    const closure = await Promise.race([
      bot.closed,
      settle(500).then(() => null),
    ]);
    expect(closure).toBeNull();

    bot.drop();
  }, 60_000);
});
