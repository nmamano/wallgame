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
 * assertions; renumbers survivors.
 *
 * The read-back proves EXACT SETS rather than counts — the id set is
 * unchanged, the newly-disabled set equals the requested targets exactly,
 * the surviving enabled set equals the preflight enabled set minus targets,
 * rows already disabled stay disabled with their historical names, and no
 * row's fingerprint, sortIndex or config moved. A write that disabled the
 * right NUMBER of wrong rows passes a count check; it does not pass this.
 *
 * Pass every name in ONE invocation. Names shift as survivors renumber, so
 * six sequential runs would resolve later names against an already-changed
 * numbering.
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

  // Read-back proves the EXACT sets, not just counts: a write that disabled
  // the right number of rows but the wrong ones would pass a count check.
  const abort = (message: string, detail?: unknown): never => {
    console.error(`abort: ${message}`, detail ?? "");
    process.exit(1);
  };
  const sorted = (ids: Iterable<string>) => [...ids].sort();
  const sameSet = (a: Iterable<string>, b: Iterable<string>) =>
    JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

  if (readBack.length !== rows.length) {
    abort(`read-back total ${readBack.length} != preflight ${rows.length}`);
  }
  const preflightById = new Map(rows.map((row) => [row.id, row]));
  const readBackById = new Map(readBack.map((row) => [row.id, row]));
  if (!sameSet(preflightById.keys(), readBackById.keys())) {
    abort("read-back id set differs from preflight");
  }

  // Exactly the targets are newly disabled; every row already disabled stays
  // disabled and untouched.
  const preflightEnabledIds = new Set(enabledRows.map((row) => row.id));
  const expectedEnabledIds = new Set(
    [...preflightEnabledIds].filter((id) => !targetIds.has(id)),
  );
  const enabledAfterIds = new Set(
    readBack.filter((row) => row.enabled).map((row) => row.id),
  );
  if (!sameSet(enabledAfterIds, expectedEnabledIds)) {
    abort("read-back enabled id set != preflight enabled minus targets");
  }
  const newlyDisabled = [...preflightEnabledIds].filter(
    (id) => !enabledAfterIds.has(id),
  );
  if (!sameSet(newlyDisabled, targetIds)) {
    abort("read-back newly-disabled set != requested targets", newlyDisabled);
  }

  // Nothing but the enabled rows' display names may change: identity
  // (fingerprint), position (sortIndex), and the launch config are invariant
  // for EVERY row, and previously disabled rows keep their historical names.
  const plannedRenames = new Map(renames.map((r) => [r.id, r.to]));
  for (const before of rows) {
    const after = readBackById.get(before.id)!;
    if (
      after.sourceFingerprint !== before.sourceFingerprint ||
      after.sortIndex !== before.sortIndex ||
      JSON.stringify(after.config) !== JSON.stringify(before.config)
    ) {
      abort(`row ${before.id} changed fingerprint, sortIndex or config`);
    }
    const expectedName = plannedRenames.get(before.id) ?? before.displayName;
    if (after.displayName !== expectedName) {
      abort(
        `row ${before.id} name is "${after.displayName}", expected "${expectedName}"`,
      );
    }
  }

  const enabledAfter = readBack
    .filter((row) => row.enabled)
    .sort((a, b) => a.sortIndex - b.sortIndex);
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
