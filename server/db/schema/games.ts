import {
  pgTable,
  integer,
  varchar,
  boolean,
  timestamp,
  text,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { savedPuzzlesTable } from "./saved-puzzles";

export const gamesTable = pgTable(
  "games",
  {
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
    /**
     * Which match this game belongs to, and its position in that match.
     *
     * The server already knew both: `GameSession.seriesId` is the first game's
     * own id, inherited unchanged by every rematch, and `rematchNumber` counts
     * from 0. Neither ever reached the database, so a rematch chain had to be
     * inferred from timestamps - which is why "how many games does one person
     * play in a sitting" was an estimate rather than a query.
     *
     * A group key rather than a link to the previous game: games per match is
     * then a GROUP BY instead of a recursive walk, and it still answers
     * correctly when an earlier game in the chain failed to persist. For the
     * same reason `series_id` is deliberately NOT a foreign key - the root game
     * can legitimately be missing from history.
     */
    seriesId: varchar("series_id", { length: 255 }),
    rematchNumber: integer("rematch_number"),
  },
  (table) => [
    /**
     * Both or neither. A row with a series and no ordinal, or an ordinal
     * belonging to no series, is a half-written row rather than a legacy one.
     * Both NULL is the honest legacy value: written before match tracking
     * existed. Old games are deliberately not backfilled as standalone
     * series, because that would invent a fact rather than record one.
     */
    check(
      "games_match_tracking_paired",
      sql`(${table.seriesId} IS NULL) = (${table.rematchNumber} IS NULL)`,
    ),
    /** 0 is the first game of a match; below that is a bug, not a game. */
    check(
      "games_rematch_number_non_negative",
      sql`${table.rematchNumber} IS NULL OR ${table.rematchNumber} >= 0`,
    ),
    /**
     * One game per position per match. Postgres allows many rows where both
     * are NULL, so the legacy games cost this nothing, while a duplicated
     * ordinal inside a tracked series - two games claiming to be the same
     * rematch - is rejected. It is also the index a "fetch this match" query
     * will want.
     */
    uniqueIndex("games_series_position_unique").on(
      table.seriesId,
      table.rematchNumber,
    ),
  ],
);
