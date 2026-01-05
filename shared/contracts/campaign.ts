import { z } from "zod";

// Request schemas
export const completeLevelSchema = z.object({
  levelId: z.string().max(32),
});

// Response types
export interface CampaignProgressResponse {
  completedLevels: string[];
}

export interface CompleteLevelResponse {
  success: boolean;
}
