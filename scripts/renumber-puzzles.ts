/**
 * ONE-TIME initial renumber (S-P2): give the ENABLED saved puzzles
 * continuous display names ("Generated Puzzle 1..39" in sortIndex order)
 * after the first retirements left gaps. Disabled rows keep their
 * historical names (identity is sourceFingerprint; names are display only).
 * Future retirements renumber automatically via scripts/retire-puzzles.ts.
 *
 * Runs INSIDE the deployed Fly machine:
 *   fly ssh console -a wallgame -C "bun scripts/renumber-puzzles.ts"
 *
 * Fail-closed preflight, hardcoded to the known 2026-07-26 state: exactly
 * 41 rows, 39 enabled, and the disabled pair is exactly the two rows
 * retired in S-COPY (by id AND name). The full old->new mapping is printed
 * before any write; updates are ID-targeted in one transaction with an
 * exact affected-count assertion; the read-back asserts the enabled names
 * are exactly 1..39, unique, in sortIndex order.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../server/db";
import { savedPuzzlesTable } from "../server/db/schema/saved-puzzles";
import { savedPuzzleDbRowSchema } from "../shared/contracts/puzzles";
import {
  computeContiguousRenames,
  generatedPuzzleDisplayName,
} from "../shared/domain/saved-puzzles";

const EXPECTED_TOTAL = 41;
const EXPECTED_ENABLED = 39;
const EXPECTED_DISABLED = new Map([
  ["Mq_qSzIpaZ", "Generated Puzzle 1"],
  ["q6Eozcuqqx", "Generated Puzzle 6"],
]);

const main = async () => {
  const rows = (await db.select().from(savedPuzzlesTable)).map((raw) =>
    savedPuzzleDbRowSchema.parse(raw),
  );
  const enabled = rows.filter((row) => row.enabled);
  const disabled = rows.filter((row) => !row.enabled);
  console.log(`pre-write: ${rows.length} total, ${enabled.length} enabled`);

  if (rows.length !== EXPECTED_TOTAL || enabled.length !== EXPECTED_ENABLED) {
    console.error(
      `abort: expected ${EXPECTED_TOTAL} total / ${EXPECTED_ENABLED} enabled`,
    );
    process.exit(1);
  }
  const disabledOk =
    disabled.length === EXPECTED_DISABLED.size &&
    disabled.every((row) => EXPECTED_DISABLED.get(row.id) === row.displayName);
  if (!disabledOk) {
    console.error(
      `abort: disabled set is not exactly the two S-COPY retirements — ${disabled
        .map((row) => `${row.displayName} (${row.id})`)
        .join(", ")}`,
    );
    process.exit(1);
  }

  const renames = computeContiguousRenames(rows);
  console.log(`old -> new mapping (${renames.length} rows change):`);
  for (const rename of renames) {
    console.log(`  ${rename.from} -> ${rename.to} (${rename.id})`);
  }
  if (renames.length === 0) {
    console.log("nothing to rename — already contiguous");
    process.exit(0);
  }

  await db.transaction(async (tx) => {
    let updatedTotal = 0;
    for (const rename of renames) {
      // Guard by the full preflight state (id + enabled + current name):
      // any concurrent mutation makes the count assertion roll back the
      // whole batch instead of silently overwriting it.
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
      updatedTotal += updated.length;
    }
    if (updatedTotal !== renames.length) {
      throw new Error(
        `update affected ${updatedTotal} rows, expected ${renames.length} — rolled back`,
      );
    }
  });

  const readBack = (await db.select().from(savedPuzzlesTable)).map((raw) =>
    savedPuzzleDbRowSchema.parse(raw),
  );
  const disabledAfter = readBack.filter((row) => !row.enabled);
  const disabledAfterOk =
    readBack.length === EXPECTED_TOTAL &&
    disabledAfter.length === EXPECTED_DISABLED.size &&
    disabledAfter.every(
      (row) => EXPECTED_DISABLED.get(row.id) === row.displayName,
    );
  if (!disabledAfterOk) {
    console.error(
      `abort: read-back totals/disabled set changed underneath us (${readBack.length} total, disabled: ${disabledAfter
        .map((row) => `${row.displayName} (${row.id})`)
        .join(", ")})`,
    );
    process.exit(1);
  }
  const enabledAfter = readBack
    .filter((row) => row.enabled)
    .sort((a, b) => a.sortIndex - b.sortIndex);
  if (enabledAfter.length !== EXPECTED_ENABLED) {
    console.error(`abort: read-back enabled count ${enabledAfter.length}`);
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
    `renumber complete: enabled rows are ${actualNames[0]} .. ${actualNames[actualNames.length - 1]}, contiguous and unique`,
  );
  process.exit(0);
};

await main();
