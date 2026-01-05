import { Hono } from "hono";
import { getUserMiddleware } from "../kinde";
import { db } from "../db/index";
import { campaignProgressTable } from "../db/schema/campaign-progress";
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { getUserIdFromKinde } from "../db/user-helpers";
import {
  completeLevelSchema,
  type CampaignProgressResponse,
  type CompleteLevelResponse,
} from "../../shared/contracts/campaign";
import { SOLO_CAMPAIGN_LEVELS } from "../../shared/domain/solo-campaign-levels";

export const campaignRoute = new Hono()
  /**
   * Get campaign progress for logged-in user
   * GET /api/campaign/progress
   */
  .get("/progress", getUserMiddleware, async (c) => {
    try {
      const userId = await getUserIdFromKinde(c);

      const progress = await db
        .select({ levelId: campaignProgressTable.levelId })
        .from(campaignProgressTable)
        .where(eq(campaignProgressTable.userId, userId));

      const response: CampaignProgressResponse = {
        completedLevels: progress.map((p) => p.levelId),
      };

      return c.json(response);
    } catch (error) {
      console.error("Error fetching campaign progress:", error);
      return c.json({ error: "Failed to fetch campaign progress" }, 500);
    }
  })

  /**
   * Mark a level as completed
   * POST /api/campaign/complete
   */
  .post(
    "/complete",
    getUserMiddleware,
    zValidator("json", completeLevelSchema),
    async (c) => {
      try {
        const userId = await getUserIdFromKinde(c);
        const { levelId } = c.req.valid("json");

        // Validate that the level exists
        if (!SOLO_CAMPAIGN_LEVELS[levelId]) {
          return c.json({ error: "Invalid level ID" }, 400);
        }

        // Upsert: insert or update if already exists
        await db
          .insert(campaignProgressTable)
          .values({
            userId,
            levelId,
            completedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              campaignProgressTable.userId,
              campaignProgressTable.levelId,
            ],
            set: {
              completedAt: new Date(),
            },
          });

        const response: CompleteLevelResponse = { success: true };
        return c.json(response);
      } catch (error) {
        console.error("Error marking level complete:", error);
        return c.json({ error: "Failed to save progress" }, 500);
      }
    },
  );
