import {
  generateAnimalCycleRandomInitialState,
  buildAnimalCycleInitialState,
} from "./animal-cycle-setup";
import {
  buildClassicInitialState,
  generateClassicRandomInitialState,
} from "./classic-setup";
import { generateStandardRandomInitialState } from "./random-start-setup";
import type { GameConfiguration, GameInitialState } from "./game-types";
import { buildStandardInitialState } from "./standard-setup";

export const buildOrdinaryInitialState = (
  config: Pick<
    GameConfiguration,
    "variant" | "randomStart" | "boardWidth" | "boardHeight"
  >,
  rng: () => number = Math.random,
): GameInitialState => {
  if (config.variant === "standard") {
    return config.randomStart
      ? generateStandardRandomInitialState(
          config.boardWidth,
          config.boardHeight,
          rng,
        )
      : buildStandardInitialState(config.boardWidth, config.boardHeight);
  }
  if (config.variant === "animal-cycle") {
    return config.randomStart
      ? generateAnimalCycleRandomInitialState(
          config.boardWidth,
          config.boardHeight,
          rng,
        )
      : buildAnimalCycleInitialState(config.boardWidth, config.boardHeight);
  }
  if (config.variant === "classic") {
    return config.randomStart
      ? generateClassicRandomInitialState(
          config.boardWidth,
          config.boardHeight,
          rng,
        )
      : buildClassicInitialState(config.boardWidth, config.boardHeight);
  }
  throw new Error(
    `${config.variant} does not use this two-player setup builder.`,
  );
};
