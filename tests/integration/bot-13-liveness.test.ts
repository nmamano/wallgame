/**
 * Bot socket liveness and the official-bots status (task 9158770c).
 *
 * The bot client sends {"type":"ping"} every 30 s. Before this, the server
 * never checked that those pings kept coming: only Bun's default websocket
 * idle timeout (120 s) closed a silent bot socket, so its bots stayed listed
 * for about 2.5 minutes after the client went quiet (measured 2026-11-25).
 * Now an attached socket that sends nothing for BOT_PING_TIMEOUT_MS is closed
 * through the disconnect grace, and /api/bots says whether the official bots
 * are away.
 *
 * Times are scaled down: the ping timeout is TEST_PING_TIMEOUT_MS here, and a
 * healthy client pings at a third of it, as the real one pings at 30 s
 * against 75 s.
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type {
  BotConfig,
  CustomBotServerMessage,
  ListBotsResponse,
} from "../../shared/contracts/custom-bot-protocol";

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

let createApp: typeof import("../../server/app").createApp;
let getOfficialBotsStatus: typeof import("../../server/games/custom-bot-store").getOfficialBotsStatus;
let OFFICIAL_BOTS_STARTUP_WINDOW_MS: number;

// Read at module initialization, so set before the server modules load.
const TEST_PING_TIMEOUT_MS = 600;
const TEST_GRACE_MS = 300;
const TEST_OFFICIAL_TOKEN = "liveness-official-token";

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

interface BotSocket {
  /** Resolves with the close code and reason, whenever the socket closes. */
  closed: Promise<{ code: number; reason: string }>;
  isOpen: () => boolean;
  ping: () => void;
  drop: () => void;
}

const openSockets: BotSocket[] = [];

/** Opens a bot socket and resolves once the server confirms the attach. */
async function attachBot(
  clientId: string,
  botId: string,
  officialToken?: string,
): Promise<BotSocket> {
  const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/custom-bot`, {
    headers: { Origin: "http://localhost:5173" },
  });
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
    const message = JSON.parse(data.toString()) as CustomBotServerMessage;
    if (message.type === "attached") onAttached?.();
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
          bots: [botConfigFor(botId, officialToken)],
          client: { name: "liveness-test-bot", version: "3.0.0" },
        }),
      );
    });
  });
  const socket: BotSocket = {
    closed,
    isOpen: () => ws.readyState === WebSocket.OPEN,
    // The exact frame ws-client.ts sends: a text frame, not a ws ping.
    ping: () => ws.send('{"type":"ping"}'),
    drop: () => ws.close(),
  };
  openSockets.push(socket);
  return socket;
}

async function listBots(): Promise<ListBotsResponse> {
  const response = await fetch(`${baseUrl}/api/bots?variant=standard`);
  expect(response.status).toBe(200);
  return (await response.json()) as ListBotsResponse;
}

const listedIds = async (): Promise<string[]> =>
  (await listBots()).bots.map((bot) => bot.id);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A moment after the startup window, so the status can say "away". */
const afterStartup = () => Date.now() + OFFICIAL_BOTS_STARTUP_WINDOW_MS + 1;

beforeAll(async () => {
  process.env.BOT_PING_TIMEOUT_MS = String(TEST_PING_TIMEOUT_MS);
  process.env.BOT_DISCONNECT_GRACE_MS = String(TEST_GRACE_MS);
  process.env.OFFICIAL_BOT_TOKEN = TEST_OFFICIAL_TOKEN;

  const handle = await setupEphemeralDb();
  container = handle.container;
  const serverModule = await import("../../server/app");
  const storeModule = await import("../../server/games/custom-bot-store");
  createApp = serverModule.createApp;
  getOfficialBotsStatus = storeModule.getOfficialBotsStatus;
  OFFICIAL_BOTS_STARTUP_WINDOW_MS = storeModule.OFFICIAL_BOTS_STARTUP_WINDOW_MS;

  const { app, websocket } = createApp();
  server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
}, 120_000);

afterAll(async () => {
  for (const socket of openSockets) socket.drop();
  // Server-closed sockets can leave stop(true) pending; see bot-11.
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

describe("bot socket liveness", () => {
  it("keeps a client that only pings attached for many timeouts", async () => {
    const bot = await attachBot("live-pinger", "pinger", TEST_OFFICIAL_TOKEN);
    const pinger = setInterval(bot.ping, TEST_PING_TIMEOUT_MS / 3);
    try {
      // Four timeouts long: a ping that did not re-arm the timer would have
      // closed the socket three times over.
      await sleep(TEST_PING_TIMEOUT_MS * 4);
      expect(bot.isOpen()).toBe(true);
      expect(await listedIds()).toContain("live-pinger:pinger");
      expect(getOfficialBotsStatus(afterStartup())).toBe("online");
    } finally {
      clearInterval(pinger);
      bot.drop();
      await bot.closed;
      await sleep(TEST_GRACE_MS + 100);
    }
  });

  it("closes a silent client, hides its bots, and lets it reattach", async () => {
    const silent = await attachBot("silent", "quiet", TEST_OFFICIAL_TOKEN);
    expect(await listedIds()).toContain("silent:quiet");

    const closedAt = await Promise.race([
      silent.closed,
      sleep(TEST_PING_TIMEOUT_MS * 3).then(() => null),
    ]);
    expect(closedAt).toEqual({ code: 4001, reason: "No ping" });

    // In the disconnect grace now: hidden from the list at once, and the
    // official bots count as away (after the startup window).
    const listing = await listBots();
    expect(listing.bots.map((bot) => bot.id)).not.toContain("silent:quiet");
    expect(getOfficialBotsStatus(afterStartup())).toBe("away");

    // The client's next attach brings the bots back.
    const back = await attachBot("silent", "quiet", TEST_OFFICIAL_TOKEN);
    expect(await listedIds()).toContain("silent:quiet");
    expect(getOfficialBotsStatus(afterStartup())).toBe("online");
    back.drop();
    await back.closed;
    await sleep(TEST_GRACE_MS + 100);
  });
});

describe("official bots status", () => {
  it("is away with only a custom bot attached, and stays online inside the startup window", async () => {
    const custom = await attachBot("custom-only", "mine");
    const pinger = setInterval(custom.ping, TEST_PING_TIMEOUT_MS / 3);
    try {
      const listing = await listBots();
      // The custom bot stays listed while the official ones are away.
      expect(listing.bots.map((bot) => bot.id)).toContain("custom-only:mine");
      expect(getOfficialBotsStatus(afterStartup())).toBe("away");
      // A server that has just started does not call them away yet: the
      // official client re-attaches within seconds of a deploy.
      expect(getOfficialBotsStatus(Date.now())).toBe("online");
      expect(listing.officialBots).toBe("online");
    } finally {
      clearInterval(pinger);
      custom.drop();
      await custom.closed;
    }
  });
});
