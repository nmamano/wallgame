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
 * Completions of solo-campaign levels (S-CAMP).
 *
 * The campaign is played entirely in the browser against a local AI, so no
 * game session ever reaches the server and completion CANNOT be verified the
 * way a generated puzzle's is. It is client-asserted, exactly like the
 * scripted puzzles, and this table mirrors
 * `scripted_puzzle_completions` field for field so the two behave the same.
 *
 * `userId` is NULLABLE on purpose: anonymous completions are recorded as
 * usage telemetry, while logged-in ones are a player's progress. The single
 * UNIQUE (user_id, level_id) constraint gives BOTH behaviours, because
 * PostgreSQL treats NULLs as DISTINCT in a unique constraint: a logged-in
 * user has at most one row per level (so the write is idempotent), while
 * anonymous rows never conflict and accumulate as events. Anonymous counts
 * are best-effort telemetry, NOT trustworthy unique-user statistics.
 *
 * This replaces `campaign_progress`, whose composite PRIMARY KEY
 * (user_id, level_id) structurally cannot hold an anonymous row — primary
 * key columns cannot be NULL, and dropping a primary key is not an additive
 * migration. During the transition the progress read UNIONS both tables; see
 * `server/games/campaign-progress.ts`.
 */
export const campaignLevelCompletionsTable = pgTable(
  "campaign_level_completions",
  {
    id: serial("id").primaryKey(),
    /** NULL for anonymous completions; see the note above. */
    userId: integer("user_id").references(() => usersTable.userId, {
      onDelete: "cascade",
    }),
    levelId: varchar("level_id", { length: 32 }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("campaign_level_completions_user_level_unique").on(
      table.userId,
      table.levelId,
    ),
  ],
);
