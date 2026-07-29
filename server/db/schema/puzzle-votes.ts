import {
  pgTable,
  integer,
  smallint,
  text,
  timestamp,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { savedPuzzlesTable } from "./saved-puzzles";

/**
 * Likes and dislikes on generated puzzles (S-G4).
 *
 * A vote is EARNED: only a player who has decisively beaten the puzzle may
 * cast one (enforced at the write, using the same rule that answers "have I
 * solved this" — `hasSolvedGeneratedPuzzle` in
 * `server/games/puzzle-progress.ts`). That is why `userId` is NOT NULL here,
 * unlike the two completion tables: an anonymous vote cannot be earned, so
 * there is no telemetry case to keep. One row per user and puzzle, changeable
 * (flip the value) and removable (delete the row).
 *
 * Scope is the GENERATED set only. The scripted puzzles are a fixed ordered
 * tutorial set, not rows in `saved_puzzles`, and the capture point — the game
 * page right after a win — does not exist for them.
 *
 * Votes inform curation; they never retire a puzzle on their own. Nil is the
 * filter, and no automated puzzle-quality gating exists anywhere in this
 * feature.
 */
export const puzzleVotesTable = pgTable(
  "puzzle_votes",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "cascade" }),
    puzzleId: text("puzzle_id")
      .notNull()
      .references(() => savedPuzzlesTable.id),
    /** +1 like, -1 dislike; the CHECK below is what makes that true. */
    value: smallint("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.puzzleId] }),
    // Aggregates are computed as sums and counts of this column, so a value
    // outside {-1, 1} would silently corrupt every score rather than fail.
    check("puzzle_votes_value_check", sql`${table.value} in (-1, 1)`),
  ],
);
