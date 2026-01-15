import type { ClassicInitialState } from "./game-types";

/**
 * Build the default initial state for Classic variant.
 * Places cats at top corners (same as Standard) with homes at diagonally opposite corners.
 *
 * Default positions (for an 8x8 board):
 * - Player 1: cat at top-left (0, 0), home at bottom-right (7, 7)
 * - Player 2: cat at top-right (0, 7), home at bottom-left (7, 0)
 */
export const buildClassicInitialState = (
  boardWidth: number,
  boardHeight: number,
): ClassicInitialState => {
  const lastRow = boardHeight - 1;
  const lastCol = boardWidth - 1;

  return {
    pawns: {
      p1: {
        cat: [0, 0],
        home: [lastRow, lastCol],
      },
      p2: {
        cat: [0, lastCol],
        home: [lastRow, 0],
      },
    },
    walls: [],
  };
};
