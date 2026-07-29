import { z } from "zod";

/**
 * Solo-campaign progress contracts.
 *
 * Both directions are schemas rather than bare interfaces so the boundary is
 * actually checked: the client parses what it gets back instead of asserting
 * a shape onto it. The route still validates the level id against the known
 * level set — that check is authoritative, this one only bounds what may be
 * sent.
 */

/** Body of the client-asserted completion write. */
export const completeLevelSchema = z
  .object({
    levelId: z.string().min(1).max(32),
  })
  .strict();

/**
 * Levels the caller has completed. Sorted and distinct, so the response is
 * deterministic for caching and assertions even though it is currently read
 * from two tables (see `server/games/campaign-progress.ts`).
 */
export const campaignProgressResponseSchema = z.object({
  completedLevels: z.array(z.string().min(1)),
});

export const completeLevelResponseSchema = z.object({
  success: z.boolean(),
});

export type CompleteLevelRequest = z.infer<typeof completeLevelSchema>;
export type CampaignProgressResponse = z.infer<
  typeof campaignProgressResponseSchema
>;
export type CompleteLevelResponse = z.infer<typeof completeLevelResponseSchema>;
