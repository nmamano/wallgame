/**
 * Integration tests for solo-campaign completion tracking (S-CAMP), driven
 * through the real Hono route so the optional-auth branch, the known-level
 * validation, and the transitional union read are all exercised as shipped.
 *
 * Uses Testcontainers for an ephemeral PostgreSQL, following
 * `puzzle-progress.test.ts`. These CANNOT run on the auntie box (no Docker);
 * they run in Nil's environment and CI. That is deliberate: the behaviour
 * under test is SQL — NULL-distinct uniqueness and a two-table read — and
 * asserting it against anything other than a real database would be
 * pretending.
 *
 * The two properties that carry the feature:
 *
 * 1. ONE unique constraint gives two behaviours, because PostgreSQL treats
 *    NULLs as distinct: a logged-in player has at most one row per level
 *    (the write is idempotent), while anonymous completions accumulate as
 *    usage events.
 * 2. Progress is read from BOTH `campaign_level_completions` and the legacy
 *    `campaign_progress` during the migration, so no player's markers vanish
 *    between the deploy and the backfill. Removing the legacy half is a
 *    later, deliberate step — this test is what proves it is still wired.
 */

import {
  describe,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  expect,
} from "bun:test";
import { Hono } from "hono";
import type { StartedTestContainer } from "testcontainers";
import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";

let container: StartedTestContainer | undefined;

let db: typeof import("../../server/db").db;
let campaignProgressTable: typeof import("../../server/db/schema/campaign-progress").campaignProgressTable;
let campaignLevelCompletionsTable: typeof import("../../server/db/schema/campaign-level-completions").campaignLevelCompletionsTable;
let usersTable: typeof import("../../server/db/schema/users").usersTable;
let userAuthTable: typeof import("../../server/db/schema/users").userAuthTable;
let isNull: typeof import("drizzle-orm").isNull;
let app: Hono;

/** Levels that exist in the domain set; anything else must be refused. */
const LEVEL_A = "1";
const LEVEL_B = "2";

async function importServerModules() {
  db = (await import("../../server/db")).db;
  campaignProgressTable = (
    await import("../../server/db/schema/campaign-progress")
  ).campaignProgressTable;
  campaignLevelCompletionsTable = (
    await import("../../server/db/schema/campaign-level-completions")
  ).campaignLevelCompletionsTable;
  const users = await import("../../server/db/schema/users");
  usersTable = users.usersTable;
  userAuthTable = users.userAuthTable;
  isNull = (await import("drizzle-orm")).isNull;
  const { campaignRoute } = await import("../../server/routes/campaign");
  app = new Hono().route("/api/campaign", campaignRoute);
}

/** Returns the numeric user id; `auth-<name>` is the x-test-user-id to send. */
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

const complete = (levelId: string, authUserId?: string) =>
  app.request("/api/campaign/complete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authUserId ? { "x-test-user-id": authUserId } : {}),
    },
    body: JSON.stringify({ levelId }),
  });

const readProgress = (authUserId?: string) =>
  app.request("/api/campaign/progress", {
    headers: authUserId ? { "x-test-user-id": authUserId } : {},
  });

beforeAll(async () => {
  const handle = await setupEphemeralDb();
  container = handle.container;
  await importServerModules();
}, 120_000);

beforeEach(async () => {
  await db.delete(campaignLevelCompletionsTable);
  await db.delete(campaignProgressTable);
  await db.delete(userAuthTable);
  await db.delete(usersTable);
});

afterAll(async () => {
  await teardownEphemeralDb(container);
});

describe("recording a campaign completion", () => {
  it("accepts an anonymous completion and stores it with no user", async () => {
    const response = await complete(LEVEL_A);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });

    const rows = await db
      .select()
      .from(campaignLevelCompletionsTable)
      .where(isNull(campaignLevelCompletionsTable.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].levelId).toBe(LEVEL_A);
  });

  it("lets anonymous completions accumulate as usage events", async () => {
    // NULLs are distinct under the unique constraint, so the same level
    // completed twice anonymously is two events rather than one conflict.
    await complete(LEVEL_A);
    await complete(LEVEL_A);

    const rows = await db.select().from(campaignLevelCompletionsTable);
    expect(rows).toHaveLength(2);
  });

  it("is idempotent for a logged-in player", async () => {
    await seedUser("alice");

    expect((await complete(LEVEL_A, "auth-alice")).status).toBe(200);
    expect((await complete(LEVEL_A, "auth-alice")).status).toBe(200);

    const rows = await db.select().from(campaignLevelCompletionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].levelId).toBe(LEVEL_A);
  });

  it("refuses a level outside the known set and writes nothing", async () => {
    const response = await complete("not-a-level");
    expect(response.status).toBe(400);

    const rows = await db.select().from(campaignLevelCompletionsTable);
    expect(rows).toHaveLength(0);
  });
});

describe("reading campaign progress", () => {
  it("refuses an anonymous caller", async () => {
    const response = await readProgress();
    expect(response.status).toBe(401);
  });

  it("unions the new table with the legacy one, and only for that user", async () => {
    const aliceId = await seedUser("alice");
    const bobId = await seedUser("bob");

    // Alice: one legacy-only level, one new-only level, and one level
    // recorded in BOTH (which must not appear twice).
    await db.insert(campaignProgressTable).values([
      { userId: aliceId, levelId: LEVEL_A },
      { userId: bobId, levelId: LEVEL_B },
    ]);
    await db
      .insert(campaignLevelCompletionsTable)
      .values([
        { userId: aliceId, levelId: LEVEL_A },
        { userId: aliceId, levelId: LEVEL_B },
        { userId: bobId, levelId: LEVEL_A },
        { levelId: LEVEL_A },
      ]);

    const response = await readProgress("auth-alice");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      completedLevels: [LEVEL_A, LEVEL_B],
    });
  });

  it("still reports a level that exists only in the legacy table", async () => {
    // The window between the deploy and the backfill: nothing has been
    // copied yet, and the marker must still be there.
    const aliceId = await seedUser("alice");
    await db
      .insert(campaignProgressTable)
      .values({ userId: aliceId, levelId: LEVEL_B });

    const response = await readProgress("auth-alice");
    expect(await response.json()).toEqual({ completedLevels: [LEVEL_B] });
  });
});
