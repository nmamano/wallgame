/**
 * A replay shows each side's clock as it was at the ply on screen (task
 * a7d286e7). Before 2026-10-30 only the notation was stored, and every reader
 * walked it again on made-up timestamps, so each ply showed "starting time plus
 * increments".
 *
 * One game is played through the real store with fixed timestamps, so every
 * clock below is exact. It covers an increment, a gift of time between moves
 * and a timeout, and is read back through the same path the replay page uses:
 * persistence -> getReplayGameReadonly -> client hydrate -> buildHistoryState.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";
import type { PartialGameConfiguration } from "../../server/games/store";
import type { Move, PlayerId } from "../../shared/domain/game-types";
import {
  hasRecordedClocks,
  hydrateGameStateFromSerialized,
} from "../../frontend/src/lib/game-state-utils";
import { buildHistoryState } from "../../frontend/src/lib/history-utils";
import { moveToStandardNotation } from "../../shared/domain/standard-notation";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";

let container: StartedTestContainer | undefined;
let db: typeof import("../../server/db").db;
let gamesTable: typeof import("../../server/db/schema/games").gamesTable;
let gameDetailsTable: typeof import("../../server/db/schema/game-details").gameDetailsTable;
let gamePlayersTable: typeof import("../../server/db/schema/game-players").gamePlayersTable;
let store: typeof import("../../server/games/store");
let persistCompletedGame: typeof import("../../server/games/persistence").persistCompletedGame;
let getReplayGameReadonly: typeof import("../../server/db/game-queries").getReplayGameReadonly;

beforeAll(async () => {
  const handle = await setupEphemeralDb();
  container = handle.container;
  db = (await import("../../server/db")).db;
  gamesTable = (await import("../../server/db/schema/games")).gamesTable;
  gameDetailsTable = (await import("../../server/db/schema/game-details"))
    .gameDetailsTable;
  gamePlayersTable = (await import("../../server/db/schema/game-players"))
    .gamePlayersTable;
  store = await import("../../server/games/store");
  persistCompletedGame = (await import("../../server/games/persistence"))
    .persistCompletedGame;
  getReplayGameReadonly = (await import("../../server/db/game-queries"))
    .getReplayGameReadonly;
}, 120_000);

beforeEach(async () => {
  await db.delete(gamesTable);
});

afterAll(async () => {
  await teardownEphemeralDb(container);
}, 60_000);

const CONFIG: PartialGameConfiguration = {
  boardHeight: 9,
  boardWidth: 9,
  rated: false,
  variant: "standard",
  timeControl: { initialSeconds: 60, incrementSeconds: 2 },
};

const wall = (
  row: number,
  col: number,
  wallOrientation: "vertical" | "horizontal",
): Move => ({
  actions: [{ type: "wall", target: [row, col], wallOrientation }],
});

/**
 * Seconds after the first move -> expected clocks [p1, p2] after that move.
 *   ply 1, P1 at  0: the clock starts on the first move   -> [62, 60]
 *   ply 2, P2 at 10: 60 - 10 + 2                          -> [62, 52]
 *   ply 3, P1 at 15: 62 - 5 + 2                           -> [59, 52]
 *   P1 gives P2 30 s                                       (82 for P2)
 *   ply 4, P2 at 27: 82 - 12 + 2, the gift shows from here -> [59, 72]
 *   P1 tries to move at 86.5: 59.5 s > 59 s left           -> timeout, [0, 72]
 */
const EXPECTED_AFTER_MOVE: [number, number][] = [
  [62, 60],
  [62, 52],
  [59, 52],
  [59, 72],
];
const EXPECTED_FINAL: [number, number] = [0, 72];

/** Plays the game above and returns its finished session. */
const playTimedOutGame = () => {
  const { session } = store.createGameSession({
    config: CONFIG,
    matchType: "friend",
    hostDisplayName: "Host",
    hostIsPlayer1: true,
  });
  store.joinGameSession({ id: session.id, displayName: "Joiner" });
  // Now or later, so no real timer can fire before the game ends.
  const t0 = Date.now();
  const at = (seconds: number) => t0 + seconds * 1000;
  const move = (playerId: PlayerId, m: Move, seconds: number) =>
    store.applyPlayerMove({
      id: session.id,
      playerId,
      move: m,
      timestamp: at(seconds),
    });

  move(1, wall(4, 4, "vertical"), 0);
  move(2, wall(2, 2, "vertical"), 10);
  move(1, wall(6, 6, "horizontal"), 15);
  store.giveTime({ id: session.id, playerId: 1, seconds: 30 });
  move(2, wall(4, 1, "horizontal"), 27);
  move(1, wall(6, 2, "horizontal"), 86.5);

  const finished = store.getSession(session.id);
  // Asserted, not assumed: if the last call were a move, every clock check
  // below would test a different game.
  expect(finished.gameState.status).toBe("finished");
  expect(finished.gameState.result).toEqual({ winner: 2, reason: "timeout" });
  return finished;
};

describe("replay clocks", () => {
  it("sends each move's real clock to a live client", () => {
    const session = playTimedOutGame();
    const serialized = store.serializeGameState(session);
    expect(serialized.history.map((entry) => entry.timeLeftSeconds)).toEqual(
      EXPECTED_AFTER_MOVE,
    );
    expect(serialized.timeLeft).toEqual({
      1: EXPECTED_FINAL[0],
      2: EXPECTED_FINAL[1],
    });
  });

  it("stores the clocks and shows them at every ply of the replay", async () => {
    const session = playTimedOutGame();
    await persistCompletedGame(session);

    const [details] = await db
      .select({ clocks: gameDetailsTable.clocks })
      .from(gameDetailsTable);
    expect(details?.clocks).toEqual({
      afterMove: EXPECTED_AFTER_MOVE,
      final: EXPECTED_FINAL,
    });

    const replay = await getReplayGameReadonly(session.id);
    expect(replay).not.toBeNull();
    const serialized = replay!.state;
    expect(serialized.timeLeft).toEqual({ 1: 0, 2: 72 });

    const hydrated = hydrateGameStateFromSerialized(
      serialized,
      serialized.config,
    );
    expect(hasRecordedClocks(hydrated)).toBe(true);
    // The finished position: the timed-out side is at 0.
    expect(hydrated.timeLeft).toEqual({ 1: 0, 2: 72 });

    const clockAt = (cursor: number) =>
      buildHistoryState({
        config: hydrated.config,
        historyEntries: hydrated.history,
        cursor,
      })?.timeLeft;
    expect(clockAt(-1)).toEqual({ 1: 60, 2: 60 });
    EXPECTED_AFTER_MOVE.forEach(([p1, p2], cursor) => {
      expect(clockAt(cursor)).toEqual({ 1: p1, 2: p2 });
    });
  });

  it("still stores the game when a move lacks its clock", async () => {
    // Cannot happen in live play today. If it ever does, a display column must
    // not cost the game its record: the row is written with no clocks.
    const session = playTimedOutGame();
    session.gameState.history[1].timeLeftSeconds = null;
    await persistCompletedGame(session);

    const games = await db
      .select({ gameId: gamesTable.gameId })
      .from(gamesTable);
    expect(games).toEqual([{ gameId: session.id }]);
    const [details] = await db
      .select({ clocks: gameDetailsTable.clocks })
      .from(gameDetailsTable);
    expect(details?.clocks).toBeNull();
    const players = await db
      .select({ order: gamePlayersTable.playerOrder })
      .from(gamePlayersTable);
    expect(players).toHaveLength(2);
  });

  it("shows no clock for a game stored before clocks were recorded", async () => {
    const gameId = "replay-clocks-old-row";
    await db.insert(gamesTable).values({
      gameId,
      variant: "standard",
      timeControl: "custom",
      rated: false,
      matchType: "friend",
      boardWidth: 9,
      boardHeight: 9,
      startedAt: new Date("2026-01-01T00:00:00Z"),
      movesCount: 2,
    });
    await db.insert(gameDetailsTable).values({
      gameId,
      configParameters: {
        timeControl: { initialSeconds: 60, incrementSeconds: 2 },
        initialState: buildStandardInitialState(9, 9),
      },
      moves: [
        moveToStandardNotation(wall(4, 4, "vertical"), 9),
        moveToStandardNotation(wall(2, 2, "vertical"), 9),
      ],
      // No `clocks`: exactly what every row written before 2026-10-30 holds.
    });
    await db.insert(gamePlayersTable).values(
      ([1, 2] as const).map((playerOrder) => ({
        gameId,
        playerOrder,
        playerRole: playerOrder === 1 ? "host" : "joiner",
        playerConfigType: "friend",
        displayName: `P${playerOrder}`,
        outcomeRank: playerOrder,
        outcomeReason: "resignation",
      })),
    );

    const replay = await getReplayGameReadonly(gameId);
    expect(replay).not.toBeNull();
    const serialized = replay!.state;
    expect(serialized.history).toHaveLength(2);
    expect(serialized.timeLeft).toBeNull();
    expect(serialized.history.every((e) => e.timeLeftSeconds === null)).toBe(
      true,
    );
    const hydrated = hydrateGameStateFromSerialized(
      serialized,
      serialized.config,
    );
    expect(hydrated.history).toHaveLength(2);
    expect(hasRecordedClocks(hydrated)).toBe(false);
  });

  it("shows no clock when the stored clocks do not fit the moves", async () => {
    const session = playTimedOutGame();
    await persistCompletedGame(session);
    await db.update(gameDetailsTable).set({
      clocks: { afterMove: [[62, 60]], final: EXPECTED_FINAL },
    });

    const replay = await getReplayGameReadonly(session.id);
    expect(replay!.state.timeLeft).toBeNull();
    expect(replay!.state.history.every((e) => e.timeLeftSeconds === null)).toBe(
      true,
    );
  });
});
