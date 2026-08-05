/**
 * Persisting which match a game belongs to, and where in that match it sits.
 *
 * The server has always known both - `GameSession.seriesId` is the first
 * game's own id, inherited by every rematch, and `rematchNumber` counts from
 * 0 - and has always thrown them away at write time.
 *
 * This file deliberately does NOT use `setupEphemeralDb`. That helper applies
 * every migration at once, which means the database a test sees never contains
 * a row written before the migration under test. Real production data does.
 * So this starts its own container, migrates to the migration BEFORE this
 * slice's, writes rows the way the old code did, and only then applies the new
 * one - and every later test then runs against a database that has legacy rows
 * in it, which is the state production will actually be in.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  cpSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { GameConfiguration, Move } from "../../shared/domain/game-types";

interface MigrationJournal {
  entries: { tag: string }[];
}

interface MatchColumns {
  series_id: string | null;
  rematch_number: number | null;
}

const THIS_SLICE_MIGRATION = "0025_plain_cloak";

/** The id of the game inserted before the new migration ran. */
const LEGACY_GAME_ID = "legacy01";

let container: StartedTestContainer | undefined;
let sql: ReturnType<typeof postgres>;

let createGameSession: typeof import("../../server/games/store").createGameSession;
let joinGameSession: typeof import("../../server/games/store").joinGameSession;
let applyPlayerMove: typeof import("../../server/games/store").applyPlayerMove;
let resignGame: typeof import("../../server/games/store").resignGame;
let createRematchSession: typeof import("../../server/games/store").createRematchSession;
let persistCompletedGame: typeof import("../../server/games/persistence").persistCompletedGame;

/**
 * A copy of the migrations folder with this slice's migration removed, so
 * `migrate()` brings a database up to the state it was in before this work.
 */
function migrationsFolderWithoutThisSlice(): string {
  const folder = mkdtempSync(join(tmpdir(), "wg-migrations-"));
  cpSync("drizzle", folder, { recursive: true });

  // Drizzle decides what to apply from the journal, not from what .sql files
  // happen to be present, so removing the entry is enough - the copied 0025
  // file is simply never read.
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(
    readFileSync(journalPath, "utf8"),
  ) as MigrationJournal;
  journal.entries = journal.entries.filter(
    (entry) => entry.tag !== THIS_SLICE_MIGRATION,
  );
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));

  return folder;
}

const CONFIG: GameConfiguration = {
  variant: "standard",
  boardWidth: 8,
  boardHeight: 8,
  rated: false,
  timeControl: { preset: "5+3", initialSeconds: 300, incrementSeconds: 3 },
};

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_DB: "testdb",
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .withStartupTimeout(120_000)
    .start();

  const url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/testdb`;
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = "test";

  // 1. The schema as it was before this slice.
  const beforeFolder = migrationsFolderWithoutThisSlice();
  const migrationClient = postgres(url, { max: 1 });
  await migrate(drizzle(migrationClient), { migrationsFolder: beforeFolder });

  // 2. A game written the way the old code wrote them: no match tracking,
  //    because there was nowhere to put it.
  await migrationClient`
    INSERT INTO games (game_id, variant, time_control, rated, match_type,
                       board_width, board_height, started_at, moves_count)
    VALUES (${LEGACY_GAME_ID}, 'standard', '5+3', false, 'friend', 8, 8, NOW(), 4)`;
  await migrationClient`
    INSERT INTO game_players (game_id, player_order, player_role,
                              player_config_type, display_name, outcome_rank,
                              outcome_reason)
    VALUES (${LEGACY_GAME_ID}, 1, 'host', 'you', 'legacy host', 1, 'resignation'),
           (${LEGACY_GAME_ID}, 2, 'joiner', 'friend', 'legacy joiner', 2, 'resignation')`;

  // 3. Only now, the migration under test.
  await migrate(drizzle(migrationClient), { migrationsFolder: "drizzle" });
  await migrationClient.end();
  rmSync(beforeFolder, { recursive: true, force: true });

  sql = postgres(url);

  const store = await import("../../server/games/store");
  const persistence = await import("../../server/games/persistence");
  createGameSession = store.createGameSession;
  joinGameSession = store.joinGameSession;
  applyPlayerMove = store.applyPlayerMove;
  resignGame = store.resignGame;
  createRematchSession = store.createRematchSession;
  persistCompletedGame = persistence.persistCompletedGame;
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await container?.stop();
});

/** An opening that is legal for either seat, mirroring past-games.test.ts. */
function openingMove(playerId: 1 | 2): Move {
  const { boardHeight: rows, boardWidth: cols } = CONFIG;
  return playerId === 1
    ? {
        actions: [
          { type: "cat", target: [0, 1] },
          { type: "mouse", target: [rows - 2, 0] },
        ],
      }
    : {
        actions: [
          { type: "cat", target: [0, cols - 2] },
          { type: "mouse", target: [rows - 2, cols - 1] },
        ],
      };
}

/** Drives a session to a finished state without persisting it. */
function playToFinish(sessionId: string, startedAt: number) {
  applyPlayerMove({
    id: sessionId,
    playerId: 1,
    move: openingMove(1),
    timestamp: startedAt,
  });
  applyPlayerMove({
    id: sessionId,
    playerId: 2,
    move: openingMove(2),
    timestamp: startedAt + 1000,
  });
  resignGame({ id: sessionId, playerId: 1, timestamp: startedAt + 2000 });
}

function startGame(startedAt: number) {
  const { session } = createGameSession({
    config: CONFIG,
    matchType: "friend",
    hostDisplayName: "host",
    hostIsPlayer1: true,
  });
  joinGameSession({ id: session.id, displayName: "joiner" });
  playToFinish(session.id, startedAt);
  return session;
}

/**
 * A rematch of `previousId`, played to a finish. `createRematchSession` returns
 * the session already `ready` with both seats ready, because the players agreed
 * to it before it existed - so unlike a fresh game there is nothing to join.
 */
function startRematch(previousId: string, startedAt: number) {
  const { newSession } = createRematchSession(previousId);
  playToFinish(newSession.id, startedAt);
  return newSession;
}

async function readMatchColumns(
  gameId: string,
): Promise<MatchColumns | undefined> {
  const rows = await sql<MatchColumns[]>`
    SELECT series_id, rematch_number FROM games WHERE game_id = ${gameId}`;
  return rows[0];
}

describe("the migration, over a database that already had games in it", () => {
  it("leaves the old game and its players intact", async () => {
    const games: { moves_count: number }[] = await sql`
      SELECT game_id, moves_count FROM games WHERE game_id = ${LEGACY_GAME_ID}`;
    const players: { display_name: string }[] = await sql`
      SELECT display_name FROM game_players
      WHERE game_id = ${LEGACY_GAME_ID} ORDER BY player_order`;

    expect(games[0]?.moves_count).toBe(4);
    expect(players.map((player) => player.display_name)).toEqual([
      "legacy host",
      "legacy joiner",
    ]);
  });

  it("records the old game as untracked rather than inventing a series", async () => {
    // Both NULL is the honest value: this game predates match tracking.
    // Backfilling it as a standalone series would be inventing a fact.
    const columns = await readMatchColumns(LEGACY_GAME_ID);

    expect(columns.series_id).toBeNull();
    expect(columns.rematch_number).toBeNull();
  });
});

describe("a game that is not a rematch", () => {
  it("is the first game of its own match", async () => {
    const session = startGame(Date.now());

    await persistCompletedGame(session);

    const columns = await readMatchColumns(session.id);
    expect(columns.series_id).toBe(session.id);
    expect(columns.rematch_number).toBe(0);
  });
});

describe("a rematch chain", () => {
  it("shares one series id and numbers the games in order", async () => {
    const first = startGame(Date.now());
    await persistCompletedGame(first);

    const ids = [first.id];
    let previousId = first.id;
    for (let i = 0; i < 2; i++) {
      const rematch = startRematch(previousId, Date.now() + i * 10_000);
      await persistCompletedGame(rematch);
      ids.push(rematch.id);
      previousId = rematch.id;
    }

    const rows = await Promise.all(ids.map(readMatchColumns));

    expect(rows.map((r) => r.series_id)).toEqual([
      first.id,
      first.id,
      first.id,
    ]);
    expect(rows.map((r) => r.rematch_number)).toEqual([0, 1, 2]);
  });

  it("keeps counting correctly when a game in the middle was never written", async () => {
    // The reason this is a group key and not a link to the previous game: a
    // failed write in the middle must not renumber or orphan what follows.
    const first = startGame(Date.now());
    await persistCompletedGame(first);

    // Deliberately NOT persisted.
    const middle = startRematch(first.id, Date.now() + 10_000);

    const third = startRematch(middle.id, Date.now() + 20_000);
    await persistCompletedGame(third);

    expect(await readMatchColumns(middle.id)).toBeUndefined();

    const columns = await readMatchColumns(third.id);
    expect(columns.series_id).toBe(first.id);
    expect(columns.rematch_number).toBe(2);
  });
});

describe("the table's own guarantees", () => {
  async function insertRaw(
    gameId: string,
    seriesId: string | null,
    rematchNumber: number | null,
  ) {
    await sql`
      INSERT INTO games (game_id, variant, time_control, rated, match_type,
                         board_width, board_height, started_at, moves_count,
                         series_id, rematch_number)
      VALUES (${gameId}, 'standard', '5+3', false, 'friend', 8, 8, NOW(), 0,
              ${seriesId}, ${rematchNumber})`;
  }

  /**
   * These assertions are deliberately NOT awaited. bun registers a `rejects`
   * assertion with the running test on its own, so an unawaited one still
   * fails the test - measured with a probe that expected a pattern which could
   * not match, both with and without `await`, and both failed. Adding `await`
   * reads safer but is a lint error, because bun's own types do not declare the
   * result as a Thenable.
   */
  it("refuses a series with no position, or a position with no series", () => {
    expect(insertRaw("halfa", "series-x", null)).rejects.toThrow(
      /games_match_tracking_paired/,
    );
    expect(insertRaw("halfb", null, 0)).rejects.toThrow(
      /games_match_tracking_paired/,
    );
  });

  it("refuses a position before the first game", () => {
    expect(insertRaw("negative", "series-y", -1)).rejects.toThrow(
      /games_rematch_number_non_negative/,
    );
  });

  it("refuses two games claiming the same position in one match", async () => {
    await insertRaw("dupe1", "series-z", 3);

    expect(insertRaw("dupe2", "series-z", 3)).rejects.toThrow(
      /games_series_position_unique/,
    );
  });

  it("still allows any number of untracked games", async () => {
    // The unique index must not turn the legacy NULL pair into a single-row
    // limit; Postgres treats NULLs as distinct, and this pins that.
    await insertRaw("untracked1", null, null);
    await insertRaw("untracked2", null, null);

    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM games WHERE series_id IS NULL`;
    expect(count).toBeGreaterThanOrEqual(3); // the two here plus the legacy row
  });
});
