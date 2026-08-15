import type { ClassicInitialState } from "./game-types";
import { generateFreestyleInitialState } from "./freestyle-setup";

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

/**
 * Generate Classic from the exact Standard Random Start distribution.
 *
 * Standard cats chase the opposing player's mouse. Classic uses those same
 * opposing mouse cells as fixed homes, so only the goal representation changes:
 * P1 home is P2 mouse, and P2 home is P1 mouse.
 */
export const generateClassicRandomInitialState = (
  boardWidth: number,
  boardHeight: number,
  rng: () => number = Math.random,
): ClassicInitialState => {
  const standard = generateFreestyleInitialState(boardWidth, boardHeight, rng);

  return {
    pawns: {
      p1: { cat: standard.pawns.p1.cat, home: standard.pawns.p2.mouse },
      p2: { cat: standard.pawns.p2.cat, home: standard.pawns.p1.mouse },
    },
    walls: standard.walls,
  };
};
