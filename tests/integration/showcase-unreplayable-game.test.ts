/**
 * The showcase must survive a stored game the current rules can no longer replay.
 *
 * `assembleReplayGame` replays every stored move through `GameState` and throws when a turn
 * does not fit the action budget. That throw used to propagate out of the whole batch, so ONE
 * bad row out of thousands took the entire 20-game showcase down - measured at roughly 8% of
 * requests on production, which is what made it look intermittent: each request draws a fresh
 * random sample (board task `eeaab7c1`).
 *
 * The seeded bad move is the real shape from production: a two-square pawn move paired with a
 * wall, three action-units in a two-action turn.
 *
 * Uses Testcontainers to spin up an ephemeral PostgreSQL database. Needs Docker.
 */

import {
  describe,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  expect,
} from "bun:test";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";

let container: StartedTestContainer | undefined;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

let db: typeof import("../../server/db").db;
let createApp: typeof import("../../server/index").createApp;
let gamesTable: typeof import("../../server/db/schema/games").gamesTable;
let gameDetailsTable: typeof import("../../server/db/schema/game-details").gameDetailsTable;

const REPLAYABLE_MOVE = "Cb8.Cc8";
// Two squares of cat plus a wall. Parses to three action-units, so `GameState` rejects it with
// "Only 2 actions remain in this turn" - verified against the domain before this test was written.
const UNREPLAYABLE_MOVE = "Cc8.>e5";

async function seedGame(gameId: string, moves: string[]): Promise<void> {
  await db.insert(gamesTable).values({
    gameId,
    variant: "standard",
    timeControl: "unlimited",
    rated: false,
    matchType: "friend",
    boardWidth: 8,
    boardHeight: 8,
    startedAt: new Date(),
    // The showcase filters on this column, not on the length of the move list.
    movesCount: 12,
  });

  await db.insert(gameDetailsTable).values({
    gameId,
    configParameters: { initialState: buildStandardInitialState(8, 8) },
    moves,
  });
}

beforeAll(async () => {
  const handle = await setupEphemeralDb();
  container = handle.container;

  const dbModule = await import("../../server/db");
  const serverModule = await import("../../server/index");
  const gamesSchemaModule = await import("../../server/db/schema/games");
  const detailsSchemaModule =
    await import("../../server/db/schema/game-details");

  db = dbModule.db;
  createApp = serverModule.createApp;
  gamesTable = gamesSchemaModule.gamesTable;
  gameDetailsTable = detailsSchemaModule.gameDetailsTable;

  const { app, websocket } = createApp();
  server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
}, 120_000);

beforeEach(async () => {
  await db.delete(gamesTable);
});

afterAll(async () => {
  if (server) {
    await server.stop(true);
  }
  await teardownEphemeralDb(container);
}, 60_000);

describe("showcase with an unreplayable game", () => {
  it("skips the bad game and still returns the good ones", async () => {
    await seedGame("good-0001", [REPLAYABLE_MOVE]);
    await seedGame("bad-0001", [UNREPLAYABLE_MOVE]);
    await seedGame("good-0002", [REPLAYABLE_MOVE]);

    const response = await fetch(`${baseUrl}/api/games/showcase?count=20`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      games: { matchStatus: { id: string } }[];
    };
    const ids = body.games.map((game) => game.matchStatus.id).sort();
    expect(ids).toEqual(["good-0001", "good-0002"]);
  });

  it("still 404s when every game is unreplayable, rather than 500ing", async () => {
    await seedGame("bad-0001", [UNREPLAYABLE_MOVE]);
    await seedGame("bad-0002", [UNREPLAYABLE_MOVE]);

    const response = await fetch(`${baseUrl}/api/games/showcase?count=20`);
    expect(response.status).toBe(404);
  });

  it("still fails loudly when a single game is requested by id", async () => {
    // The opposite policy on purpose: a caller who asked for THIS game has nothing else to be
    // given, so `getReplayGame` must not quietly hand back a half-built replay.
    await seedGame("bad-0001", [UNREPLAYABLE_MOVE]);

    const response = await fetch(`${baseUrl}/api/games/bad-0001`);
    expect(response.status).toBe(500);
  });
});
