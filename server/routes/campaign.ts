import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import { getUserMiddleware, getOptionalUserMiddleware } from "../kinde";
import { getUserIdFromKinde } from "../db/user-helpers";
import {
  readCampaignProgress,
  recordCampaignCompletion,
} from "../games/campaign-progress";
import {
  completeLevelSchema,
  type CampaignProgressResponse,
  type CompleteLevelResponse,
} from "../../shared/contracts/campaign";
import { SOLO_CAMPAIGN_LEVELS } from "../../shared/domain/solo-campaign-levels";
import {
  createAnonymousWriteLimiter,
  clientIpKey,
} from "./anonymous-write-limiter";

/**
 * Solo-campaign progress (S-CAMP).
 *
 * The rule and the SQL live in `server/games/campaign-progress.ts`; this file
 * is authentication plus delegation. Completion is client-asserted — the
 * campaign runs entirely in the browser, so there is no server-side game to
 * verify — and the level id is validated against the known set, so the open
 * path cannot write arbitrary rows.
 */

/**
 * Anonymous completions are telemetry, so the cap is generous enough never to
 * trouble a real player (the campaign is a handful of levels) while bounding
 * abuse of an open write. Its own instance, so campaign traffic and puzzle
 * traffic cannot exhaust each other's budget.
 */
const anonymousCompletionLimiter = createAnonymousWriteLimiter({
  limit: 30,
  windowMs: 60 * 60 * 1000,
  maxKeys: 10_000,
});

export const campaignRoute = new Hono()
  /**
   * Which levels the logged-in caller has completed.
   *
   * Anonymous callers get 401 rather than empty arrays, so "no identity" is
   * never confused with "authenticated, nothing completed".
   */
  .get("/progress", getUserMiddleware, async (c) => {
    try {
      const userId = await getUserIdFromKinde(c);
      const response: CampaignProgressResponse =
        await readCampaignProgress(userId);
      return c.json(response);
    } catch (error) {
      console.error("[campaign] failed to read progress", { error });
      return c.json({ error: "Failed to fetch campaign progress" }, 500);
    }
  })

  /**
   * Record a level completion.
   *
   * Anonymous writes are accepted because Nil wants usage data, and are rate
   * limited per client IP. They are best-effort telemetry, not unique-user
   * statistics. Authenticated writes are idempotent (one row per user and
   * level) and do not share the anonymous cap.
   */
  .post(
    "/complete",
    getOptionalUserMiddleware,
    zValidator("json", completeLevelSchema),
    async (c) => {
      const { levelId } = c.req.valid("json");
      if (!SOLO_CAMPAIGN_LEVELS[levelId]) {
        return c.json({ error: "Invalid level ID" }, 400);
      }

      const user = c.get("user");
      try {
        if (!user) {
          const key = clientIpKey(c.req.raw.headers);
          if (!anonymousCompletionLimiter.tryConsume(key)) {
            return c.json({ error: "Too many requests" }, 429);
          }
          await recordCampaignCompletion({ userId: null, levelId });
          const response: CompleteLevelResponse = { success: true };
          return c.json(response);
        }

        const userId = await getUserIdFromKinde(c);
        await recordCampaignCompletion({ userId, levelId });
        const response: CompleteLevelResponse = { success: true };
        return c.json(response);
      } catch (error) {
        console.error("[campaign] failed to record completion", {
          error,
          levelId,
        });
        return c.json({ error: "Failed to save progress" }, 500);
      }
    },
  );
