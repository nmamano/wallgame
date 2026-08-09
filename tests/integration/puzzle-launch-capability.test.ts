/**
 * A puzzle launch must be refused when the chosen bot cannot play that
 * position — cleanly, before a game exists.
 *
 * Why this needs a test at the ROUTE rather than only on the rule: the client
 * decides what a puzzle card offers from the bot list, and then a person looks
 * at the page for a while before clicking. A bot can stop declaring a variant,
 * or disappear entirely, in that gap. Without a re-check the server would
 * happily create the game and the mismatch would surface later as a failed
 * engine call — a game that exists, looks playable, and never moves. That is
 * the exact shape of a bug already on the board (a bot game created but never
 * started), so it is worth refusing loudly instead.
 *
 * Puzzles now span TWO variants: the generated set is custom-setup-standard,
 * the authored set is custom-setup-classic. A bot serving only one of them is
 * therefore a normal state, not a corrupt one.
 */

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { WebSocket } from "ws";
import type { StartedTestContainer } from "testcontainers";
import { nanoid } from "nanoid";

import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type {
  BotConfig,
  CustomBotClientMessage,
} from "../../shared/contracts/custom-bot-protocol";
import { buildHandcraftedSeedRows } from "../../shared/domain/handcrafted-puzzle-rows";

const TEST_OFFICIAL_TOKEN = "test-official-token";
process.env.OFFICIAL_BOT_TOKEN = TEST_OFFICIAL_TOKEN;

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;
let db: typeof import("../../server/db").db;
let savedPuzzlesTable: typeof import("../../server/db/schema/saved-puzzles").savedPuzzlesTable;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A bot that serves ONLY the standard custom setup — no classic. */
const standardOnlyBot = (botId: string): BotConfig => ({
  botId,
  name: "Standard Only Bot",
  username: null,
  officialToken: TEST_OFFICIAL_TOKEN,
  // Puzzles are launched against the analysis bot, so a fixture that only
  // carried the token would now be refused by the launch route.
  analysis: true,
  variants: {
    "custom-setup-standard": {
      boardWidth: { min: 4, max: 12 },
      boardHeight: { min: 4, max: 10 },
      recommended: [{ boardWidth: 6, boardHeight: 6 }],
    },
  },
});

async function attachBot(clientId: string, bots: BotConfig[]) {
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
    client: { name: "capability-test", version: "1.0.0" },
  };
  socket.send(JSON.stringify(attach));
  await new Promise<void>((resolve) => {
    socket.on("message", (raw: Buffer) => {
      const parsed = JSON.parse(raw.toString()) as { type: string };
      if (parsed.type === "attached") resolve();
    });
  });
  return socket;
}

/**
 * Seeds one authored puzzle and returns its id. Seeded ONCE and reused across
 * the cases: legacy_scripted_id is UNIQUE, so re-seeding the same puzzle is
 * correctly refused by the table.
 */
async function seedPuzzle(index: number, sortIndex: number): Promise<string> {
  const row = buildHandcraftedSeedRows(1)[index];
  const id = nanoid(10);
  await db
    .insert(savedPuzzlesTable)
    .values({ ...row, id, sortIndex, enabled: true });
  return id;
}

async function play(botId: string, puzzleId: string) {
  return fetch(`${baseUrl}/api/bots/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botId, puzzleId, hostDisplayName: "Tester" }),
  });
}

describe("puzzle launch checks the bot can play the position", () => {
  let socket: WebSocket;
  /** A 4x4 custom-setup-classic puzzle (authored puzzle 1). */
  let classicPuzzleId: string;
  /** A 5x3 board, below every engine's floor (authored puzzle 3). */
  let tooSmallPuzzleId: string;
  const clientId = "capability-test-client";
  const compositeId = `${clientId}:capability-bot`;

  beforeAll(async () => {
    container = (await setupEphemeralDb()).container;
    db = (await import("../../server/db")).db;
    savedPuzzlesTable = (await import("../../server/db/schema/saved-puzzles"))
      .savedPuzzlesTable;
    const { app, websocket } = (await import("../../server/app")).createApp();
    server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
    baseUrl = `http://localhost:${server.port}`;
    socket = await attachBot(clientId, [standardOnlyBot("capability-bot")]);
    // The bot registry writes through to the DB asynchronously on attach.
    await sleep(200);
    classicPuzzleId = await seedPuzzle(0, 901);
    tooSmallPuzzleId = await seedPuzzle(2, 902);
  });

  afterAll(async () => {
    socket?.close();
    await server?.stop(true);
    await teardownEphemeralDb(container);
  });

  it("refuses a classic puzzle when the bot only declares the standard setup", async () => {
    // Puzzle 1 is a 4x4 custom-setup-classic board — a size this bot accepts,
    // so ONLY the variant differs. That is what makes the refusal meaningful
    // rather than an accident of board size.
    const res = await play(compositeId, classicPuzzleId);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("cannot play this position");
  });

  it("refuses a board smaller than the bot will take", async () => {
    // Puzzle 3 is 5x3. Three rows is below every engine's floor, so no bot
    // will ever accept it and the launch must not create a game.
    const res = await play(compositeId, tooSmallPuzzleId);
    expect(res.status).toBe(409);
  });

  it("refuses an unknown bot outright, rather than reaching the puzzle", async () => {
    const res = await play(`${clientId}:no-such-bot`, classicPuzzleId);
    const body = await res.text();
    expect({ status: res.status, body }).toMatchObject({ status: 404 });
  });

  it("ACCEPTS the same launch once a bot declares the variant", async () => {
    // The baseline that makes the refusals above evidence: with classic
    // declared, the identical request succeeds. Without this, a 409 could
    // simply mean the harness never worked.
    //
    // A SECOND client rather than a re-attach of the first: re-attaching the
    // same clientId puts the old registration into disconnect grace, and a
    // client in grace is refused new games on purpose — which would look like
    // the capability check failing when it is a different rule entirely.
    const capableClientId = "capability-test-client-2";
    const capableSocket = await attachBot(capableClientId, [
      {
        ...standardOnlyBot("classic-bot"),
        variants: {
          ...standardOnlyBot("classic-bot").variants,
          "custom-setup-classic": {
            boardWidth: { min: 4, max: 12 },
            boardHeight: { min: 4, max: 10 },
            recommended: [{ boardWidth: 6, boardHeight: 6 }],
          },
        },
      },
    ]);
    await sleep(200);

    const res = await play(`${capableClientId}:classic-bot`, classicPuzzleId);
    const body = await res.text();
    expect({ status: res.status, body }).toMatchObject({ status: 201 });
    capableSocket.close();
  });
});
