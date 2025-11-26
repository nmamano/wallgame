import {
  pgTable,
  integer,
  varchar,
  boolean,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const userSettingsTable = pgTable("user_settings", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => usersTable.userId, { onDelete: "cascade" }),
  // dark_theme removed - dark mode is stored in localStorage only
  boardTheme: varchar("board_theme", { length: 255 })
    .notNull()
    .default("default"),
  pawnColor: varchar("pawn_color", { length: 255 })
    .notNull()
    .default("default"),
  defaultVariant: varchar("default_variant", { length: 255 })
    .notNull()
    .default("standard"),
  defaultTimeControl: varchar("default_time_control", { length: 255 })
    .notNull()
    .default("rapid"),
  defaultRatedStatus: boolean("default_rated_status").notNull().default(true),
});

export const userPawnSettingsTable = pgTable(
  "user_pawn_settings",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "cascade" }),
    pawnType: varchar("pawn_type", { length: 255 }).notNull(),
    pawnShape: varchar("pawn_shape", { length: 255 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.pawnType] })],
);

export const userVariantSettingsTable = pgTable(
  "user_variant_settings",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.userId, { onDelete: "cascade" }),
    variant: varchar("variant", { length: 255 }).notNull(),
    defaultParameters: jsonb("default_parameters").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.variant] })],
);
