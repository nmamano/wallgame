/**
 * The bot list is a ladder, and the first row is what a first-time visitor
 * plays. Two things decide it, and both are new:
 *
 * 1. `listOrder` - the order we chose, rather than the one alphabetical
 *    sorting happened to produce. For months that accident put Superhuman Bot
 *    at the top: 57% of new players took the first row and won 1 game in 58
 *    (production, 2026-08-07).
 * 2. `analysis` - which bot answers the site's own questions, split out from
 *    `officialToken` so a bot can be OURS (badged, listed, trusted with a
 *    custom setup) without being the one that supplies best-move suggestions
 *    or plays puzzles.
 *
 * Tested at the ROUTE because the interesting half is the server's, and
 * because the grant is a token check that no client-side test could exercise:
 * `analysis` is a request, and only a bot that also passed the official token
 * gets it. A config file cannot promote itself.
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";

import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type {
  BotConfig,
  CustomBotClientMessage,
  ListedBot,
} from "../../shared/contracts/custom-bot-protocol";

const TEST_OFFICIAL_TOKEN = "test-official-token";
process.env.OFFICIAL_BOT_TOKEN = TEST_OFFICIAL_TOKEN;

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ORDINARY_VARIANTS: BotConfig["variants"] = {
  standard: {
    boardWidth: { min: 5, max: 12 },
    boardHeight: { min: 5, max: 10 },
    recommended: [{ boardWidth: 8, boardHeight: 8 }],
  },
};

/**
 * Attached in an order that is deliberately NOT the order they should be
 * listed in, and not alphabetical either. If the listing came back in
 * registration order or by name, at least one of the assertions below would
 * still pass by luck - together they cannot.
 */
const LADDER: BotConfig[] = [
  {
    botId: "strong",
    name: "AAA Strong Bot",
    username: null,
    officialToken: TEST_OFFICIAL_TOKEN,
    analysis: true,
    listOrder: 3,
    variants: ORDINARY_VARIANTS,
  },
  {
    botId: "gentle",
    name: "ZZZ Gentle Bot",
    username: null,
    officialToken: TEST_OFFICIAL_TOKEN,
    listOrder: 1,
    variants: ORDINARY_VARIANTS,
  },
  {
    botId: "middle",
    name: "MMM Middle Bot",
    username: null,
    officialToken: TEST_OFFICIAL_TOKEN,
    listOrder: 2,
    variants: ORDINARY_VARIANTS,
  },
  {
    // Somebody else's bot, asking for everything it is not entitled to: no
    // token, but a claim to be the analysis engine and to sit at the top of
    // the ladder.
    botId: "stranger",
    name: "AAA Stranger Bot",
    username: null,
    analysis: true,
    listOrder: 0,
    variants: ORDINARY_VARIANTS,
  },
];

async function attachBots(clientId: string, bots: BotConfig[]) {
  const socket = new WebSocket(
    `${baseUrl.replace("http", "ws")}/ws/custom-bot`,
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const attach: CustomBotClientMessage = {
    type: "attach",
    protocolVersion: 3,
    clientId,
    bots,
    client: { name: "ladder-test", version: "1.0.0" },
  };
  socket.send(JSON.stringify(attach));
  await new Promise<void>((resolve) => {
    socket.on("message", (raw: Buffer) => {
      if (
        (JSON.parse(raw.toString()) as { type: string }).type === "attached"
      ) {
        resolve();
      }
    });
  });
  return socket;
}

const listBots = async (path: string): Promise<ListedBot[]> => {
  const res = await fetch(`${baseUrl}${path}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as
    | { bots: ListedBot[] }
    | { bots: { bot: ListedBot }[] };
  const first = body.bots[0] as unknown;
  // /api/bots returns bots; /api/bots/recommended returns bot+size entries.
  return typeof first === "object" && first !== null && "bot" in first
    ? (body.bots as { bot: ListedBot }[]).map((e) => e.bot)
    : (body.bots as ListedBot[]);
};

describe("the bot list is ordered by the ladder we chose", () => {
  let socket: WebSocket;

  beforeAll(async () => {
    container = (await setupEphemeralDb()).container;
    const { app, websocket } = (await import("../../server/index")).createApp();
    server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
    baseUrl = `http://localhost:${server.port}`;
    socket = await attachBots("ladder-client", LADDER);
    // The bot registry writes through to the DB asynchronously on attach.
    await sleep(200);
  });

  afterAll(async () => {
    socket?.close();
    await server?.stop(true);
    await teardownEphemeralDb(container);
  });

  it("lists ours gentlest-first, and somebody else's last", async () => {
    const names = (
      await listBots("/api/bots?variant=standard&boardWidth=8&boardHeight=8")
    ).map((b) => b.name);
    expect(names).toEqual([
      "ZZZ Gentle Bot",
      "MMM Middle Bot",
      "AAA Strong Bot",
      "AAA Stranger Bot",
    ]);
  });

  it("orders the recommended list the same way", async () => {
    // A separate code path with its own sort, and it used to have its own copy
    // of the comparison too. Two listings that disagree about which bot to
    // show first is exactly the bug this pins.
    const names = (
      await listBots("/api/bots/recommended?variant=standard")
    ).map((b) => b.name);
    expect(names).toEqual([
      "ZZZ Gentle Bot",
      "MMM Middle Bot",
      "AAA Strong Bot",
      "AAA Stranger Bot",
    ]);
  });

  it("grants analysis only to a bot that also passed the official token", async () => {
    const bots = await listBots(
      "/api/bots?variant=standard&boardWidth=8&boardHeight=8",
    );
    const byName = (name: string) => bots.find((b) => b.name === name)!;

    // Asked for it, is not official, does not get it. Nor does a listOrder of
    // 0 buy it the top of the list - see the ordering above.
    expect(byName("AAA Stranger Bot").isOfficial).toBe(false);
    expect(byName("AAA Stranger Bot").isAnalysisBot).toBe(false);

    // Official and asked for it.
    expect(byName("AAA Strong Bot").isAnalysisBot).toBe(true);

    // Official and did NOT ask: this is the case the whole split exists for.
    // Easy Bot is ours, badged as ours and listed first, and must still never
    // be the engine that answers "what is the best move here".
    expect(byName("ZZZ Gentle Bot").isOfficial).toBe(true);
    expect(byName("ZZZ Gentle Bot").isAnalysisBot).toBe(false);
  });
});
