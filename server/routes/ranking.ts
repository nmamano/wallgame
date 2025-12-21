import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { rankingQuerySchema } from "../../shared/contracts/ranking";
import { queryRanking } from "../db/ranking-queries";

export const rankingRoute = new Hono().get(
  "/",
  zValidator("query", rankingQuerySchema),
  async (c) => {
    try {
      const query = c.req.valid("query");
      const player = query.player
        ? query.player.trim().toLowerCase()
        : undefined;
      const response = await queryRanking({
        variant: query.variant,
        timeControl: query.timeControl,
        page: query.page,
        pageSize: query.pageSize,
        player,
      });
      return c.json(response);
    } catch (error) {
      console.error("Failed to query ranking:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  },
);
