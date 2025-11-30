import { Hono } from "hono";

import { db } from "../db";
import { puzzlesTable } from "../db/schema/puzzles";
import { count, eq } from "drizzle-orm";
import { createPostSchema } from "../../shared/contracts/puzzles";

export const puzzlesRoute = new Hono()
  .get("/", async (c) => {
    const puzzles = await db.select().from(puzzlesTable);
    return c.json({ puzzles: puzzles });
  })
  .get("/count", async (c) => {
    const numPuzzles = await db.select({ count: count() }).from(puzzlesTable);
    return c.json({
      count: numPuzzles[0].count,
    });
  })
  .post("/", async (c) => {
    const data = await c.req.json();
    const puzzle = createPostSchema.parse(data);
    const res = await db.insert(puzzlesTable).values(puzzle).returning();
    c.status(201);
    return c.json(res);
  })
  .get("/:id{[0-9]+}", async (c) => {
    const id = Number.parseInt(c.req.param("id"));
    const res = await db
      .select()
      .from(puzzlesTable)
      .where(eq(puzzlesTable.id, id));
    if (res.length === 0) {
      return c.notFound();
    }
    return c.json(res[0]);
  })
  .delete("/:id{[0-9]+}", async (c) => {
    const id = Number.parseInt(c.req.param("id"));
    const res = await db
      .delete(puzzlesTable)
      .where(eq(puzzlesTable.id, id))
      .returning();
    if (res.length === 0) {
      return c.notFound();
    }
    return c.json({ puzzle: res[0] });
  });
