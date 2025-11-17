import { pgTable, varchar, jsonb } from "drizzle-orm/pg-core";

export const builtInBotsTable = pgTable("built_in_bots", {
  botId: varchar("bot_id", { length: 255 }).primaryKey(),
  // Fields should not be changed after creation
  // e.g., "Easy Bot", "Medium Bot", "Hard Bot". Not unique. Uppercase allowed.
  displayName: varchar("display_name", { length: 255 }).notNull(),
  metadata: jsonb("metadata"), // metadata provided by the bot service (e.g., compilation flags)
});
