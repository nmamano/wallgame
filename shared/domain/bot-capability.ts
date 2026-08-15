/**
 * Whether a bot can play a given position.
 *
 * One rule, two callers that must never disagree. The client asks it to decide
 * what a puzzle card offers — bot play, the authored line, or nothing — and the
 * server asks it again at launch, because the two questions are separated by
 * however long the player spent looking at the list. A bot that was advertised
 * when the page loaded can be gone by the time they click.
 *
 * It reads the bot's OWN declaration (the variants block it registered with),
 * so nothing here knows what any particular engine supports; a bot that stops
 * declaring a variant simply stops matching.
 */

import { rulesVariantFor, type RulesVariant, type Variant } from "./game-types";
import type { VariantConfig } from "../contracts/custom-bot-protocol";

const ACTIVE_RULES_VARIANTS: readonly RulesVariant[] = [
  "classic",
  "standard",
  "animal-cycle",
];

/** Accept old setup-shaped keys once, at bot registration. */
export const normalizeBotVariantCapabilities = (
  variants: Partial<Record<Variant, VariantConfig | undefined>>,
): Partial<Record<RulesVariant, VariantConfig>> => {
  const normalized: Partial<Record<RulesVariant, VariantConfig>> = {};

  for (const rulesVariant of ACTIVE_RULES_VARIANTS) {
    const configs = Object.entries(variants)
      .filter(
        ([variant, config]) =>
          config !== undefined &&
          rulesVariantFor(variant as Variant) === rulesVariant,
      )
      .map(([, config]) => config);
    if (configs.length === 0) continue;

    const recommended = configs
      .flatMap((config) => config.recommended)
      .filter(
        (candidate, index, all) =>
          all.findIndex(
            (value) =>
              value.boardWidth === candidate.boardWidth &&
              value.boardHeight === candidate.boardHeight,
          ) === index,
      )
      .slice(0, 3);
    normalized[rulesVariant] = {
      boardWidth: {
        min: Math.min(...configs.map((config) => config.boardWidth.min)),
        max: Math.max(...configs.map((config) => config.boardWidth.max)),
      },
      boardHeight: {
        min: Math.min(...configs.map((config) => config.boardHeight.min)),
        max: Math.max(...configs.map((config) => config.boardHeight.max)),
      },
      recommended,
    };
  }

  return normalized;
};

export const botCapabilityVariant = (
  variant: Variant,
  randomStart: boolean,
): RulesVariant => {
  void randomStart;
  return rulesVariantFor(variant);
};

/** The shape of a bot's declared support, as it travels on the wire. */
export interface DeclaredVariantSupport {
  boardWidth: { min: number; max: number };
  boardHeight: { min: number; max: number };
}

/**
 * A dimension left undefined means "do not narrow on it", which is what the
 * listing endpoint wants when a caller asks only which variants a bot serves.
 * Launch paths always pass both, because by then the position is known.
 */
export const botSupportsPosition = (
  variants: Partial<Record<Variant, DeclaredVariantSupport | undefined>>,
  variant: Variant,
  boardWidth?: number,
  boardHeight?: number,
): boolean => {
  const declared = variants[rulesVariantFor(variant)];
  if (!declared) return false;
  const withinRange = (
    value: number | undefined,
    range: { min: number; max: number },
  ) => value === undefined || (value >= range.min && value <= range.max);
  return (
    withinRange(boardWidth, declared.boardWidth) &&
    withinRange(boardHeight, declared.boardHeight)
  );
};

export const botSupportsGameConfiguration = (
  variants: Partial<Record<Variant, DeclaredVariantSupport | undefined>>,
  config: {
    variant: Variant;
    randomStart: boolean;
    boardWidth?: number;
    boardHeight?: number;
  },
): boolean =>
  botSupportsPosition(
    variants,
    botCapabilityVariant(config.variant, config.randomStart),
    config.boardWidth,
    config.boardHeight,
  );
