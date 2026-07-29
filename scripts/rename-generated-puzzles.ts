/**
 * ONE-TIME rename: drop the word "Generated" from every enabled saved
 * puzzle's display name, so the generated set reads "Puzzle 1..N" like the
 * hand-authored one (Nil, 2026-07-29 — "Generated" described how a puzzle
 * was made, which is not the player's business).
 *
 * The two sets now share a numbering space on purpose. That is safe because
 * a display name is presentation: identity is the row id, and seed matching
 * is by sourceFingerprint. See `generatedPuzzleDisplayName`.
 *
 * Runs INSIDE the deployed Fly machine (which has DATABASE_URL); it is NOT
 * part of release_command — a data rename is a deliberate manual step:
 *
 *   fly ssh console -a wallgame -C "bun scripts/rename-generated-puzzles.ts"
 *
 * Fail-closed. The whole-table invariants (exact total, exact disabled set
 * by id AND name) are checked FIRST, before either the already-renamed exit
 * or the rename itself, so a re-run cannot skip them. New names come from
 * the shipped `computeContiguousRenames`, so this script adds no naming
 * logic of its own; updates are id-targeted in one transaction with an
 * exact affected-count assertion, and the read-back asserts the enabled
 * names are exactly "Puzzle 1..K", unique, in sortIndex order.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../server/db";
import { savedPuzzlesTable } from "../server/db/schema/saved-puzzles";
import { savedPuzzleDbRowSchema } from "../shared/contracts/puzzles";
import {
  computeContiguousRenames,
  generatedPuzzleDisplayName,
} from "../shared/domain/saved-puzzles";

/** Production state measured read-only on 2026-07-29 before writing this. */
const EXPECTED_TOTAL = 41;
const EXPECTED_ENABLED = 39;
/** The two S-COPY retirements, which keep their historical names. */
const EXPECTED_DISABLED = new Map([
  ["Mq_qSzIpaZ", "Generated Puzzle 1"],
  ["q6Eozcuqqx", "Generated Puzzle 6"],
]);

/** The naming this script replaces. */
const legacyDisplayName = (position: number): string =>
  `Generated Puzzle ${position}`;

const readRows = async () =>
  (await db.select().from(savedPuzzlesTable)).map((raw) =>
    savedPuzzleDbRowSchema.parse(raw),
  );

/**
 * Whole-table invariants that must hold whether or not the rename has
 * already run: exact row count, and the disabled set is exactly the two
 * known retirements by id AND name. Idempotence must not bypass these, so
 * both paths below call this first.
 */
const assertTableShape = (rows: Awaited<ReturnType<typeof readRows>>) => {
  const enabled = rows.filter((row) => row.enabled);
  const disabled = rows.filter((row) => !row.enabled);
  if (rows.length !== EXPECTED_TOTAL || enabled.length !== EXPECTED_ENABLED) {
    console.error(
      `abort: expected ${EXPECTED_TOTAL} total / ${EXPECTED_ENABLED} enabled, saw ${rows.length} / ${enabled.length}`,
    );
    process.exit(1);
  }
  const disabledOk =
    disabled.length === EXPECTED_DISABLED.size &&
    disabled.every((row) => EXPECTED_DISABLED.get(row.id) === row.displayName);
  if (!disabledOk) {
    console.error(
      `abort: disabled set is not exactly the two known retirements — ${disabled
        .map((row) => `${row.displayName} (${row.id})`)
        .join(", ")}`,
    );
    process.exit(1);
  }
  return enabled.sort((a, b) => a.sortIndex - b.sortIndex);
};

const namesMatch = (
  enabled: { displayName: string }[],
  expected: (position: number) => string,
) => enabled.every((row, index) => row.displayName === expected(index + 1));

const main = async () => {
  const rows = await readRows();
  console.log(`pre-write: ${rows.length} total`);
  const enabled = assertTableShape(rows);

  if (namesMatch(enabled, generatedPuzzleDisplayName)) {
    console.log(
      `nothing to do: enabled rows are already ${enabled[0].displayName} .. ${enabled[enabled.length - 1].displayName}`,
    );
    process.exit(0);
  }
  if (!namesMatch(enabled, legacyDisplayName)) {
    console.error(
      "abort: enabled names are neither the expected legacy set nor the renamed set",
      enabled.map((row) => row.displayName),
    );
    process.exit(1);
  }

  const renames = computeContiguousRenames(rows);
  console.log(`old -> new mapping (${renames.length} rows change):`);
  for (const rename of renames) {
    console.log(`  ${rename.from} -> ${rename.to} (${rename.id})`);
  }
  if (renames.length !== EXPECTED_ENABLED) {
    console.error(
      `abort: expected ${EXPECTED_ENABLED} renames, computed ${renames.length}`,
    );
    process.exit(1);
  }

  await db.transaction(async (tx) => {
    let updatedTotal = 0;
    for (const rename of renames) {
      // Guarded by the full preflight state (id + enabled + current name):
      // any concurrent mutation makes the count assertion below roll back
      // the whole batch instead of silently overwriting it.
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

  const readBack = await readRows();
  const enabledAfter = assertTableShape(readBack);
  const actualNames = enabledAfter.map((row) => row.displayName);
  if (
    !namesMatch(enabledAfter, generatedPuzzleDisplayName) ||
    new Set(actualNames).size !== actualNames.length
  ) {
    console.error("abort: read-back names not contiguous/unique", actualNames);
    process.exit(1);
  }
  console.log(
    `rename complete: enabled rows are ${actualNames[0]} .. ${actualNames[actualNames.length - 1]}, contiguous and unique`,
  );
  process.exit(0);
};

await main();
