import { pgTable, serial, varchar, integer } from "drizzle-orm/pg-core";

// This defines a table in the database.
// In order to create it, we need a migration.
export const puzzlesTable = pgTable("puzzles", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 100 }).notNull(),
  author: varchar("author", { length: 100 }).notNull(),
  rating: integer("rating").notNull(),
});
