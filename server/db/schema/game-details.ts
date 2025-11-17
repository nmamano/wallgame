import { pgTable, integer, jsonb } from "drizzle-orm/pg-core";
import { gamesTable } from "./games";

export const gameDetailsTable = pgTable("game_details", {
  gameId: integer("game_id")
    .primaryKey()
    .references(() => gamesTable.gameId, { onDelete: "cascade" }),
  configParameters: jsonb("config_parameters"), // Variant-specific game configuration parameters
  moves: jsonb("moves").notNull(), // Custom notation for all moves
});
