import { z } from "zod";

// Mock schema/type.
export const puzzleSchema = z.object({
  //Created by the db.
  id: z.number().int().positive().min(1),

  title: z.string().min(3).max(100),
  author: z.string().min(3).max(100),
  rating: z.number().int().positive().min(1).max(10000),
});

export const createPostSchema = puzzleSchema.omit({ id: true });
