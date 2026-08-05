import {
  pgTable,
  integer,
  varchar,
  uuid,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { gamesTable } from "./games";
import { usersTable } from "./users";
import { builtInBotsTable } from "./built-in-bots";

export const gamePlayersTable = pgTable(
  "game_players",
  {
    gameId: varchar("game_id", { length: 255 })
      .notNull()
      .references(() => gamesTable.gameId, { onDelete: "cascade" }),
    playerOrder: integer("player_order").notNull(), // 1 for the 1st mover, 2 for the 2nd mover, etc.
    playerRole: varchar("player_role", { length: 255 }).notNull(), // "host" or "joiner"
    playerConfigType: varchar("player_config_type", { length: 255 }).notNull(), // "you", "friend", "matched user", "bot", "custom bot"
    displayName: varchar("display_name", { length: 255 }).notNull(),
    userId: integer("user_id").references(() => usersTable.userId), // NULL for non-logged-in users and built-in bots
    /**
     * The browser this seat was played from, when it told us. The guest
     * counterpart of `user_id`, which is why it lives here and not on `games`:
     * a game has two seats and one column could only ever record one of them.
     *
     * Written for every HUMAN seat, including signed-in ones - that adjacency
     * is what answers "did this guest later make an account". NULL for bots.
     *
     * A native `uuid` column, so the shape is enforced for every writer rather
     * than only the ones that go through our Zod schemas.
     *
     * CORRELATION TELEMETRY, NOT AUTHENTICATION. It is supplied by the client,
     * so it can be anything; it must never be read as evidence about the
     * `user_id` beside it. See shared/domain/anonymous-id.ts.
     */
    anonymousId: uuid("anonymous_id"),
    botId: varchar("bot_id", { length: 255 }).references(
      () => builtInBotsTable.botId,
    ), // Only non-NULL for built-in bots
    ratingAtStart: integer("rating_at_start"), // Rating at game start, NULL for custom bots
    pawnColor: varchar("pawn_color", { length: 64 }),
    catSkin: varchar("cat_skin", { length: 255 }),
    mouseSkin: varchar("mouse_skin", { length: 255 }),
    homeSkin: varchar("home_skin", { length: 255 }),
    outcomeRank: integer("outcome_rank").notNull(), // e.g., 1 for winner
    outcomeReason: varchar("outcome_reason", { length: 255 }).notNull(), // "timeout", "resignation", "knockout", "agreement", "tie", "abandoned"
  },
  (table) => [
    primaryKey({ columns: [table.gameId, table.playerOrder] }),
    /**
     * Puzzle completion (S-G3) asks "which games did THIS user win", and the
     * primary key begins with game_id, so it cannot find one user's rows
     * without a scan as history grows. This index leads with user_id; the
     * opponent's row is then reached through the primary key, since a game
     * has only two rows.
     */
    index("game_players_user_outcome_idx").on(
      table.userId,
      table.outcomeRank,
      table.gameId,
    ),
  ],
);
