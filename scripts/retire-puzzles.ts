/**
 * Retires saved puzzles by CURRENT (enabled) display name: sets
 * enabled = false and, in the SAME transaction, renumbers the remaining
 * enabled rows so display names stay continuous ("Puzzle 1..K"
 * in sortIndex order — the UI invariant from S-P2). Disabled rows keep
 * their historical names; those are display-only duplicates and are never
 * lookup candidates (identity is sourceFingerprint, and this script only
 * matches names among ENABLED rows).
 *
 * Runs INSIDE the deployed Fly machine (which has DATABASE_URL); it is NOT
 * part of release_command — retirement is a deliberate manual step:
 *
 *   fly ssh console -a wallgame -C \
 *     "bun scripts/retire-puzzles.ts 'Puzzle 7' 'Puzzle 12'"
 *
 * The names it matches are those of ENABLED `saved_puzzles` rows. The ten
 * hand-authored puzzles share this numbering ("Puzzle 1".."Puzzle 10") but
 * are not rows in that table at all, so they can never be matched here.
 *
 * Fail-closed: aborts unless each requested name matches EXACTLY ONE
 * enabled row; disables by captured id with exact affected-count
 * assertions; renumbers survivors; read-back asserts targets are disabled
 * and enabled names are contiguous and unique.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../server/db";
import { savedPuzzlesTable } from "../server/db/schema/saved-puzzles";
import { savedPuzzleDbRowSchema } from "../shared/contracts/puzzles";
import {
  computeContiguousRenames,
  generatedPuzzleDisplayName,
} from "../shared/domain/saved-puzzles";

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
  const rows = (await db.select().from(savedPuzzlesTable)).map((raw) =>
    savedPuzzleDbRowSchema.parse(raw),
  );
  const enabledRows = rows.filter((row) => row.enabled);
  console.log(
    `pre-write: ${rows.length} puzzles total, ${enabledRows.length} enabled`,
  );

  // Match ONLY among enabled rows; each name must hit exactly one.
  const targets: typeof rows = [];
  for (const name of names) {
    const matches = enabledRows.filter((row) => row.displayName === name);
    if (matches.length !== 1) {
      console.error(
        `abort: "${name}" matched ${matches.length} ENABLED rows (need exactly 1)`,
      );
      process.exit(1);
    }
    targets.push(matches[0]);
  }
  for (const row of targets) {
    console.log(`will retire: ${row.displayName} (${row.id})`);
  }

  const targetIds = new Set(targets.map((row) => row.id));
  const survivors = rows.filter((row) => !targetIds.has(row.id));
  const renames = computeContiguousRenames(survivors);
  console.log(`renumber plan (${renames.length} rows change):`);
  for (const rename of renames) {
    console.log(`  ${rename.from} -> ${rename.to} (${rename.id})`);
  }

  await db.transaction(async (tx) => {
    let disabledCount = 0;
    for (const target of targets) {
      const updated = await tx
        .update(savedPuzzlesTable)
        .set({ enabled: false })
        .where(
          and(
            eq(savedPuzzlesTable.id, target.id),
            eq(savedPuzzlesTable.enabled, true),
          ),
        )
        .returning({ id: savedPuzzlesTable.id });
      disabledCount += updated.length;
    }
    if (disabledCount !== targets.length) {
      throw new Error(
        `disable affected ${disabledCount} rows, expected ${targets.length} — rolled back`,
      );
    }
    let renamedCount = 0;
    for (const rename of renames) {
      // Guard by full preflight state; the count assertion is the race
      // detector (a concurrent mutation rolls back the whole batch).
      const updated = await tx
        .update(savedPuzzlesTable)
        .set({ displayName: rename.to })
        .where(
          and(
            eq(savedPuzzlesTable.id, rename.id),
            eq(savedPuzzlesTable.enabled, true),
            eq(savedPuzzlesTable.displayName, rename.from),
          ),
        )
        .returning({ id: savedPuzzlesTable.id });
      renamedCount += updated.length;
    }
    if (renamedCount !== renames.length) {
      throw new Error(
        `rename affected ${renamedCount} rows, expected ${renames.length} — rolled back`,
      );
    }
  });

  const readBack = (await db.select().from(savedPuzzlesTable)).map((raw) =>
    savedPuzzleDbRowSchema.parse(raw),
  );
  if (readBack.length !== rows.length) {
    console.error(
      `abort: read-back total ${readBack.length} != preflight ${rows.length}`,
    );
    process.exit(1);
  }
  const stillEnabledTargets = readBack.filter(
    (row) => targetIds.has(row.id) && row.enabled,
  );
  if (stillEnabledTargets.length > 0) {
    console.error("abort: read-back shows targets still enabled");
    process.exit(1);
  }
  const enabledAfter = readBack
    .filter((row) => row.enabled)
    .sort((a, b) => a.sortIndex - b.sortIndex);
  if (enabledAfter.length !== enabledRows.length - targets.length) {
    console.error(
      `abort: read-back enabled count ${enabledAfter.length}, expected ${enabledRows.length - targets.length}`,
    );
    process.exit(1);
  }
  const expectedNames = enabledAfter.map((_, index) =>
    generatedPuzzleDisplayName(index + 1),
  );
  const actualNames = enabledAfter.map((row) => row.displayName);
  if (
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames) ||
    new Set(actualNames).size !== actualNames.length
  ) {
    console.error("abort: read-back names not contiguous/unique", actualNames);
    process.exit(1);
  }
  console.log(
    `retired ${targets.length} puzzles; ${enabledAfter.length} remain, renamed contiguously 1..${enabledAfter.length}`,
  );
  process.exit(0);
};

await main();
