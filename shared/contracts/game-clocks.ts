import { z } from "zod";

/** Seconds left for player 1 and player 2, in that order. */
export const clockPairSchema = z.tuple([z.number(), z.number()]);

/**
 * game_details.clocks: each side's clock after every move, and when the game
 * ended. `final` is not the last `afterMove` entry: the side on turn keeps
 * losing time until the end (a timeout ends at 0), and time given after the
 * last move counts too.
 */
export const storedGameClocksSchema = z
  .object({
    afterMove: z.array(clockPairSchema),
    final: clockPairSchema,
  })
  .strict();
export type StoredGameClocks = z.infer<typeof storedGameClocksSchema>;
