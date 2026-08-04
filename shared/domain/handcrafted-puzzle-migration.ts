/**
 * Planning the one-shot move of the authored puzzles into `saved_puzzles`.
 *
 * Split out from the script that runs it so the arithmetic can be tested
 * without a database. It is the highest-risk code in this change — it runs
 * once, against real rows, and gets every puzzle's number right or wrong in a
 * single pass — and the failure it is most likely to produce is not a crash
 * but a quietly wrong ordering that nobody notices for weeks.
 *
 * Nothing here touches a database, reads a clock, or generates an id.
 */

import { buildHandcraftedSeedRows } from "./handcrafted-puzzle-rows";
import type { HandcraftedSeedRow } from "./handcrafted-puzzle-rows";

/**
 * curated-first  the authored ten become Puzzles 1-10 and every generated
 *                puzzle shifts up by ten. Reads best, and the links already
 *                shared for the authored puzzles keep pointing at the same
 *                puzzles — but every generated link shifts to a different one.
 *
 * curated-last   the authored ten are appended after the generated set. No
 *                generated link changes meaning; the easiest puzzles are
 *                numbered last, which reads oddly.
 */
export type MigrationMode = "curated-first" | "curated-last";

/** The columns of an existing row the plan reasons about. */
export interface ExistingPuzzleRow {
  id: string;
  displayName: string;
  sortIndex: number;
  enabled: boolean;
}

export interface PlannedRenumber {
  id: string;
  sortIndex: number;
  /** Only set when the visible number changes; absent means "leave the name". */
  displayName?: string;
}

export interface MigrationPlan {
  /**
   * How far out of the way existing rows are parked before landing on their
   * final indices. sort_index is UNIQUE and PostgreSQL checks it row by row,
   * so shifting in place would collide with a row it has not moved yet.
   */
  parkOffset: number;
  renumber: PlannedRenumber[];
  inserts: HandcraftedSeedRow[];
}

const HANDCRAFTED_COUNT = 10;

/** "Puzzle 7" -> 7. Null for a name that does not end in a number. */
export const puzzleNumberFromName = (displayName: string): number | null => {
  const match = /(\d+)\s*$/.exec(displayName);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
};

export const planHandcraftedMigration = (
  mode: MigrationMode,
  existing: ExistingPuzzleRow[],
): MigrationPlan => {
  const highestSortIndex = existing.reduce(
    (max, row) => Math.max(max, row.sortIndex),
    0,
  );
  /**
   * The highest number a player can actually SEE.
   *
   * Counted over ENABLED rows only, because that is the repo's existing
   * invariant: `scripts/retire-puzzles.ts` renumbers the survivors so the
   * visible names stay contiguous "Puzzle 1..K", and a retired row keeps its
   * stale name forever without being a lookup candidate. Including disabled
   * rows here would jump the new puzzles past numbers nothing is using and
   * leave a visible hole in the middle of the sequence.
   */
  const highestVisibleNumber = existing
    .filter((row) => row.enabled)
    .reduce(
      (max, row) => Math.max(max, puzzleNumberFromName(row.displayName) ?? 0),
      0,
    );

  /**
   * Derived from what is actually there rather than a fixed constant: a
   * hardcoded park would collide the day a row exists above it, and that row
   * would be silently overwritten instead of failing.
   */
  const parkOffset = highestSortIndex + HANDCRAFTED_COUNT + 1;

  if (mode === "curated-last") {
    // Straight after the existing rows. Getting this wrong by the size of the
    // batch leaves an unexplained gap that still LOOKS correctly ordered,
    // which is exactly why it is worth a test rather than a careful read.
    const firstSortIndex = highestSortIndex + 1;
    return {
      parkOffset,
      renumber: [],
      inserts: buildHandcraftedSeedRows(firstSortIndex).map((row, index) => ({
        ...row,
        displayName: `Puzzle ${highestVisibleNumber + 1 + index}`,
      })),
    };
  }

  return {
    parkOffset,
    /**
     * Names shift by their OWN number rather than being recomputed from the
     * new sort_index: the visible numbering runs over ENABLED rows only —
     * retired rows keep whatever name they had — so deriving names from
     * sort_index would silently renumber the live set as well.
     */
    renumber: existing.map((row) => {
      const current = puzzleNumberFromName(row.displayName);
      const renamed = row.enabled && current !== null;
      return {
        id: row.id,
        sortIndex: row.sortIndex + HANDCRAFTED_COUNT,
        ...(renamed
          ? { displayName: `Puzzle ${current + HANDCRAFTED_COUNT}` }
          : {}),
      };
    }),
    inserts: buildHandcraftedSeedRows(1),
  };
};
