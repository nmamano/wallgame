import {
  pgTable,
  integer,
  varchar,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

export const gamesTable = pgTable("games", {
  gameId: integer("game_id").primaryKey().generatedAlwaysAsIdentity(),
  variant: varchar("variant", { length: 255 }).notNull(),
  timeControl: varchar("time_control", { length: 255 }).notNull(),
  rated: boolean("rated").notNull(),
  boardWidth: integer("board_width").notNull(),
  boardHeight: integer("board_height").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  views: integer("views").notNull().default(0),
  // Precomputed fields by the backend:
  movesCount: integer("moves_count").notNull().default(0),
});
