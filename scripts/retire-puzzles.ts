/**
 * Retires saved puzzles by display name (sets enabled = false; the row and
 * its fingerprint stay, so the seeder can never re-insert or re-enable it).
 * Runs INSIDE the deployed Fly machine (which has DATABASE_URL); it is NOT
 * part of release_command — retirement is a deliberate manual step:
 *
 *   fly ssh console -a wallgame -C \
 *     "bun scripts/retire-puzzles.ts 'Generated Puzzle 1' 'Generated Puzzle 6'"
 *
 * Fail-closed: aborts unless the name lookup matches EXACTLY the requested
 * set, updates by the captured ids in one transaction that rolls back on an
 * unexpected affected-row count, then reads the rows back and asserts every
 * one is disabled.
 */

import { inArray } from "drizzle-orm";
import { db } from "../server/db";
import { savedPuzzlesTable } from "../server/db/schema/saved-puzzles";

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error('usage: bun scripts/retire-puzzles.ts "<display name>" ...');
  process.exit(1);
}
if (new Set(names).size !== names.length) {
  console.error("abort: duplicate names in arguments");
  process.exit(1);
}

const main = async () => {
  const all = await db
    .select({ enabled: savedPuzzlesTable.enabled })
    .from(savedPuzzlesTable);
  console.log(
    `pre-write: ${all.length} puzzles total, ${all.filter((row) => row.enabled).length} enabled`,
  );

  const targets = await db
    .select({
      id: savedPuzzlesTable.id,
      displayName: savedPuzzlesTable.displayName,
      enabled: savedPuzzlesTable.enabled,
    })
    .from(savedPuzzlesTable)
    .where(inArray(savedPuzzlesTable.displayName, names));

  const foundNames = new Set(targets.map((row) => row.displayName));
  if (
    targets.length !== names.length ||
    names.some((name) => !foundNames.has(name))
  ) {
    console.error(
      `abort: lookup mismatch — asked for [${names.join(", ")}], matched [${targets
        .map((row) => `${row.displayName} (${row.id})`)
        .join(", ")}]`,
    );
    process.exit(1);
  }
  for (const row of targets) {
    console.log(
      `will retire: ${row.displayName} (${row.id}, enabled=${row.enabled})`,
    );
  }

  const ids = targets.map((row) => row.id);
  const updatedCount = await db.transaction(async (tx) => {
    const updated = await tx
      .update(savedPuzzlesTable)
      .set({ enabled: false })
      .where(inArray(savedPuzzlesTable.id, ids))
      .returning({ id: savedPuzzlesTable.id });
    if (updated.length !== ids.length) {
      throw new Error(
        `update affected ${updated.length} rows, expected ${ids.length} — rolled back`,
      );
    }
    return updated.length;
  });

  const readBack = await db
    .select({
      displayName: savedPuzzlesTable.displayName,
      enabled: savedPuzzlesTable.enabled,
    })
    .from(savedPuzzlesTable)
    .where(inArray(savedPuzzlesTable.id, ids));
  const stillEnabled = readBack.filter((row) => row.enabled);
  if (readBack.length !== ids.length || stillEnabled.length > 0) {
    console.error("abort: read-back mismatch", readBack);
    process.exit(1);
  }
  console.log(
    `retired ${updatedCount} puzzles: ${readBack
      .map((row) => row.displayName)
      .join(", ")}`,
  );
  process.exit(0);
};

await main();
