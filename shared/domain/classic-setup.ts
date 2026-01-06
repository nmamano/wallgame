import type { ClassicInitialState } from "./game-types";

/**
 * Build the default initial state for Classic variant.
 * Places cats at diagonal corners with homes at opposite corners.
 *
 * Default positions (for an 8x8 board):
 * - Player 1: cat at top-left (0, 0), home at bottom-right (7, 7)
 * - Player 2: cat at bottom-right (7, 7), home at top-left (0, 0)
 */
export const buildClassicInitialState = (
  boardWidth: number,
  boardHeight: number,
): ClassicInitialState => {
  const lastRow = boardHeight - 1;
  const lastCol = boardWidth - 1;

  return {
    pawns: {
      1: {
        cat: [0, 0],
        home: [lastRow, lastCol],
      },
      2: {
        cat: [lastRow, lastCol],
        home: [0, 0],
      },
    },
    walls: [],
  };
};
