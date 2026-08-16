import { z } from "zod";
import type { TimeControlPreset, Variant } from "../domain/game-types";
import { variantValues } from "./games";

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

export const updateVariantParametersSchema = z.object({
  variant: z.enum(variantValues),
  parameters: z.object({
    boardWidth: z.number(),
    boardHeight: z.number(),
    randomStart: z.boolean(),
  }),
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
