import { Hono } from "hono";
import { z } from "zod";

// Mock schema/type.
const puzzleSchema = z.object({
  //Created by the db.
  id: z.number().int().positive().min(1),

  title: z.string().min(3).max(100),
  author: z.string().min(3).max(100),
  rating: z.number().int().positive().min(1).max(10000),
});
type Puzzle = z.infer<typeof puzzleSchema>;

const createPostSchema = puzzleSchema.omit({ id: true });

// Mock data before we set up a db.
const fakePuzzles: Puzzle[] = [
  { id: 1, title: "Puzzle 1", author: "Author 1", rating: 5 },
  { id: 2, title: "Puzzle 2", author: "Author 2", rating: 4 },
  { id: 3, title: "Puzzle 3", author: "Author 3", rating: 3 },
];

export const puzzlesRoute = new Hono()
  .get("/", (c) => {
    return c.json({
      puzzles: fakePuzzles,
    });
  })
  .get("/count", (c) => {
    return c.json({
      count: fakePuzzles.length,
    });
  })
  .post("/", async (c) => {
    const data = await c.req.json();
    const puzzle = createPostSchema.parse(data);
    fakePuzzles.push({ ...puzzle, id: fakePuzzles.length + 1 });
    c.status(201);
    return c.json({ puzzle: puzzle });
  })
  .get("/:id{[0-9]+}", (c) => {
    const id = Number.parseInt(c.req.param("id"));
    const puzzle = fakePuzzles.find((p) => p.id === id);
    if (!puzzle) {
      return c.notFound();
    }
    return c.json(puzzle);
  })
  .delete("/:id{[0-9]+}", (c) => {
    const id = Number.parseInt(c.req.param("id"));
    const index = fakePuzzles.findIndex((p) => p.id === id);
    if (index === -1) {
      return c.notFound();
    }
    const deletedPuzzle = fakePuzzles.splice(index, 1)[0];
    return c.json({ puzzle: deletedPuzzle });
  });
