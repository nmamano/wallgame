import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import type { StartedTestContainer } from "testcontainers";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";

let container: StartedTestContainer | undefined;
let db: typeof import("../../server/db").db;
let gamesTable: typeof import("../../server/db/schema/games").gamesTable;
let gameDetailsTable: typeof import("../../server/db/schema/game-details").gameDetailsTable;
let gamePlayersTable: typeof import("../../server/db/schema/game-players").gamePlayersTable;
let getReplayGameReadonly: typeof import("../../server/db/game-queries").getReplayGameReadonly;

const SERIES_ID = "historical-one-move-series";
const PREVIOUS_GAME_ID = "historical-series-opener";
const DRAW_GAME_ID = "historical-one-move-draw";

const playerRow = (input: {
  gameId: string;
  playerOrder: 1 | 2;
  playerRole: "host" | "joiner";
  outcomeRank: 1 | 2;
}) => ({
  ...input,
  playerConfigType: "friend",
  displayName: input.playerRole === "host" ? "Host" : "Joiner",
  outcomeReason: input.gameId === DRAW_GAME_ID ? "one-move-rule" : "capture",
});

beforeAll(async () => {
  const handle = await setupEphemeralDb();
  container = handle.container;

  db = (await import("../../server/db")).db;
  gamesTable = (await import("../../server/db/schema/games")).gamesTable;
  gameDetailsTable = (await import("../../server/db/schema/game-details"))
    .gameDetailsTable;
  gamePlayersTable = (await import("../../server/db/schema/game-players"))
    .gamePlayersTable;
  getReplayGameReadonly = (await import("../../server/db/game-queries"))
    .getReplayGameReadonly;
}, 120_000);

beforeEach(async () => {
  await db.delete(gamesTable);
});

afterAll(async () => {
  await teardownEphemeralDb(container);
}, 60_000);

describe("historical one-move-rule replay", () => {
  it("keeps the stored draw and its role-based series score", async () => {
    const startedAt = new Date("2026-01-01T00:00:00Z");
    await db.insert(gamesTable).values([
      {
        gameId: PREVIOUS_GAME_ID,
        variant: "standard",
        timeControl: "unlimited",
        rated: false,
        matchType: "friend",
        boardWidth: 3,
        boardHeight: 3,
        startedAt,
        movesCount: 3,
        seriesId: SERIES_ID,
        rematchNumber: 0,
      },
      {
        gameId: DRAW_GAME_ID,
        variant: "standard",
        timeControl: "unlimited",
        rated: false,
        matchType: "friend",
        boardWidth: 3,
        boardHeight: 3,
        startedAt: new Date(startedAt.getTime() + 1_000),
        movesCount: 3,
        seriesId: SERIES_ID,
        rematchNumber: 1,
      },
    ]);

    await db.insert(gameDetailsTable).values({
      gameId: DRAW_GAME_ID,
      configParameters: { initialState: buildStandardInitialState(3, 3) },
      moves: ["Cb2", "Ca3", "Cc1"],
    });

    await db.insert(gamePlayersTable).values([
      playerRow({
        gameId: PREVIOUS_GAME_ID,
        playerOrder: 1,
        playerRole: "host",
        outcomeRank: 1,
      }),
      playerRow({
        gameId: PREVIOUS_GAME_ID,
        playerOrder: 2,
        playerRole: "joiner",
        outcomeRank: 2,
      }),
      playerRow({
        gameId: DRAW_GAME_ID,
        playerOrder: 1,
        playerRole: "joiner",
        outcomeRank: 1,
      }),
      playerRow({
        gameId: DRAW_GAME_ID,
        playerOrder: 2,
        playerRole: "host",
        outcomeRank: 1,
      }),
    ]);

    const replay = await getReplayGameReadonly(DRAW_GAME_ID);

    expect(replay?.state.moveCount).toBe(3);
    expect(replay?.state.history).toHaveLength(3);
    expect(replay?.state.result).toEqual({ reason: "one-move-rule" });
    // Regression guard: the opener gives Host 1 and Joiner 0. The historical
    // draw adds 0.5 to each role. In this game Joiner is P1 and Host is P2,
    // so the role totals map to seat totals P1 0.5 and P2 1.5.
    expect(replay?.matchStatus.matchScore).toEqual({ 1: 0.5, 2: 1.5 });
  });
});
