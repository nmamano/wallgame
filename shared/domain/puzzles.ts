/**
 * Puzzle definitions for wallgame.
 *
 * Puzzles use the "classic" variant where both players have a cat and a home.
 * The goal is to move your cat to your home before the opponent does the same.
 *
 * These 10 puzzles were ported from the original wallwars repository.
 * Positions and walls represent the starting state of the puzzle (after any
 * historical setup moves have been baked in). Walls are neutral (no owner).
 */

import type {
  Cell,
  Move,
  WallPosition,
  GameConfiguration,
  PlayerId,
  ClassicInitialState,
  TimeControlConfig,
} from "./game-types";
import { parsePuzzleMoves } from "./puzzle-notation";

export interface Puzzle {
  id: string;
  title: string;
  author: string;
  /** Difficulty rating (higher = harder). Range: ~1350-1850 */
  difficulty: number;

  // Board configuration
  boardWidth: number;
  boardHeight: number;

  // Initial positions (Cell = [row, col], 0-indexed from top-left)
  p1Cat: Cell;
  p1Home: Cell;
  p2Cat: Cell;
  p2Home: Cell;

  // Pre-placed neutral walls (no owner, rendered as brown)
  initialWalls: WallPosition[];

  /** Which player the human controls */
  humanPlaysAs: PlayerId;

  /**
   * Move sequence for the puzzle.
   * moves[turnIndex] = array of valid alternative moves for that turn.
   * Any move in the alternatives array is considered correct.
   * The first move (index 0) is always the human's move.
   */
  moves: Move[][];
}

/**
 * Convert a puzzle's rating into the 1-5 difficulty tier players actually see.
 *
 * Note the field it reads is `Puzzle.difficulty`, which holds a RATING, not a
 * tier - the two live under one name and that is what made the puzzle page
 * print "Rating: 1350" where the listing printed "Difficulty: 1/5". Every
 * player-facing surface goes through this function so they cannot drift again.
 */
export function ratingToDifficulty(rating: number): number {
  // 1300-1400 = 1, 1400-1500 = 2, 1500-1600 = 3, 1600-1750 = 4, 1750+ = 5
  if (rating < 1400) return 1;
  if (rating < 1500) return 2;
  if (rating < 1600) return 3;
  if (rating < 1750) return 4;
  return 5;
}

/** Default time control for puzzles (not actively used, but required by config) */
const PUZZLE_TIME_CONTROL: TimeControlConfig = {
  initialSeconds: 600,
  incrementSeconds: 0,
  preset: "rapid",
};

/**
 * Build a GameConfiguration from a puzzle definition.
 * Uses the "classic" variant where cats race to their homes.
 */
export function buildPuzzleConfig(puzzle: Puzzle): GameConfiguration {
  const initialState: ClassicInitialState = {
    pawns: {
      p1: {
        cat: puzzle.p1Cat,
        home: puzzle.p1Home,
      },
      p2: {
        cat: puzzle.p2Cat,
        home: puzzle.p2Home,
      },
    },
    walls: puzzle.initialWalls,
  };

  return {
    variant: "classic",
    timeControl: PUZZLE_TIME_CONTROL,
    rated: false,
    boardWidth: puzzle.boardWidth,
    boardHeight: puzzle.boardHeight,
    variantConfig: initialState,
  };
}

// ============================================================================
// Puzzle Definitions
// ============================================================================

// Shorthand helpers for wall definitions
const v = (row: number, col: number): WallPosition => ({
  cell: [row, col],
  orientation: "vertical",
});
const h = (row: number, col: number): WallPosition => ({
  cell: [row, col],
  orientation: "horizontal",
});

/**
 * Parse a move string in old wallwars notation.
 * The height parameter is required by the parser for coordinate conversion.
 */
function parseMoves(moveString: string, boardHeight: number): Move[][] {
  return parsePuzzleMoves(moveString, boardHeight);
}

export const PUZZLES: Record<string, Puzzle> = {
  // NOTE: generated-puzzles.ts holds auto-generated candidates (ids 11+) from
  // the puzzle-generation pipeline. They are deliberately NOT spread in here:
  // playtesting found them technically correct but not human-solvable. See
  // info/puzzle-generation.md.

  // 4x4 board. Human plays as P1.
  "1": {
    id: "1",
    title: "Puzzle 1",
    author: "Nilo",
    difficulty: 1350,
    boardWidth: 4,
    boardHeight: 4,
    p1Cat: [0, 0],
    p1Home: [3, 3],
    p2Cat: [0, 3],
    p2Home: [3, 0],
    initialWalls: [
      v(1, 0),
      h(1, 3),
      v(2, 0),
      v(2, 2),
      h(2, 3),
      v(3, 0),
      h(3, 2),
      h(3, 3),
    ],
    humanPlaysAs: 1,
    moves: parseMoves("b1> b2>; c2; b2; b3; b4; b1; d4", 4),
  },

  // 3x7 board. Human plays as P2 (P2 moves first in this puzzle).
  "2": {
    id: "2",
    title: "Puzzle 2",
    author: "Nilo",
    difficulty: 1400,
    boardWidth: 7,
    boardHeight: 3,
    p1Cat: [0, 2],
    p1Home: [2, 6],
    p2Cat: [0, 4],
    p2Home: [2, 0],
    initialWalls: [
      v(0, 0),
      v(0, 5),
      v(1, 0),
      h(1, 2),
      h(1, 3),
      h(1, 4),
      v(1, 5),
      h(2, 2),
      h(2, 3),
      h(2, 4),
    ],
    humanPlaysAs: 2,
    moves: parseMoves("b1v f2v, b1> f2v; e1; f2; f2; d2; d2; b2; b2; a3", 3),
  },

  // 3x5 board. Human plays as P1.
  "3": {
    id: "3",
    title: "Puzzle 3",
    author: "Nilo",
    difficulty: 1430,
    boardWidth: 5,
    boardHeight: 3,
    p1Cat: [0, 2],
    p1Home: [2, 4],
    p2Cat: [0, 2],
    p2Home: [2, 0],
    initialWalls: [v(1, 0), v(1, 3), v(2, 0), v(2, 3)],
    humanPlaysAs: 1,
    moves: parseMoves("b1> c1v; d2; e1; b2; e3", 3),
  },

  // 4x4 board. Human plays as P1.
  "4": {
    id: "4",
    title: "Puzzle 4",
    author: "Nilo",
    difficulty: 1450,
    boardWidth: 4,
    boardHeight: 4,
    p1Cat: [1, 2],
    p1Home: [3, 3],
    p2Cat: [2, 1],
    p2Home: [3, 0],
    initialWalls: [h(2, 0), v(2, 1)],
    humanPlaysAs: 1,
    moves: parseMoves("a3> b3v; c2; c3 c2v; d3; d4", 4),
  },

  // 5x5 board. Human plays as P1.
  "5": {
    id: "5",
    title: "Puzzle 5",
    author: "Nilo",
    difficulty: 1550,
    boardWidth: 5,
    boardHeight: 5,
    p1Cat: [0, 0],
    p1Home: [4, 4],
    p2Cat: [0, 4],
    p2Home: [4, 0],
    initialWalls: [
      v(1, 0),
      v(1, 1),
      h(1, 1),
      v(1, 3),
      v(2, 0),
      v(2, 1),
      v(2, 3),
      v(3, 0),
      v(3, 3),
      h(4, 1),
      h(4, 2),
      h(4, 3),
    ],
    humanPlaysAs: 1,
    moves: parseMoves(
      "c1> e1v, c1> e2v, c1> e3v, c1> e4v; d2; c2> c3>; d4; a3; c3; a5; c1; c5; a1; e5",
      5,
    ),
  },

  // 4x5 board. Human plays as P1.
  "6": {
    id: "6",
    title: "Puzzle 6",
    author: "Nilo",
    difficulty: 1600,
    boardWidth: 5,
    boardHeight: 4,
    p1Cat: [1, 1],
    p1Home: [3, 4],
    p2Cat: [1, 3],
    p2Home: [3, 0],
    initialWalls: [
      v(1, 0),
      v(1, 1),
      v(1, 2),
      v(1, 3),
      h(2, 1),
      h(2, 3),
      v(3, 0),
      v(3, 1),
      h(3, 1),
      v(3, 2),
      v(3, 3),
      h(3, 3),
    ],
    humanPlaysAs: 1,
    moves: parseMoves(
      "b3> c1>, a3> c1>; e1; c1; e3; c3; c3; e3; c1; e4 d1v, e4 d1>, e4 e1v, e4 e2v, e4 e3v, e4 d3>, e4 c3>, e4 c3v, e4 c2v, e4 c1v, e4 a3>, e4 b3>, e4 b1v",
      4,
    ),
  },

  // 6x5 board. Human plays as P1.
  "7": {
    id: "7",
    title: "Puzzle 7",
    author: "Nilo",
    difficulty: 1650,
    boardWidth: 5,
    boardHeight: 6,
    p1Cat: [2, 1],
    p1Home: [5, 0],
    p2Cat: [2, 3],
    p2Home: [5, 4],
    initialWalls: [
      v(0, 0),
      v(1, 0),
      h(1, 0),
      h(2, 0),
      h(2, 1),
      h(2, 2),
      h(2, 3),
      v(3, 1),
      h(3, 2),
      h(3, 3),
      v(4, 1),
      h(4, 1),
      h(5, 0),
      v(5, 1),
    ],
    humanPlaysAs: 1,
    moves: parseMoves(
      "d5v e5v; e4; a4; d4 d4>, d4 d5>, d4 e4v, d4 c5>; b5; c5; a6",
      6,
    ),
  },

  // 5x5 board. Human plays as P1.
  "8": {
    id: "8",
    title: "Puzzle 8",
    author: "Nilo",
    difficulty: 1725,
    boardWidth: 5,
    boardHeight: 5,
    p1Cat: [0, 0],
    p1Home: [2, 2],
    p2Cat: [1, 1],
    p2Home: [2, 2],
    initialWalls: [h(2, 1), v(2, 2), h(2, 2), v(3, 0), v(3, 2), h(4, 1)],
    humanPlaysAs: 1,
    moves: parseMoves(
      "a2> c5>; a1; a3; a3; b3 a3>; a5; c3 a1>, c3 a1v, c3 b1>, c3 b1v, c3 c1>, c3 c1v, c3 d1>, c3 d1v, c3 e1v, c3 a2v, c3 b2>, c3 c2>, c3 d2v, c3 d2>, c3 e2v, c3 a3v, c3 b3v, c3 b3>, c3 c3v, c3 d3v, c3 d3>, c3 e3v, c3 a4v, c3 b4>, c3 d4v, c3 d4>, c3 e4v, c3 d5>",
      5,
    ),
  },

  // 3x7 board. Human plays as P1. No initial walls.
  "9": {
    id: "9",
    title: "Puzzle 9",
    author: "Nilo",
    difficulty: 1750,
    boardWidth: 7,
    boardHeight: 3,
    p1Cat: [1, 5],
    p1Home: [2, 6],
    p2Cat: [1, 1],
    p2Home: [2, 0],
    initialWalls: [],
    humanPlaysAs: 1,
    moves: parseMoves(
      "a2> b2v; f2v f2>; a2v c2v, a1v c2v, a1> c2v; e2v g2v; c2> d1v; c2 e2>; e1; d1; d2; e2; e3; d3; g3",
      3,
    ),
  },

  // 6x9 board. Human plays as P1.
  "10": {
    id: "10",
    title: "Puzzle 10",
    author: "Tim",
    difficulty: 1850,
    boardWidth: 9,
    boardHeight: 6,
    p1Cat: [1, 0],
    p1Home: [5, 8],
    p2Cat: [0, 8],
    p2Home: [5, 0],
    initialWalls: [
      v(0, 2),
      v(0, 5),
      v(1, 2),
      v(1, 5),
      v(1, 7),
      v(2, 7),
      h(3, 1),
      v(3, 2),
      h(3, 2),
      h(3, 3),
      h(3, 4),
      v(3, 5),
      h(3, 5),
      h(3, 6),
      h(3, 7),
      v(4, 2),
      v(4, 5),
      v(5, 2),
      v(5, 5),
    ],
    humanPlaysAs: 1,
    moves: parseMoves(
      "b2 a3>; h2; c3; g3; e3; e3; f3 d3>; d2; h4> h5>, h4> h6>, h5> h6>; a4> a5>; g2; c3; h1; b2; a2> b1v; c1; i2; a1; i4; a3; i6",
      6,
    ),
  },
};

/** Get all puzzle IDs in order (sorted numerically) */
export function getPuzzleIds(): string[] {
  return Object.keys(PUZZLES).sort((a, b) => parseInt(a) - parseInt(b));
}

/** Get a puzzle by ID */
export function getPuzzle(id: string): Puzzle | undefined {
  return PUZZLES[id];
}

/** Get the next puzzle ID after the given one, or null if at the end */
export function getNextPuzzleId(currentId: string): string | null {
  const ids = getPuzzleIds();
  const currentIndex = ids.indexOf(currentId);
  if (currentIndex === -1 || currentIndex === ids.length - 1) {
    return null;
  }
  return ids[currentIndex + 1];
}
