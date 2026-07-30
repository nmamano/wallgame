import { pgTable, varchar, timestamp } from "drizzle-orm/pg-core";

/**
 * The ledger of games whose ratings have been applied. One row per game, ever.
 *
 * Rating a game was not idempotent before this table existed.
 * `processRatingUpdate` re-reads `gameState.status === "finished"`, which stays
 * true forever, and nothing recorded that a game had already been counted - so
 * two finish paths interleaving (a timeout racing a resignation) would move both
 * players' ratings twice. Persistence has always protected itself with
 * `onConflictDoNothing` on `game_id`; the rating path had no equivalent.
 *
 * The insert happens inside the same transaction as the rating writes. If it
 * conflicts, the game was already rated and the transaction makes no changes.
 *
 * Deliberately NOT a foreign key to `games`. Ratings commit BEFORE persistence
 * on every finish path (see server/routes/game-socket.ts), so at insert time the
 * game row does not exist yet, and a reference would fail on every single game.
 *
 * A row here with no matching game is therefore not garbage - it is the record
 * of exactly the durability divergence this ordering allows, where the rating
 * committed and persistence then failed. The backfill leans on the same
 * ordering when it treats "present in `games`" as "its rating already
 * committed", which is a good working rule rather than a guarantee.
 */
export const ratingEventsTable = pgTable("rating_events", {
  gameId: varchar("game_id", { length: 255 }).primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
