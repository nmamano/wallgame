import { pgTable, varchar, jsonb, boolean } from "drizzle-orm/pg-core";

export const builtInBotsTable = pgTable("built_in_bots", {
  // Primary key: composite ID (clientId:botId) - uniquely identifies a bot across clients
  botId: varchar("bot_id", { length: 255 }).primaryKey(),
  // e.g., "Easy Bot", "Medium Bot", "Hard Bot". Not unique. Uppercase allowed.
  displayName: varchar("display_name", { length: 255 }).notNull(),
  // Whether this bot is official (verified by the server via officialToken)
  isOfficial: boolean("is_official").notNull().default(false),
  // Metadata provided by the bot service (e.g., compilation flags, appearance)
  metadata: jsonb("metadata"),
});
