/**
 * Bot Configuration Schema (V3)
 *
 * Validates bot configuration JSON files for the custom bot client.
 * V3: timeControls removed - bot games are untimed.
 */
import { z } from "zod";
import type { Variant } from "../domain/game-types";

const boardDimensionRangeSchemaBase = z.object({
  min: z.number().int().min(3).max(20),
  max: z.number().int().min(3).max(20),
});

export const boardDimensionRangeSchema =
  boardDimensionRangeSchemaBase.superRefine((range, ctx) => {
    if (range.min > range.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "min must be less than or equal to max",
      });
    }
  });

export const recommendedSettingsSchema = z.object({
  boardWidth: z.number().int().min(3).max(20),
  boardHeight: z.number().int().min(3).max(20),
});

/** V3: timeControls removed - bot games are untimed */
export const variantConfigSchema = z
  .object({
    boardWidth: boardDimensionRangeSchema,
    boardHeight: boardDimensionRangeSchema,
    recommended: z.array(recommendedSettingsSchema).max(3),
  })
  .superRefine((config, ctx) => {
    for (const [index, rec] of config.recommended.entries()) {
      if (
        rec.boardWidth < config.boardWidth.min ||
        rec.boardWidth > config.boardWidth.max
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recommended", index, "boardWidth"],
          message: "boardWidth must be within the supported range",
        });
      }
      if (
        rec.boardHeight < config.boardHeight.min ||
        rec.boardHeight > config.boardHeight.max
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recommended", index, "boardHeight"],
          message: "boardHeight must be within the supported range",
        });
      }
    }
  });

export const botAppearanceSchema = z
  .object({
    color: z.string(),
    catStyle: z.string(),
    mouseStyle: z.string(),
    homeStyle: z.string(),
  })
  .partial();

const variantsSchema = z
  .object({
    standard: variantConfigSchema.optional(),
    classic: variantConfigSchema.optional(),
    freestyle: variantConfigSchema.optional(),
  })
  .strict()
  .refine(
    (variants) => Object.values(variants).some((value) => value !== undefined),
    {
      message: "at least one variant must be configured",
    },
  );

export const botConfigSchema = z
  .object({
    botId: z.string().trim().min(1),
    name: z.string().trim().min(1),
    officialToken: z.string().trim().min(1).optional(),
    username: z.string().trim().min(1).nullable(),
    appearance: botAppearanceSchema.optional(),
    variants: variantsSchema,
  })
  .superRefine((bot, ctx) => {
    const variantsWithBoardSize = new Set<Variant>(["standard", "classic"]);
    for (const [variant, config] of Object.entries(bot.variants)) {
      if (!config) continue;
      const usesBoardSize = variantsWithBoardSize.has(variant as Variant);
      if (usesBoardSize && config.recommended.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["variants", variant, "recommended"],
          message: "recommended must include 1-3 entries for this variant",
        });
      }
      if (!usesBoardSize && config.recommended.length !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["variants", variant, "recommended"],
          message:
            "recommended must be empty for variants without board size settings",
        });
      }
    }
  });
