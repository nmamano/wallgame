import type { Cell, GameInitialState, GameConfiguration } from "./game-types";
import { Grid } from "./grid";

export const buildSurvivalInitialState = (
  config: Extract<GameConfiguration, { variant: "survival" }>,
): GameInitialState => {
  if (
    !Number.isInteger(config.survival.turnsToSurvive) ||
    config.survival.turnsToSurvive < 1
  ) {
    throw new Error("Survival turns must be a positive integer.");
  }

  const rows = config.boardHeight;
  const cols = config.boardWidth;

  // Use custom positions if provided, otherwise use default corners
  const customPawns = config.survival.initialPawns;
  const pawns: GameInitialState["pawns"] = {
    1: {
      cat: customPawns?.p1Cat ?? [0, 0],
      mouse: [rows - 1, 0], // Not used in survival (only P1 cat is active)
    },
    2: {
      cat: [0, cols - 1], // Not used in survival (only P2 mouse is active)
      mouse: customPawns?.p2Mouse ?? [rows - 1, cols - 1],
    },
  };

  const grid = new Grid(cols, rows, config.variant);
  const cats: [Cell, Cell] = [pawns[1].cat, pawns[1].cat];
  const mice: [Cell, Cell] = [pawns[2].mouse, pawns[2].mouse];

  config.survival.initialWalls.forEach((wall) => {
    if (!grid.canBuildWall(cats, mice, wall)) {
      throw new Error("Invalid survival wall layout.");
    }
    grid.addWall(wall);
  });

  return {
    pawns,
    walls: grid.getWalls(),
  };
};
