import { pgTable, integer, varchar, primaryKey } from "drizzle-orm/pg-core";
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
  (table) => [primaryKey({ columns: [table.gameId, table.playerOrder] })],
);
