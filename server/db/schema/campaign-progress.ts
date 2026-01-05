import {
  pgTable,
  integer,
  varchar,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const campaignProgressTable = pgTable(
  "campaign_progress",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "cascade" }),
    levelId: varchar("level_id", { length: 32 }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.levelId] })],
);
