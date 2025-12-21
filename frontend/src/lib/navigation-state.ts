import { z } from "zod";

const pastGamesFiltersSchema = z.object({
  variant: z.enum(["all", "standard", "classic"]).optional(),
  rated: z.enum(["all", "yes", "no"]).optional(),
  timeControl: z
    .enum(["all", "bullet", "blitz", "rapid", "classical"])
    .optional(),
  boardSize: z.enum(["all", "small", "medium", "large"]).optional(),
  player1: z.string().optional(),
  player2: z.string().optional(),
  eloMin: z.string().optional(),
  eloMax: z.string().optional(),
});

const pastGamesNavStateSchema = z
  .object({
    pastGamesFilters: pastGamesFiltersSchema.optional(),
  })
  .passthrough();

export type PastGamesFiltersState = z.infer<typeof pastGamesFiltersSchema>;
export type PastGamesNavState = z.infer<typeof pastGamesNavStateSchema>;

export const parsePastGamesNavState = (
  state: unknown,
): PastGamesFiltersState | undefined => {
  const parsed = pastGamesNavStateSchema.safeParse(state);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.pastGamesFilters;
};
