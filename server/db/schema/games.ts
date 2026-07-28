import {
  pgTable,
  integer,
  varchar,
  boolean,
  timestamp,
  text,
} from "drizzle-orm/pg-core";
import { savedPuzzlesTable } from "./saved-puzzles";

export const gamesTable = pgTable("games", {
  gameId: varchar("game_id", { length: 255 }).primaryKey(),
  variant: varchar("variant", { length: 255 }).notNull(),
  timeControl: varchar("time_control", { length: 255 }).notNull(),
  rated: boolean("rated").notNull(),
  matchType: varchar("match_type", { length: 255 }).notNull(),
  boardWidth: integer("board_width").notNull(),
  boardHeight: integer("board_height").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  views: integer("views").notNull().default(0),
  // Precomputed fields by the backend:
  movesCount: integer("moves_count").notNull().default(0),
  /**
   * Which saved puzzle this game was launched as (S-ID), NULL for every
   * ordinary game. Written only from the puzzle row the SERVER resolved
   * during a server-authoritative launch, never from a client-supplied
   * string — that is what makes completion tracking unforgeable.
   *
   * Puzzles retire via `enabled=false` and are never deleted, so the
   * default restrict-on-delete keeps historical games referentially intact.
   */
  puzzleId: text("puzzle_id").references(() => savedPuzzlesTable.id),
});
