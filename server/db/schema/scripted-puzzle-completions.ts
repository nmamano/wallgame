import {
  pgTable,
  serial,
  integer,
  varchar,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Completions of the 10 hand-scripted puzzles (S-G3).
 *
 * These are CLIENT-ASSERTED, unlike generated-puzzle completions, which are
 * derived from the game record and so server-verified. A scripted puzzle is a
 * guided walkthrough played entirely client-side — there is no game to verify
 * — and the same trust model already backs `campaign_progress`. The write
 * endpoint validates the id against the known scripted set so the open path
 * cannot insert arbitrary rows.
 *
 * `userId` is NULLABLE on purpose: anonymous completions are recorded as
 * usage telemetry (Nil's decision), while logged-in ones are a player's
 * progress. The single UNIQUE (user_id, puzzle_id) constraint gives BOTH
 * behaviours, because PostgreSQL treats NULLs as DISTINCT in a unique
 * constraint: a logged-in user can have at most one row per puzzle (so the
 * write is idempotent), while anonymous rows never conflict and accumulate
 * as events. Anonymous counts are best-effort telemetry, NOT trustworthy
 * unique-user statistics.
 */
export const scriptedPuzzleCompletionsTable = pgTable(
  "scripted_puzzle_completions",
  {
    id: serial("id").primaryKey(),
    /** NULL for anonymous completions; see the note above. */
    userId: integer("user_id").references(() => usersTable.userId, {
      onDelete: "cascade",
    }),
    puzzleId: varchar("puzzle_id", { length: 32 }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("scripted_puzzle_completions_user_puzzle_unique").on(
      table.userId,
      table.puzzleId,
    ),
  ],
);
