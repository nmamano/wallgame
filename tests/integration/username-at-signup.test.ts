/**
 * A new account is asked to name itself; an existing one never is.
 *
 * The browser harness (scripts/browser-harness/drive-username-picker.ts) proves
 * the dialog behaves, but it stubs every API answer, so it cannot see any of the
 * server half: the column, its backfill, or the fact that the display-name route
 * is what records the choice. This file is that half.
 *
 * Like the anonymous-id file, it does NOT use `setupEphemeralDb`. That applies
 * every migration at once, so no test could ever see a row that existed BEFORE
 * the backfill ran - which is the only state production is ever in. Staging the
 * migration over a blank database is the only way the backfill assertion means
 * anything: without legacy rows to backfill, it would pass over an empty table.
 *
 * Uses Testcontainers to spin up an ephemeral PostgreSQL database. Needs Docker.
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

interface MigrationJournal {
  entries: { tag: string }[];
}

const THIS_SLICE_MIGRATION = "0028_user_chose_display_name";

/** Still carrying the name it was given at sign-up. */
const LEGACY_UNNAMED_AUTH = "kinde|legacy-generated";
const LEGACY_UNNAMED_NAME = "player_abcdefghij";
/** Named itself long before this feature existed. */
const LEGACY_NAMED_AUTH = "kinde|legacy-chosen";
const LEGACY_NAMED_NAME = "veteran";

let container: StartedTestContainer | undefined;
let sql: ReturnType<typeof postgres>;
let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl: string;

function migrationsFolderWithoutThisSlice(): string {
  const folder = mkdtempSync(join(tmpdir(), "wg-username-migrations-"));
  cpSync("drizzle", folder, { recursive: true });

  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(
    readFileSync(journalPath, "utf8"),
  ) as MigrationJournal;
  // TRUNCATE, do not filter - drizzle records progress by the last applied
  // migration's timestamp, so a later migration left in the staged folder makes
  // the real run skip this one as already superseded.
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

/** GET /api/settings as a given account. Creates the account on first call. */
async function getSettings(authUserId: string) {
  const response = await fetch(`${baseUrl}/api/settings`, {
    headers: { "x-test-user-id": authUserId },
  });
  return {
    status: response.status,
    body: (await response.json()) as { hasChosenDisplayName?: boolean },
  };
}

async function putDisplayName(authUserId: string, displayName: string) {
  const response = await fetch(`${baseUrl}/api/settings/display-name`, {
    method: "PUT",
    headers: {
      "x-test-user-id": authUserId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ displayName }),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      hasChosenDisplayName?: boolean;
      error?: string;
    },
  };
}

/** The stored flag, read straight from the row rather than through the API. */
async function storedFlag(authUserId: string): Promise<boolean | undefined> {
  const rows = await sql<{ has_chosen_display_name: boolean }[]>`
    SELECT u.has_chosen_display_name
    FROM user_auth ua
    JOIN users u ON u.user_id = ua.user_id
    WHERE ua.auth_user_id = ${authUserId}`;
  return rows[0]?.has_chosen_display_name;
}

beforeAll(async () => {
  const handle = await setupBlankEphemeralDb();
  container = handle.container;
  const url = handle.connectionUrl;

  const beforeFolder = migrationsFolderWithoutThisSlice();
  const migrationClient = postgres(url, { max: 1 });
  await migrate(drizzle(migrationClient), { migrationsFolder: beforeFolder });

  // Two accounts written while the column did not exist. One of them still has
  // a generated name, which is the interesting one: the backfill must NOT try
  // to be clever about the name and single it out.
  for (const [authId, name, capitalized] of [
    [LEGACY_UNNAMED_AUTH, LEGACY_UNNAMED_NAME, "Player_abcdefghij"],
    [LEGACY_NAMED_AUTH, LEGACY_NAMED_NAME, "Veteran"],
  ]) {
    const [row] = await migrationClient<{ user_id: number }[]>`
      INSERT INTO users (display_name, capitalized_display_name, auth_provider)
      VALUES (${name}, ${capitalized}, 'kinde')
      RETURNING user_id`;
    await migrationClient`
      INSERT INTO user_auth (user_id, auth_provider, auth_user_id)
      VALUES (${row.user_id}, 'kinde', ${authId})`;
  }

  await migrate(drizzle(migrationClient), { migrationsFolder: "drizzle" });
  await migrationClient.end();
  rmSync(beforeFolder, { recursive: true, force: true });

  sql = postgres(url);

  const serverModule = await import("../../server/app");
  const { app, websocket } = serverModule.createApp();
  server = Bun.serve({ fetch: app.fetch, websocket, port: 0 });
  baseUrl = `http://localhost:${server.port}`;
}, 180_000);

afterAll(async () => {
  if (server) {
    await server.stop(true);
  }
  await sql?.end();
  await teardownEphemeralDb(container);
}, 60_000);

describe("choosing a username at sign up", () => {
  it("treats every account that predates the column as already named", async () => {
    // Both, including the one still carrying a generated name. Interrupting
    // existing players is a product decision nobody has made; the migration
    // deliberately does not make it.
    expect(await storedFlag(LEGACY_UNNAMED_AUTH)).toBe(true);
    expect(await storedFlag(LEGACY_NAMED_AUTH)).toBe(true);
  });

  it("marks a brand-new account as not yet named", async () => {
    const { status, body } = await getSettings("kinde|newcomer");
    expect(status).toBe(200);
    expect(body.hasChosenDisplayName).toBe(false);
    expect(await storedFlag("kinde|newcomer")).toBe(false);
  });

  it("records the choice when the name is set, and reports it back", async () => {
    await getSettings("kinde|chooser");
    expect(await storedFlag("kinde|chooser")).toBe(false);

    const put = await putDisplayName("kinde|chooser", "Chooser");
    expect(put.status).toBe(200);
    // Reported in the response, so the blocking dialog can close on this alone
    // rather than on a refetch that may be slow or fail.
    expect(put.body.hasChosenDisplayName).toBe(true);

    expect(await storedFlag("kinde|chooser")).toBe(true);
    const after = await getSettings("kinde|chooser");
    expect(after.body.hasChosenDisplayName).toBe(true);
  });

  it("refuses a taken name readably and leaves the account unnamed", async () => {
    await getSettings("kinde|latecomer");

    const put = await putDisplayName("kinde|latecomer", "Chooser");
    expect(put.status).toBe(409);
    expect(put.body.error).toContain("already taken");

    // The important half: a refused attempt must not count as having chosen,
    // or a conflict would dismiss the dialog and strand the generated name.
    expect(await storedFlag("kinde|latecomer")).toBe(false);
    const after = await getSettings("kinde|latecomer");
    expect(after.body.hasChosenDisplayName).toBe(false);
  });

  it("refuses a reserved name without counting it as a choice", async () => {
    await getSettings("kinde|hopeful");

    const put = await putDisplayName("kinde|hopeful", "cool bot");
    expect(put.status).toBe(400);
    expect(await storedFlag("kinde|hopeful")).toBe(false);
  });

  it("keeps the flag set when the name is changed again later", async () => {
    const put = await putDisplayName("kinde|chooser", "ChooserAgain");
    expect(put.status).toBe(200);
    expect(await storedFlag("kinde|chooser")).toBe(true);
  });
});
