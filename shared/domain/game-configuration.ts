import {
  generateAnimalCycleRandomInitialState,
  buildAnimalCycleInitialState,
} from "./animal-cycle-setup";
import { buildClassicInitialState } from "./classic-setup";
import { generateFreestyleInitialState } from "./freestyle-setup";
import type {
  GameConfiguration,
  GameInitialState,
  Variant,
} from "./game-types";
import { buildStandardInitialState } from "./standard-setup";

export const normalizeLegacyVariant = (
  variant: Variant,
  randomStart: boolean | undefined,
): { variant: Variant; randomStart: boolean } =>
  variant === "freestyle"
    ? { variant: "standard", randomStart: true }
    : { variant, randomStart: randomStart ?? false };

export const normalizeLegacyGameConfiguration = (
  config: GameConfiguration,
): GameConfiguration => ({
  ...config,
  ...normalizeLegacyVariant(config.variant, config.randomStart),
});

export const buildOrdinaryInitialState = (
  config: Pick<
    GameConfiguration,
    "variant" | "randomStart" | "boardWidth" | "boardHeight"
  >,
): GameInitialState => {
  if (config.variant === "standard") {
    return config.randomStart
      ? generateFreestyleInitialState(config.boardWidth, config.boardHeight)
      : buildStandardInitialState(config.boardWidth, config.boardHeight);
  }
  if (config.variant === "animal-cycle") {
    return config.randomStart
      ? generateAnimalCycleRandomInitialState(
          config.boardWidth,
          config.boardHeight,
        )
      : buildAnimalCycleInitialState(config.boardWidth, config.boardHeight);
  }
  if (config.variant === "classic") {
    if (config.randomStart) {
      throw new Error("Classic Random Start is not available yet.");
    }
    return buildClassicInitialState(config.boardWidth, config.boardHeight);
  }
  throw new Error(`${config.variant} requires a variant-specific setup.`);
};
