/**
 * The anonymous id reaching a database row.
 *
 * Storage semantics live in tests/anonymous-id.test.ts; this is the other half.
 * The two fail in completely different ways, and a file that mixed them could
 * not say which had broken.
 *
 * Like the match-tracking file, this does NOT use `setupEphemeralDb`: that
 * applies every migration at once, so a test can never see a row written before
 * the migration under test - which is the state production is in. It stages the
 * migration over a blank database (setupBlankEphemeralDb) instead, and every
 * later test then runs against a database with a legacy row already in it.
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
import type { PartialGameConfiguration } from "../../server/games/store";

interface MigrationJournal {
  entries: { tag: string }[];
}

const THIS_SLICE_MIGRATION = "0026_colorful_white_tiger";
const LEGACY_GAME_ID = "legacyan";

const HOST_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const JOINER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const SIGNED_IN_AUTH_ID = "kinde|signed-in-player";
let seededUserId: number;

let container: StartedTestContainer | undefined;
let sql: ReturnType<typeof postgres>;

let createGameSession: typeof import("../../server/games/store").createGameSession;
let joinGameSession: typeof import("../../server/games/store").joinGameSession;
let applyPlayerMove: typeof import("../../server/games/store").applyPlayerMove;
let resignGame: typeof import("../../server/games/store").resignGame;
let createRematchSession: typeof import("../../server/games/store").createRematchSession;
let getSession: typeof import("../../server/games/store").getSession;
let persistCompletedGame: typeof import("../../server/games/persistence").persistCompletedGame;

function migrationsFolderWithoutThisSlice(): string {
  const folder = mkdtempSync(join(tmpdir(), "wg-anon-migrations-"));
  cpSync("drizzle", folder, { recursive: true });

  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(
    readFileSync(journalPath, "utf8"),
  ) as MigrationJournal;
  // TRUNCATE at this slice's migration - do not merely filter it out.
  // Drizzle records how far it has got by the last applied migration's
  // timestamp, so leaving LATER migrations in the staged folder applies them
  // first and then makes the real run skip this one as "older than what is
  // already applied". Filtering worked only while this was the newest
  // migration in the repo, and silently stopped working when it was not.
  // Truncating also matches reality: a database cannot be at "before N" while
  // already carrying N+1.
  const index = journal.entries.findIndex(
    (entry) => entry.tag === THIS_SLICE_MIGRATION,
  );
  if (index === -1) {
    throw new Error(
      `Staged migration harness: ${THIS_SLICE_MIGRATION} is not in the journal. ` +
        `Was it renamed?`,
    );
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

beforeAll(async () => {
  const handle = await setupBlankEphemeralDb();
  container = handle.container;
  const url = handle.connectionUrl;

  const beforeFolder = migrationsFolderWithoutThisSlice();
  const migrationClient = postgres(url, { max: 1 });
  await migrate(drizzle(migrationClient), { migrationsFolder: beforeFolder });

  // A seat written before there was anywhere to record a browser.
  await migrationClient`
    INSERT INTO games (game_id, variant, time_control, rated, match_type,
                       board_width, board_height, started_at, moves_count)
    VALUES (${LEGACY_GAME_ID}, 'standard', 'blitz', false, 'friend', 8, 8, NOW(), 4)`;
  await migrationClient`
    INSERT INTO game_players (game_id, player_order, player_role,
                              player_config_type, display_name, outcome_rank,
                              outcome_reason)
    VALUES (${LEGACY_GAME_ID}, 1, 'host', 'you', 'legacy host', 1, 'resignation')`;

  await migrate(drizzle(migrationClient), { migrationsFolder: "drizzle" });
  await migrationClient.end();
  rmSync(beforeFolder, { recursive: true, force: true });

  sql = postgres(url);

  // A REAL account, because the signed-in test below is meaningless without
  // one: persistCompletedGame resolves user_id by looking up auth_user_id, so
  // an unseeded auth id silently stores NULL and the row is just another guest.
  const [seeded] = await sql<{ user_id: number }[]>`
    INSERT INTO users (display_name, capitalized_display_name, auth_provider)
    VALUES ('signedin', 'SignedIn', 'kinde') RETURNING user_id`;
  seededUserId = seeded.user_id;
  await sql`
    INSERT INTO user_auth (user_id, auth_provider, auth_user_id)
    VALUES (${seededUserId}, 'kinde', ${SIGNED_IN_AUTH_ID})`;

  const store = await import("../../server/games/store");
  const persistence = await import("../../server/games/persistence");
  createGameSession = store.createGameSession;
  joinGameSession = store.joinGameSession;
  applyPlayerMove = store.applyPlayerMove;
  resignGame = store.resignGame;
  createRematchSession = store.createRematchSession;
  getSession = store.getSession;
  persistCompletedGame = persistence.persistCompletedGame;
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await teardownEphemeralDb(container);
});

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

/** A finished human-vs-human game, with whichever ids the caller wants. */
function playedGame(args: {
  hostAnonymousId?: string;
  joinerAnonymousId?: string;
  hostAuthUserId?: string;
}) {
  const { session } = createGameSession({
    config: CONFIG,
    matchType: "friend",
    hostDisplayName: "host",
    hostIsPlayer1: true,
    hostAnonymousId: args.hostAnonymousId,
    hostAuthUserId: args.hostAuthUserId,
  });
  joinGameSession({
    id: session.id,
    displayName: "joiner",
    anonymousId: args.joinerAnonymousId,
  });
  playToFinish(session.id, Date.now());
  return session;
}

async function seatsOf(gameId: string) {
  return (await sql<{ player_role: string; anonymous_id: string | null }[]>`
    SELECT player_role, anonymous_id FROM game_players
    WHERE game_id = ${gameId} ORDER BY player_order`) as {
    player_role: string;
    anonymous_id: string | null;
  }[];
}

describe("the migration, over a database that already had seats in it", () => {
  it("leaves the old game and its seat alone, and records them as unknown", async () => {
    // The games row is asserted directly rather than inferred from its
    // surviving child: a foreign key would keep the child alive in cases where
    // the parent had still been rewritten.
    const games = (await sql`
      SELECT game_id, moves_count FROM games
      WHERE game_id = ${LEGACY_GAME_ID}`) as { moves_count: number }[];
    const seats = await seatsOf(LEGACY_GAME_ID);

    expect(games).toHaveLength(1);
    expect(games[0]?.moves_count).toBe(4);
    expect(seats).toHaveLength(1);
    expect(seats[0]?.anonymous_id).toBeNull();
  });
});

describe("a finished game", () => {
  it("records the browser behind each human seat", async () => {
    const session = playedGame({
      hostAnonymousId: HOST_ID,
      joinerAnonymousId: JOINER_ID,
    });

    await persistCompletedGame(session);

    expect(await seatsOf(session.id)).toEqual([
      { player_role: "host", anonymous_id: HOST_ID },
      { player_role: "joiner", anonymous_id: JOINER_ID },
    ]);
  });

  it("stores nothing rather than something empty when a browser sent no id", async () => {
    const session = playedGame({ hostAnonymousId: HOST_ID });

    await persistCompletedGame(session);

    const seats = await seatsOf(session.id);
    expect(seats[0]?.anonymous_id).toBe(HOST_ID);
    // NULL, not "" - an empty string would count as a distinct browser that
    // every id-less player shared.
    expect(seats[1]?.anonymous_id).toBeNull();
  });

  it("records it beside a real account for a signed-in player", async () => {
    // The load-bearing evidence for Nil's "everyone" ruling. Both columns must
    // land on the SAME row - that adjacency is the entire mechanism by which
    // "do guests come back" becomes "did this guest go on to make an account".
    // Asserting only anonymous_id would pass on a guest row and prove nothing.
    const session = playedGame({
      hostAnonymousId: HOST_ID,
      hostAuthUserId: SIGNED_IN_AUTH_ID,
    });

    await persistCompletedGame(session);

    const [host] = (await sql<
      { user_id: number | null; anonymous_id: string | null }[]
    >`SELECT user_id, anonymous_id FROM game_players
      WHERE game_id = ${session.id} AND player_role = 'host'`) as {
      user_id: number | null;
      anonymous_id: string | null;
    }[];

    expect(host?.user_id).toBe(seededUserId);
    expect(host?.anonymous_id).toBe(HOST_ID);
  });

  it("never records one for a bot, even if something put one there", async () => {
    const { session } = createGameSession({
      config: CONFIG,
      matchType: "friend",
      hostDisplayName: "host",
      hostIsPlayer1: true,
      hostAnonymousId: HOST_ID,
      joinerConfig: { type: "friend" },
    });
    joinGameSession({ id: session.id, displayName: "bot" });
    // Force the seat to look like a bot AND carry an id - a shape only a bug
    // can produce, and exactly the bug that would put a human's browser id on
    // a row that never had a browser.
    const live = getSession(session.id);
    live.players.joiner.configType = "bot";
    live.players.joiner.anonymousId = JOINER_ID;
    playToFinish(session.id, Date.now());

    await persistCompletedGame(live);

    const seats = await seatsOf(session.id);
    expect(seats[0]?.anonymous_id).toBe(HOST_ID);
    expect(seats[1]?.anonymous_id).toBeNull();
  });
});

describe("a rematch", () => {
  it("keeps the browser behind each seat", async () => {
    // The load-bearing case. A rematch is negotiated entirely over the
    // websocket and creates seats with NO http request, so nothing can re-send
    // the id - it survives only through the seat spreads. If it did not, every
    // rematch would look like a brand-new person, and rematches are where most
    // of the games are.
    const first = playedGame({
      hostAnonymousId: HOST_ID,
      joinerAnonymousId: JOINER_ID,
    });
    await persistCompletedGame(first);

    const { newSession } = createRematchSession(first.id);
    playToFinish(newSession.id, Date.now() + 10_000);
    await persistCompletedGame(newSession);

    const ids = (await seatsOf(newSession.id))
      .map((seat) => seat.anonymous_id)
      .sort();
    expect(ids).toEqual([JOINER_ID, HOST_ID].sort());
  });
});

describe("the column itself", () => {
  it("refuses anything that is not a UUID, whoever writes it", () => {
    // A native uuid column rather than varchar, so the shape holds for every
    // writer - a migration, a psql session, a future endpoint - and not only
    // for requests that happened to pass through our Zod schemas.
    // Wrapped in an async function rather than handed to expect() as a bare
    // tagged template: postgres.js queries are LAZY, so a template nobody
    // awaits is never sent, and the assertion waits forever on a promise that
    // will not settle. That is a hang, not a failure, which is a much worse
    // way to find out.
    const insertNonUuid = async () => {
      await sql`
        INSERT INTO game_players (game_id, player_order, player_role,
                                  player_config_type, display_name,
                                  outcome_rank, outcome_reason, anonymous_id)
        VALUES (${LEGACY_GAME_ID}, 9, 'host', 'you', 'bad', 1, 'resignation',
                ${"not-a-uuid"})`;
    };

    expect(insertNonUuid()).rejects.toThrow(
      /invalid input syntax for type uuid/,
    );
  });
});
