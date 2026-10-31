import {
  pgTable,
  serial,
  varchar,
  integer,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * One row for every move a bot sent that the game refused. Before this table a
 * refused bot move left no trace at all: no game_details cause, no row, nothing
 * the archive could count. Two real engine defects (the Animal Cycle notation
 * bug and the padding-wall defect, board tasks 1c12981b and a74a9963) produced
 * exactly such moves, and "how often in production" had no answer.
 *
 * No foreign key to games on purpose: the game row is written only when the
 * game finishes, and a game with a refused move may never get one.
 */
export const botMoveRefusalsTable = pgTable("bot_move_refusals", {
  id: serial("id").primaryKey(),
  gameId: varchar("game_id", { length: 255 }).notNull(),
  /** "clientId:botId", as the server knows the bot. */
  botCompositeId: text("bot_composite_id").notNull(),
  /** The ply the move was for: the number of moves already played. */
  ply: integer("ply").notNull(),
  /**
   * The move EXACTLY as the bot client sent it. game_details.moves is
   * re-serialised from the applied game state, so this is the only place
   * the wire string is kept.
   */
  wireMove: text("wire_move").notNull(),
  /** Why the game refused it: the parser's or the rules' message. */
  reason: text("reason").notNull(),
  refusedAt: timestamp("refused_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
