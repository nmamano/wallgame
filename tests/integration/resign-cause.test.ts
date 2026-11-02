/**
 * game_details.resign_cause reaching a database row (board task 89ef6b5b).
 *
 * A click on Resign, the abandonment timer and the idle timer all end a game
 * as "resignation"; this column is what tells them apart afterwards. Which
 * store path sets which cause is pinned in tests/game/abandoned-game.test.ts;
 * this file pins the row, and the rows written before the column existed.
 *
 * Like anonymous-id-persistence.test.ts, it stages the migration over a blank
 * database (setupBlankEphemeralDb), so an old game is written BEFORE the
 * column exists - the state production is in.
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
import type { StartedTestContainer } from "testcontainers";
import postgres from "postgres";
import { setupBlankEphemeralDb, teardownEphemeralDb } from "../setup-db";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Move } from "../../shared/domain/game-types";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import type { PartialGameConfiguration } from "../../server/games/store";
import type { ResignCause } from "../../shared/domain/game-types";

interface MigrationJournal {
  entries: { tag: string }[];
}

const THIS_SLICE_MIGRATION = "0031_resign_cause";
const LEGACY_GAME_ID = "legacyrc";

let container: StartedTestContainer | undefined;
let sql: ReturnType<typeof postgres>;

let createGameSession: typeof import("../../server/games/store").createGameSession;
let joinGameSession: typeof import("../../server/games/store").joinGameSession;
let applyPlayerMove: typeof import("../../server/games/store").applyPlayerMove;
let resignGame: typeof import("../../server/games/store").resignGame;
let acceptDraw: typeof import("../../server/games/store").acceptDraw;
let persistCompletedGame: typeof import("../../server/games/persistence").persistCompletedGame;
let getReplayGameReadonly: typeof import("../../server/db/game-queries").getReplayGameReadonly;

/** The repo's migrations, cut off before this slice's (see the anonymous-id file for why cut, not filtered). */
function migrationsFolderWithoutThisSlice(): string {
  const folder = mkdtempSync(join(tmpdir(), "wg-resign-cause-migrations-"));
  cpSync("drizzle", folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(
    readFileSync(journalPath, "utf8"),
  ) as MigrationJournal;
  const index = journal.entries.findIndex(
    (entry) => entry.tag === THIS_SLICE_MIGRATION,
  );
  if (index === -1) {
    throw new Error(`${THIS_SLICE_MIGRATION} is not in the journal`);
  }
  journal.entries = journal.entries.slice(0, index);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return folder;
}

const CONFIG: PartialGameConfiguration = {
  variant: "standard",
  boardWidth: 8,
  boardHeight: 8,
  rated: false,
  timeControl: { preset: "blitz", initialSeconds: 300, incrementSeconds: 3 },
};

function openingMove(playerId: 1 | 2): Move {
  return playerId === 1
    ? {
        actions: [
          { type: "cat", target: [0, 1] },
          { type: "mouse", target: [6, 0] },
        ],
      }
    : {
        actions: [
          { type: "cat", target: [0, 6] },
          { type: "mouse", target: [6, 7] },
        ],
      };
}

/** A human-vs-human game with both opening moves played, still going. */
function gameUnderWay() {
  const { session } = createGameSession({
    config: CONFIG,
    matchType: "friend",
    hostDisplayName: "host",
    hostIsPlayer1: true,
  });
  joinGameSession({ id: session.id, displayName: "joiner" });
  const startedAt = Date.now();
  applyPlayerMove({
    id: session.id,
    playerId: 1,
    move: openingMove(1),
    timestamp: startedAt,
  });
  applyPlayerMove({
    id: session.id,
    playerId: 2,
    move: openingMove(2),
    timestamp: startedAt + 1000,
  });
  return session;
}

async function resignCauseOf(gameId: string) {
  const rows = (await sql`
    SELECT resign_cause FROM game_details WHERE game_id = ${gameId}`) as {
    resign_cause: string | null;
  }[];
  expect(rows).toHaveLength(1);
  return rows[0].resign_cause;
}

beforeAll(async () => {
  const handle = await setupBlankEphemeralDb();
  container = handle.container;
  const url = handle.connectionUrl;

  const beforeFolder = migrationsFolderWithoutThisSlice();
  const migrationClient = postgres(url, { max: 1 });
  await migrate(drizzle(migrationClient), { migrationsFolder: beforeFolder });

  // A resignation stored before the column existed.
  await migrationClient`
    INSERT INTO games (game_id, variant, time_control, rated, match_type,
                       board_width, board_height, started_at, moves_count)
    VALUES (${LEGACY_GAME_ID}, 'standard', 'blitz', false, 'friend', 8, 8, NOW(), 2)`;
  await migrationClient`
    INSERT INTO game_details (game_id, config_parameters, moves)
    VALUES (${LEGACY_GAME_ID},
            ${JSON.stringify({ initialState: buildStandardInitialState(8, 8) })}::jsonb,
            '["Cb8.Ma2", "Cg8.Mh2"]'::jsonb)`;
  for (const [order, role, rank] of [
    [1, "host", 1],
    [2, "joiner", 2],
  ] as const) {
    await migrationClient`
      INSERT INTO game_players (game_id, player_order, player_role,
                                player_config_type, display_name, outcome_rank,
                                outcome_reason)
      VALUES (${LEGACY_GAME_ID}, ${order}, ${role}, 'friend', ${role}, ${rank},
              'resignation')`;
  }

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
  acceptDraw = store.acceptDraw;
  persistCompletedGame = persistence.persistCompletedGame;
  getReplayGameReadonly = (await import("../../server/db/game-queries"))
    .getReplayGameReadonly;
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await teardownEphemeralDb(container);
}, 60_000);

describe("the migration", () => {
  it("leaves an old game's cause unknown (NULL)", async () => {
    expect(await resignCauseOf(LEGACY_GAME_ID)).toBeNull();
  });

  it("replays an old resignation with no cause, so it still reads Resignation", async () => {
    const replay = await getReplayGameReadonly(LEGACY_GAME_ID);
    expect(replay?.state.result).toEqual({ winner: 1, reason: "resignation" });
  });
});

describe("a finished game", () => {
  for (const cause of ["player", "disconnect", "idle"] as ResignCause[]) {
    it(`stores a resignation by ${cause} as "${cause}"`, async () => {
      const session = gameUnderWay();
      resignGame({ id: session.id, playerId: 1, timestamp: Date.now(), cause });
      await persistCompletedGame(session);
      expect(await resignCauseOf(session.id)).toBe(cause);
      // The replay of the stored game carries the cause back to the page.
      const replay = await getReplayGameReadonly(session.id);
      expect(replay?.state.result).toEqual({
        winner: 2,
        reason: "resignation",
        resignCause: cause,
      });
    });
  }

  it("stores NULL for a game that did not end in a resignation", async () => {
    const session = gameUnderWay();
    acceptDraw({ id: session.id, playerId: 1 });
    await persistCompletedGame(session);
    expect(await resignCauseOf(session.id)).toBeNull();
  });
});
