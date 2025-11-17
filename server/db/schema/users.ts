import {
  pgTable,
  integer,
  varchar,
  boolean,
  timestamp,
  text,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const usersTable = pgTable(
  "users",
  {
    userId: integer("user_id").primaryKey().generatedAlwaysAsIdentity(),
    displayName: varchar("display_name", { length: 255 }).notNull().unique(),
    capitalizedDisplayName: varchar("capitalized_display_name", {
      length: 255,
    }).notNull(),
    authProvider: varchar("auth_provider", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    isDeleted: boolean("is_deleted").notNull().default(false),
  },
  (table) => [
    check(
      "lowercase_display_name",
      sql`${table.displayName} = LOWER(${table.displayName})`
    ),
  ]
);

export const userAuthTable = pgTable(
  "user_auth",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "cascade" }),
    authProvider: varchar("auth_provider", { length: 255 }).notNull(),
    authUserId: text("auth_user_id").notNull().unique(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.authProvider] })]
);
