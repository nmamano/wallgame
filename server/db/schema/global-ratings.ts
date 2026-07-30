import {
  pgTable,
  integer,
  timestamp,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * One rating per player, over every rated game they have played, regardless of
 * variant or time control.
 *
 * This is a second, independent Glicko-2 chain rather than an aggregate of the
 * twelve `ratings` rows. An average of ratings is not itself a rating: it has no
 * deviation, and it weights a one-game bucket the same as a two-hundred-game
 * one. A player's global rating is updated against their opponent's GLOBAL
 * rating, never against a per-variant one, or the number would not be a
 * Glicko-2 rating of anything.
 *
 * Why a separate table instead of a `variant = 'all'` row in `ratings`: those
 * columns are plain varchars, so a sentinel would silently become a legal value
 * for every present and future reader - matchmaking lookups, the ranking
 * dropdown, any later aggregation - with nothing in the type system to catch a
 * query that forgot to exclude it. Here there is no dimension column to lie
 * about.
 */
export const globalRatingsTable = pgTable("global_ratings", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => usersTable.userId, { onDelete: "cascade" }),
  // Glicko-2 state, same meanings and defaults as `ratings`.
  rating: doublePrecision("rating").notNull().default(1500),
  ratingDeviation: doublePrecision("rating_deviation").notNull().default(350),
  volatility: doublePrecision("volatility").notNull().default(0.06),
  // Precomputed by the backend:
  peakRating: doublePrecision("peak_rating").notNull().default(1500),
  recordWins: doublePrecision("record_wins").notNull().default(0),
  recordLosses: doublePrecision("record_losses").notNull().default(0),
  lastGameAt: timestamp("last_game_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
