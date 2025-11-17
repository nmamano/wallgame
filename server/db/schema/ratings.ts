import {
  pgTable,
  integer,
  varchar,
  timestamp,
  primaryKey,
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
    rating: integer("rating").notNull().default(1200),
    // Precomputed fields by the backend:
    peakRating: integer("peak_rating").notNull().default(1200),
    recordWins: integer("record_wins").notNull().default(0),
    recordLosses: integer("record_losses").notNull().default(0),
    lastGameAt: timestamp("last_game_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.variant, table.timeControl] }),
  ]
);
