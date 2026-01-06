import type { Cell, SurvivalInitialState, WallPosition } from "./game-types";
import { Grid } from "./grid";

export interface SurvivalSetupInput {
  boardWidth: number;
  boardHeight: number;
  turnsToSurvive: number;
  mouseCanMove: boolean;
  walls?: WallPosition[];
  catPosition?: Cell;
  mousePosition?: Cell;
}

/**
 * Build and validate a SurvivalInitialState.
 * Validates that walls don't block the cat from reaching the mouse.
 *
 * Default positions (for an 8x8 board):
 * - Cat at top-left (0, 0)
 * - Mouse at bottom-right (7, 7)
 */
export const buildSurvivalInitialState = (
  input: SurvivalSetupInput,
): SurvivalInitialState => {
  const { boardWidth, boardHeight, turnsToSurvive, mouseCanMove } = input;

  if (!Number.isInteger(turnsToSurvive) || turnsToSurvive < 1) {
    throw new Error("Survival turns must be a positive integer.");
  }

  const lastRow = boardHeight - 1;
  const lastCol = boardWidth - 1;

  const cat: Cell = input.catPosition ?? [0, 0];
  const mouse: Cell = input.mousePosition ?? [lastRow, lastCol];
  const inputWalls = input.walls ?? [];

  // Validate walls don't block cat from reaching mouse
  const grid = new Grid(boardWidth, boardHeight, "survival");
  const cats: [Cell, Cell] = [cat, cat];
  const mice: [Cell, Cell] = [mouse, mouse];

  for (const wall of inputWalls) {
    if (!grid.canBuildWall(cats, mice, wall)) {
      throw new Error("Invalid survival wall layout.");
    }
    grid.addWall(wall);
  }

  return {
    cat,
    mouse,
    turnsToSurvive,
    mouseCanMove,
    walls: grid.getWalls(),
  };
};

/**
 * Build a default SurvivalInitialState with standard corner positions.
 */
export const buildDefaultSurvivalInitialState = (
  boardWidth: number,
  boardHeight: number,
  turnsToSurvive: number,
  mouseCanMove: boolean,
): SurvivalInitialState => {
  return buildSurvivalInitialState({
    boardWidth,
    boardHeight,
    turnsToSurvive,
    mouseCanMove,
    walls: [],
  });
};
