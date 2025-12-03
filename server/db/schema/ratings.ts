import {
  pgTable,
  integer,
  varchar,
  timestamp,
  primaryKey,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const ratingsTable = pgTable(
  "ratings",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "cascade" }),
    variant: varchar("variant", { length: 255 }).notNull(), // "standard" or "classic"
    timeControl: varchar("time_control", { length: 255 }).notNull(), // "bullet", "blitz", "rapid", or "classical"
    // Glicko-2 rating state (rating, ratingDeviation, volatility)
    rating: doublePrecision("rating").notNull().default(1500),
    ratingDeviation: doublePrecision("rating_deviation").notNull().default(350),
    volatility: doublePrecision("volatility").notNull().default(0.06),
    // Precomputed fields by the backend:
    peakRating: doublePrecision("peak_rating").notNull().default(1500),
    recordWins: integer("record_wins").notNull().default(0),
    recordLosses: integer("record_losses").notNull().default(0),
    lastGameAt: timestamp("last_game_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.variant, table.timeControl] }),
  ],
);
