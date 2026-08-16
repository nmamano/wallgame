import { z } from "zod";
import type { TimeControlPreset, Variant } from "../domain/game-types";
import {
  BOARD_SIDE_MAX,
  BOARD_SIDE_MIN,
  minimumBoardSideFor,
  variantValues,
} from "./games";

// Request schemas
export const updateDisplayNameSchema = z.object({
  displayName: z.string().min(3),
});

export const updateBoardThemeSchema = z.object({
  boardTheme: z.string(),
});

export const updatePawnColorSchema = z.object({
  pawnColor: z.string(),
});

export const pawnSkinTypeValues = [
  "dog",
  "cat",
  "mouse",
  "elephant",
  "home",
] as const;
export type PawnSkinType = (typeof pawnSkinTypeValues)[number];

export const updatePawnSchema = z.object({
  pawnType: z.enum(pawnSkinTypeValues),
  pawnShape: z.string(),
});

export const updateDefaultVariantSchema = z.object({
  variant: z.enum(variantValues),
});

export const updateTimeControlSchema = z.object({
  timeControl: z.enum(["bullet", "blitz", "rapid", "classical"]),
});

export const updateRatedStatusSchema = z.object({
  rated: z.boolean(),
});

/**
 * The INPUT of the settings write path, bounded to what a game can actually be
 * created with (board c8e27470).
 *
 * It was `z.number()` with no bounds, so an account could store a board size
 * that game creation refuses, and picking that variant then failed with a 400.
 * The bound belongs here and NOT on anything that parses stored rows: an
 * account already holding an out-of-range value must still load, and be
 * brought inside the rules by `clampBoardSizeForVariant` on the way in.
 */
export const updateVariantParametersSchema = z
  .object({
    variant: z.enum(variantValues),
    parameters: z.object({
      boardWidth: z.number().int().min(BOARD_SIDE_MIN).max(BOARD_SIDE_MAX),
      boardHeight: z.number().int().min(BOARD_SIDE_MIN).max(BOARD_SIDE_MAX),
      randomStart: z.boolean(),
    }),
  })
  .superRefine((value, ctx) => {
    const min = minimumBoardSideFor({
      variant: value.variant,
      randomStart: value.parameters.randomStart,
    });
    if (
      Math.min(value.parameters.boardWidth, value.parameters.boardHeight) < min
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parameters", "randomStart"],
        message:
          "Animal Cycle Random Start requires both board dimensions to be at least 4.",
      });
    }
  });

// Response types
export interface SettingsResponse {
  displayName: string;
  capitalizedDisplayName?: string;
  /**
   * False while the account still carries the name generated at sign-up. The
   * app asks such a player to choose one before they continue. Required, so a
   * caller cannot silently read a missing field as "already chosen".
   */
  hasChosenDisplayName: boolean;
  boardTheme: string;
  pawnColor: string;
  pawnSettings: PawnSetting[];
  defaultVariant: Variant;
  defaultTimeControl: TimeControlPreset;
  defaultRatedStatus: boolean;
  variantSettings: VariantSetting[];
}

export interface PawnSetting {
  pawn_type: PawnSkinType;
  pawn_shape: string;
}

export interface VariantParameters {
  boardWidth: number;
  boardHeight: number;
  randomStart: boolean;
}

export interface VariantSetting {
  variant: Variant;
  default_parameters: {
    boardWidth?: number;
    boardHeight?: number;
    randomStart?: boolean;
  };
}

export interface SuccessResponse {
  success: boolean;
}

export interface UpdateDisplayNameResponse {
  success: boolean;
  displayName: string;
  capitalizedDisplayName: string;
  /**
   * Always true on success - naming yourself IS choosing. Echoed rather than
   * assumed by the client so the cache records a fact the server stated, and so
   * the blocking picker closes on this response instead of waiting for a
   * refetch that could be slow or fail.
   */
  hasChosenDisplayName: boolean;
}
