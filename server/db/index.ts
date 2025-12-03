// Manages the connection to the database.
//
// IMPORTANT: The DB URL is read from process.env.DATABASE_URL at import time.
// For tests using Testcontainers, set DATABASE_URL before importing this module.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required");
}

// As soon as you do import "@/server/db", this runs right then, and
// reads process.env.DATABASE_URL. So the DB URL is locked in at import time.
const queryClient = postgres(url);
export const db = drizzle(queryClient);
