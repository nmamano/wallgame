import { z } from "zod";
import { timeControlValues, variantValues } from "./games";

export const rankingQuerySchema = z.object({
  variant: z.enum(variantValues),
  timeControl: z.enum(timeControlValues),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(100),
  player: z.string().trim().min(1).optional(),
});

export interface RankingRow {
  rank: number;
  displayName: string;
  displayLabel: string;
  rating: number;
  peakRating: number;
  recordWins: number;
  recordLosses: number;
  createdAt: number;
  lastGameAt: number;
}

export interface RankingResponse {
  rows: RankingRow[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}
