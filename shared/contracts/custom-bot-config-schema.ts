/**
 * Bot Configuration Schema (V3)
 *
 * Validates bot configuration JSON files for the custom bot client.
 * V3: timeControls removed - bot games are untimed.
 */
import { z } from "zod";

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
    dogStyle: z.string(),
    catStyle: z.string(),
    mouseStyle: z.string(),
    elephantStyle: z.string(),
    homeStyle: z.string(),
  })
  .partial();

const variantsSchema = z
  .object({
    standard: variantConfigSchema.optional(),
    "animal-cycle": variantConfigSchema.optional(),
    classic: variantConfigSchema.optional(),
  })
  .strict()
  .refine(
    (variants) => Object.values(variants).some((value) => value !== undefined),
    {
      message: "at least one variant must be configured",
    },
  );

export const botConfigBaseSchema = z.object({
  botId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  officialToken: z.string().trim().min(1).optional(),
  username: z.string().trim().min(1).nullable(),
  appearance: botAppearanceSchema.optional(),
  variants: variantsSchema,
  /** Missing declarations mean an ordinary opponent. */
  placement: z.enum(["opponent", "puzzle"]).optional(),
  /**
   * This bot answers the site's own questions within its placement route.
   *
   * SEPARATE FROM `officialToken` on purpose. That token means "we made this
   * bot", which is a question about trust, and it is the right gate for the
   * badge, for list position and for who may be handed a custom-setup
   * position. Whether a bot should be the one ANSWERING is a question about
   * strength, and the two stopped agreeing the moment we wanted a deliberately
   * weak bot to still show as ours.
   *
   * A claim, not an authority: the server grants it only to a bot that also
   * passed the official token, so a community bot cannot volunteer itself to
   * supply best-move suggestions to our players.
   *
   * Absent means false, which is the right default for every bot but the two
   * that carry it.
   */
  analysis: z.boolean().optional(),
  /**
   * Where this bot sits in the list players choose from, ascending, with the
   * gentlest first. Absent sorts last.
   *
   * Explicit because the alternative orderings are all accidents. Sorting by
   * name put Superhuman Bot at the top of the ladder for months, and 57% of
   * new players took the first row and lost - measured 2026-08-07. Sorting by
   * strength would need a number we do not have for a community bot.
   *
   * UNGATED, unlike `analysis`, and the asymmetry is deliberate. Anyone may
   * set it, so a community client serving three bots can present its own
   * easy-to-hard order. What stops that from touching our ladder is the
   * official-first rule that runs before this one: a community bot can order
   * itself among other community bots and can never sort ahead of ours,
   * whatever number it sends. It is a preference within a group, not a
   * position in the list.
   */
  listOrder: z.number().int().optional(),
});

export const botConfigSchema = botConfigBaseSchema.superRefine((bot, ctx) => {
  // Every configurable variant is played on a board of the user's chosen size,
  // so each one a bot supports must advertise the sizes it recommends. The
  // upper bound of 3 comes from variantConfigSchema.
  for (const [variant, config] of Object.entries(bot.variants)) {
    if (!config) continue;
    if (config.recommended.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variants", variant, "recommended"],
        message: "recommended must include 1-3 entries for this variant",
      });
    }
  }
});
