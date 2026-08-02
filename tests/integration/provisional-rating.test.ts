/**
 * What a never-rated player is shown for Elo.
 *
 * The boundary Nil chose (2026-08-02): a LOGGED-IN player always has a rating,
 * a guest never does. That was already the rule for PLAYING — a guest cannot
 * take a seat in a rated game at all — and this makes the display agree with
 * it.
 *
 * Before, `getGlobalRatingForAuthUser` answered `undefined` in two separate
 * gaps: an auth id with no user row yet, and a user with no global-ratings row
 * yet. Both left `game_players.rating_at_start` NULL, so a player got no +/-
 * on the first rated game they ever played. Both now answer PROVISIONAL_RATING.
 *
 * Driven against a real PostgreSQL because the behaviour under test IS the two
 * queries and their misses — stubbing the database would only assert that `??`
 * works. These need Docker, so they run in Nil's environment and in CI.
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

let container: StartedTestContainer | undefined;

let db: typeof import("../../server/db").db;
let usersTable: typeof import("../../server/db/schema/users").usersTable;
let userAuthTable: typeof import("../../server/db/schema/users").userAuthTable;
let globalRatingsTable: typeof import("../../server/db/schema/global-ratings").globalRatingsTable;
let getGlobalRatingForAuthUser: typeof import("../../server/db/rating-helpers").getGlobalRatingForAuthUser;
let PROVISIONAL_RATING: number;

/**
 * Asserted as a LITERAL, deliberately.
 *
 * These tests first compared against the imported `PROVISIONAL_RATING`, which
 * made them decorative: with the fix removed the constant is `undefined` too,
 * so `expect(undefined).toBe(undefined)` passed and the gate proved nothing.
 * Pinning the number here means the expectation cannot move with the code, and
 * the check below keeps the constant honest against it.
 */
const EXPECTED_PROVISIONAL = 1500;

beforeAll(async () => {
  const handle = await setupEphemeralDb();
  container = handle.container;
  db = (await import("../../server/db")).db;
  const users = await import("../../server/db/schema/users");
  usersTable = users.usersTable;
  userAuthTable = users.userAuthTable;
  globalRatingsTable = (await import("../../server/db/schema/global-ratings"))
    .globalRatingsTable;
  const helpers = await import("../../server/db/rating-helpers");
  getGlobalRatingForAuthUser = helpers.getGlobalRatingForAuthUser;
  PROVISIONAL_RATING = helpers.PROVISIONAL_RATING;
});

afterAll(async () => {
  await teardownEphemeralDb(container);
});

beforeEach(async () => {
  await db.delete(globalRatingsTable);
  await db.delete(userAuthTable);
  await db.delete(usersTable);
});

/** A logged-in user with an auth mapping but no rated result yet. */
async function seedUser(displayName: string): Promise<number> {
  const [user] = await db
    .insert(usersTable)
    .values({
      displayName,
      capitalizedDisplayName: displayName.toUpperCase(),
      authProvider: "test",
    })
    .returning({ userId: usersTable.userId });
  await db.insert(userAuthTable).values({
    userId: user.userId,
    authProvider: "test",
    authUserId: `auth-${displayName}`,
  });
  return user.userId;
}

describe("what a never-rated logged-in player is shown", () => {
  it("exports the provisional rating the writer already assumes", () => {
    // Ties the constant to the literal the other tests assert on, so the two
    // can never drift apart silently.
    expect(PROVISIONAL_RATING).toBe(EXPECTED_PROVISIONAL);
  });

  it("shows the provisional rating when they have no global-ratings row", async () => {
    // The case the whole task was about: a real, provisioned account that has
    // simply never finished a rated game.
    await seedUser("newbie");
    expect(await getGlobalRatingForAuthUser("auth-newbie")).toBe(
      EXPECTED_PROVISIONAL,
    );
  });

  it("shows the provisional rating when no user row exists yet", async () => {
    // The second gap, and the one easiest to forget: authenticated, but not
    // yet provisioned in our tables. They are still logged in.
    const rating = await getGlobalRatingForAuthUser("auth-not-provisioned");
    expect(rating).toBe(EXPECTED_PROVISIONAL);
  });

  it("shows the real rating once they have one", async () => {
    // The provisional value must never mask a rating that exists.
    const userId = await seedUser("veteran");
    await db.insert(globalRatingsTable).values({
      userId,
      rating: 1742,
      ratingDeviation: 80,
    });
    expect(await getGlobalRatingForAuthUser("auth-veteran")).toBe(1742);
  });

  it("never answers undefined for a logged-in player", async () => {
    // The boundary as a property rather than as three examples: whatever the
    // state of our tables, an authenticated caller gets a number. Guests are
    // excluded by construction - the route only calls this behind `user?.id`.
    await seedUser("someone");
    for (const authId of ["auth-someone", "auth-missing", ""]) {
      const rating = await getGlobalRatingForAuthUser(authId);
      expect(typeof rating).toBe("number");
      expect(Number.isFinite(rating)).toBe(true);
    }
  });
});
