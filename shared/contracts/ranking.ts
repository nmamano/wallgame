import { z } from "zod";
import { timeControlValues, variantValues } from "./games";

/**
 * A ranking request is either global or scoped to one variant and time control.
 *
 * The two are a discriminated union rather than optional fields because the
 * global rating spans time controls as well as variants, so "all variants, rapid
 * only" names nothing that is stored. Making it unrepresentable beats validating
 * it at runtime.
 *
 * `.strict()` on both branches is load-bearing: zod strips unknown keys by
 * default, so `?scope=global&timeControl=rapid` would otherwise validate and
 * silently discard `timeControl`, leaving a legal parsed value produced by an
 * illegal request.
 */
const paginationShape = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(100),
  player: z.string().trim().min(1).optional(),
};

export const rankingQuerySchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("global"), ...paginationShape }).strict(),
  z
    .object({
      scope: z.literal("variant"),
      variant: z.enum(variantValues),
      timeControl: z.enum(timeControlValues),
      ...paginationShape,
    })
    .strict(),
]);

export type RankingQuery = z.infer<typeof rankingQuerySchema>;

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
  /** True until the player has played `PROVISIONAL_GAME_THRESHOLD` games. */
  provisional: boolean;
}

export interface RankingResponse {
  rows: RankingRow[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Games played before a rating stops being shown as provisional. */
export const PROVISIONAL_GAME_THRESHOLD = 10;
