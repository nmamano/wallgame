import { pgTable, varchar, jsonb } from "drizzle-orm/pg-core";
import { gamesTable } from "./games";

export const gameDetailsTable = pgTable("game_details", {
  gameId: varchar("game_id", { length: 255 })
    .primaryKey()
    .references(() => gamesTable.gameId, { onDelete: "cascade" }),
  configParameters: jsonb("config_parameters"), // Variant-specific game configuration parameters
  moves: jsonb("moves").notNull(), // Custom notation for all moves
});
