import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";

import { db } from "../db";
import { savedPuzzlesTable } from "../db/schema/saved-puzzles";
import { mapSavedPuzzleRows } from "../../shared/contracts/puzzles";

/**
 * Saved puzzles (S-G1): read-only listing of the named persisted puzzles.
 *
 * DB JSONB is untrusted: every row is validated through the shared contract
 * before it is returned; a corrupted enabled row fails the request closed
 * (500) rather than reaching a client's launch flow.
 *
 * This replaces the legacy tutorial-era CRUD route (unauthenticated
 * POST/DELETE on the old `puzzles` table) — that surface is intentionally
 * gone. Seeding/curation happen server-side (scripts/seed-puzzles.ts), not
 * over HTTP.
 */
export const puzzlesRoute = new Hono().get("/", async (c) => {
  try {
    const rows = await db
      .select()
      .from(savedPuzzlesTable)
      .where(eq(savedPuzzlesTable.enabled, true))
      .orderBy(asc(savedPuzzlesTable.sortIndex));
    const puzzles = mapSavedPuzzleRows(rows);
    return c.json({ puzzles });
  } catch (error) {
    console.error("[puzzles] failed to list saved puzzles", { error });
    return c.json({ error: "Failed to load puzzles" }, 500);
  }
});
