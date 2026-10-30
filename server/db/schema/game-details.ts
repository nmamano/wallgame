import { pgTable, varchar, jsonb, text } from "drizzle-orm/pg-core";
import { gamesTable } from "./games";

export const gameDetailsTable = pgTable("game_details", {
  gameId: varchar("game_id", { length: 255 })
    .primaryKey()
    .references(() => gamesTable.gameId, { onDelete: "cascade" }),
  configParameters: jsonb("config_parameters"), // Variant-specific game configuration parameters
  moves: jsonb("moves").notNull(), // Custom notation for all moves
  /**
   * Each side's clock after every move and at the end, in seconds (shape:
   * StoredGameClocks in shared/contracts/game-clocks.ts). NULL for every game
   * stored before 2026-10-30: those clocks were never recorded, and the
   * notation alone cannot rebuild them, so a replay shows no time for them.
   */
  clocks: jsonb("clocks"),
  /**
   * Why the server resigned a bot, NULL for every game a bot did not lose this
   * way. A bot cannot resign as a game decision - nothing in the bot protocol
   * lets it - so each of these is the server forfeiting on its behalf, and
   * game_players.outcome_reason records only the word "resignation".
   *
   * Without this the cause lived solely in a console.error, and Fly keeps no
   * historical logs, which is why roughly three of these a day went
   * undiagnosed: a dead engine, a takeback race and a routine client restart
   * were indistinguishable after the fact.
   */
  botResignCause: text("bot_resign_cause"),
});
