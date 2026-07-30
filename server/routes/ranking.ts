import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { rankingQuerySchema } from "../../shared/contracts/ranking";
import { queryRanking } from "../db/ranking-queries";

export const rankingRoute = new Hono().get(
  "/",
  zValidator("query", rankingQuerySchema),
  async (c) => {
    try {
      // The parsed value is a union, so `variant` and `timeControl` are only
      // reachable after narrowing on `scope` - queryRanking does that narrowing
      // rather than this route unpacking fields that may not be there.
      const response = await queryRanking(c.req.valid("query"));
      return c.json(response);
    } catch (error) {
      console.error("Failed to query ranking:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  },
);
