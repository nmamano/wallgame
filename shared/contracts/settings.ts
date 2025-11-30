import { z } from "zod";
import type { TimeControlPreset, Variant } from "../domain/game-types";

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

export const updatePawnSchema = z.object({
  pawnType: z.string(),
  pawnShape: z.string(),
});

export const updateDefaultVariantSchema = z.object({
  variant: z.string(),
});

export const updateTimeControlSchema = z.object({
  timeControl: z.enum(["bullet", "blitz", "rapid", "classical"]),
});

export const updateRatedStatusSchema = z.object({
  rated: z.boolean(),
});

export const updateVariantParametersSchema = z.object({
  variant: z.string(),
  parameters: z.object({
    boardWidth: z.number(),
    boardHeight: z.number(),
  }),
});

// Response types
export interface SettingsResponse {
  displayName: string;
  capitalizedDisplayName?: string;
  boardTheme: string;
  pawnColor: string;
  pawnSettings: PawnSetting[];
  defaultVariant: Variant;
  defaultTimeControl: TimeControlPreset;
  defaultRatedStatus: boolean;
  variantSettings: VariantSetting[];
}

export interface PawnSetting {
  pawn_type: string;
  pawn_shape: string;
}

export interface VariantParameters {
  boardWidth: number;
  boardHeight: number;
}

export interface VariantSetting {
  variant: Variant;
  default_parameters: {
    boardWidth?: number;
    boardHeight?: number;
  };
}

export interface SuccessResponse {
  success: boolean;
}

export interface UpdateDisplayNameResponse {
  success: boolean;
  displayName: string;
  capitalizedDisplayName: string;
}
