import type { StandardInitialState } from "./game-types";

/**
 * Build the default initial state for Standard and Freestyle variants.
 * Places pawns at corner positions with no initial walls.
 *
 * Default positions (for an 8x8 board):
 * - Player 1: cat at top-left (0, 0), mouse at bottom-left (7, 0)
 * - Player 2: cat at top-right (0, 7), mouse at bottom-right (7, 7)
 */
export const buildStandardInitialState = (
  boardWidth: number,
  boardHeight: number,
): StandardInitialState => {
  const lastRow = boardHeight - 1;
  const lastCol = boardWidth - 1;

  return {
    pawns: {
      1: {
        cat: [0, 0],
        mouse: [lastRow, 0],
      },
      2: {
        cat: [0, lastCol],
        mouse: [lastRow, lastCol],
      },
    },
    walls: [],
  };
};
