import { eq, inArray } from "drizzle-orm";

import { savedPuzzlesTable } from "./schema/saved-puzzles";
import { scriptedPuzzleCompletionsTable } from "./schema/scripted-puzzle-completions";
import {
  planHandcraftedMigration,
  type MigrationMode,
} from "../../shared/domain/handcrafted-puzzle-migration";
import { savedPuzzleSeedRowSchema } from "../../shared/contracts/puzzles";

/**
 * Applying the authored-puzzle migration to a database.
 *
 * Separate from `scripts/migrate-handcrafted-puzzles.ts` so the script and its
 * test run the SAME code. This is a one-shot migration against real rows —
 * the kind of thing that gets read carefully once and then run once — so the
 * only verification worth having is a rehearsal on a database shaped like
 * production, and that is impossible if the logic lives inside a script that
 * calls process.exit.
 *
 * The arithmetic is elsewhere again (shared/domain/handcrafted-puzzle-
 * migration.ts) and unit tested without any database. What is here is only
 * what genuinely needs one.
 */

export interface HandcraftedMigrationResult {
  /** False when the authored puzzles were already migrated. */
  applied: boolean;
  renumbered: number;
  inserted: number;
  movedCompletions: number;
  /** What the inserted rows ended up called, in order. */
  insertedNames: string[];
}

type Tx = Parameters<Parameters<typeof import("./index").db.transaction>[0]>[0];

export const applyHandcraftedMigration = async (
  tx: Tx,
  mode: MigrationMode,
  mintId: () => string,
): Promise<HandcraftedMigrationResult> => {
  const existing = await tx
    .select({
      id: savedPuzzlesTable.id,
      displayName: savedPuzzlesTable.displayName,
      sortIndex: savedPuzzlesTable.sortIndex,
      enabled: savedPuzzlesTable.enabled,
      legacyScriptedId: savedPuzzlesTable.legacyScriptedId,
    })
    .from(savedPuzzlesTable);

  // Matched on legacy_scripted_id, which is UNIQUE: a second run finds the
  // authored rows already present and stops before renumbering anything twice.
  if (existing.some((row) => row.legacyScriptedId !== null)) {
    return {
      applied: false,
      renumbered: 0,
      inserted: 0,
      movedCompletions: 0,
      insertedNames: [],
    };
  }

  const plan = planHandcraftedMigration(mode, existing);

  /**
   * Two passes: park every row above everything that exists, then land it.
   * sort_index is UNIQUE and checked row by row, so moving rows straight to
   * their final indices would collide with one that has not moved yet,
   * depending purely on update order.
   */
  for (const row of plan.renumber) {
    await tx
      .update(savedPuzzlesTable)
      .set({ sortIndex: row.sortIndex + plan.parkOffset })
      .where(eq(savedPuzzlesTable.id, row.id));
  }
  for (const row of plan.renumber) {
    await tx
      .update(savedPuzzlesTable)
      .set({
        sortIndex: row.sortIndex,
        ...(row.displayName ? { displayName: row.displayName } : {}),
      })
      .where(eq(savedPuzzlesTable.id, row.id));
  }

  const rows = plan.inserts.map((row) => {
    const withId = { id: mintId(), ...row };
    // Validate against the boundary contract BEFORE anything is written.
    savedPuzzleSeedRowSchema.parse(withId);
    return withId;
  });

  await tx.insert(savedPuzzlesTable).values(rows);

  /**
   * The completions move with the puzzles. They were recorded against the
   * authored ids ("1".."10"), which stop meaning anything the moment those
   * puzzles become rows, so each is rewritten to name the row it belongs to.
   *
   * An id rewrite rather than a lookup at read time on purpose: a permanent
   * mapping would be a second place where a puzzle's identity is decided, and
   * it would have to survive every future renumbering.
   *
   * What does NOT change: these stay CLIENT-ASSERTED. They mark a card solved
   * and nothing more — voting reads decisive games, never this table.
   */
  let movedCompletions = 0;
  for (const row of rows) {
    const updated = await tx
      .update(scriptedPuzzleCompletionsTable)
      .set({ puzzleId: row.id })
      .where(eq(scriptedPuzzleCompletionsTable.puzzleId, row.legacyScriptedId!))
      .returning({ id: scriptedPuzzleCompletionsTable.id });
    movedCompletions += updated.length;
  }

  const stragglers = await tx
    .select({ puzzleId: scriptedPuzzleCompletionsTable.puzzleId })
    .from(scriptedPuzzleCompletionsTable)
    .where(
      inArray(
        scriptedPuzzleCompletionsTable.puzzleId,
        rows.map((row) => row.legacyScriptedId!),
      ),
    );
  if (stragglers.length > 0) {
    // Never silently: a completion still naming an authored id after the
    // rewrite means the transaction is about to leave the table inconsistent.
    throw new Error(
      `${stragglers.length} completions still reference authored ids; rolling back`,
    );
  }

  return {
    applied: true,
    renumbered: plan.renumber.length,
    inserted: rows.length,
    movedCompletions,
    insertedNames: rows.map((row) => row.displayName),
  };
};
