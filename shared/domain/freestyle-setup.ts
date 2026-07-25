import type { Cell, StandardInitialState, WallPosition } from "./game-types";
import { Grid } from "./grid";

/**
 * Freestyle is the Standard variant with a randomized starting position.
 *
 * The position is always left-right mirrored: every pawn and every wall placed
 * in the left half of the board gets a mirror image in the right half. That
 * symmetry is what keeps the variant fair, so it must hold for every board size.
 *
 * The tuning constants below are expressed as fractions of the board so they
 * scale with it. They are calibrated to reproduce the original 12x10 numbers
 * exactly: pawns in columns 0-3, walls in columns 0-5, and 4-10 wall pairs.
 */

/** Pawns start within the leftmost third of the board (4 columns at width 12). */
const PAWN_BAND_FRACTION = 1 / 3;
/** Wall pairs per cell of board area (120 cells -> 4 and 10 pairs). */
const WALL_PAIRS_PER_CELL_MIN = 1 / 30;
const WALL_PAIRS_PER_CELL_MAX = 1 / 12;

const randomInt = (rng: () => number, min: number, max: number): number =>
  Math.floor(rng() * (max - min + 1)) + min;

/**
 * Number of leftmost columns a pawn may start in. Capped so that a pawn's
 * column is always strictly left of its own mirror, which keeps the two
 * players' pawns from colliding on narrow boards.
 */
const pawnBandWidth = (boardWidth: number): number => {
  const cap = Math.max(1, Math.ceil(boardWidth / 2) - 1);
  return Math.min(
    Math.max(1, Math.floor(boardWidth * PAWN_BAND_FRACTION)),
    cap,
  );
};

/**
 * Rightmost column a candidate wall may be placed in. A vertical wall sits on
 * the right edge of its cell, so this is the centre line of the board.
 */
const wallColumnMax = (boardWidth: number): number =>
  Math.floor((boardWidth - 1) / 2);

const mirrorCell = (cell: Cell, boardWidth: number): Cell => [
  cell[0],
  boardWidth - 1 - cell[1],
];

const mirrorWall = (wall: WallPosition, boardWidth: number): WallPosition => {
  if (wall.orientation === "vertical") {
    return {
      cell: [wall.cell[0], boardWidth - 2 - wall.cell[1]],
      orientation: "vertical",
    };
  }
  return {
    cell: [wall.cell[0], boardWidth - 1 - wall.cell[1]],
    orientation: "horizontal",
  };
};

const normalizeCatMouseOrder = (cat: Cell, mouse: Cell): [Cell, Cell] => {
  if (mouse[0] < cat[0]) {
    return [mouse, cat];
  }
  return [cat, mouse];
};

const randomPawnCell = (
  rng: () => number,
  boardWidth: number,
  boardHeight: number,
): Cell => [
  randomInt(rng, 0, boardHeight - 1),
  randomInt(rng, 0, pawnBandWidth(boardWidth) - 1),
];

export const generateFreestyleInitialState = (
  boardWidth: number,
  boardHeight: number,
  rng: () => number = Math.random,
): StandardInitialState => {
  const catCell = randomPawnCell(rng, boardWidth, boardHeight);
  // A cat sharing a cell with its own mouse looks like a bug to players, and on
  // a small board it is common enough to matter, so resample until they differ.
  // The pawn band always has at least two cells, so this always terminates.
  let mouseCell = randomPawnCell(rng, boardWidth, boardHeight);
  while (mouseCell[0] === catCell[0] && mouseCell[1] === catCell[1]) {
    mouseCell = randomPawnCell(rng, boardWidth, boardHeight);
  }
  const [orderedCat, orderedMouse] = normalizeCatMouseOrder(catCell, mouseCell);

  const pawns: StandardInitialState["pawns"] = {
    p1: {
      cat: orderedCat,
      mouse: orderedMouse,
    },
    p2: {
      cat: mirrorCell(orderedCat, boardWidth),
      mouse: mirrorCell(orderedMouse, boardWidth),
    },
  };

  const grid = new Grid(boardWidth, boardHeight, "freestyle");
  const cats: [Cell, Cell] = [pawns.p1.cat, pawns.p2.cat];
  // Wall legality uses opponent mice as the path targets.
  const mice: [Cell, Cell] = [pawns.p2.mouse, pawns.p1.mouse];

  const walls: WallPosition[] = [];
  const area = boardWidth * boardHeight;
  const maxPairs = Math.max(1, Math.round(area * WALL_PAIRS_PER_CELL_MAX));
  const minPairs = Math.min(
    maxPairs,
    Math.max(1, Math.round(area * WALL_PAIRS_PER_CELL_MIN)),
  );
  const wallCount = randomInt(rng, minPairs, maxPairs);
  const columnMax = wallColumnMax(boardWidth);
  let attempts = 0;
  const maxAttempts = wallCount * 500;

  while (walls.length < wallCount && attempts < maxAttempts) {
    attempts += 1;
    const orientation = rng() < 0.5 ? "vertical" : "horizontal";
    const row = randomInt(rng, 0, boardHeight - 1);
    const col = randomInt(rng, 0, columnMax);
    const candidate: WallPosition = { cell: [row, col], orientation };
    // canBuildWall rejects any wall that would cut a cat off from its target,
    // so every accepted wall preserves both players' paths by construction.
    if (!grid.canBuildWall(cats, mice, candidate)) {
      continue;
    }

    const mirror = mirrorWall(candidate, boardWidth);
    if (
      mirror.cell[0] === candidate.cell[0] &&
      mirror.cell[1] === candidate.cell[1] &&
      mirror.orientation === candidate.orientation
    ) {
      grid.addWall(candidate);
      walls.push(candidate);
      continue;
    }

    const gridWithCandidate = grid.clone();
    gridWithCandidate.addWall(candidate);
    if (!gridWithCandidate.canBuildWall(cats, mice, mirror)) {
      continue;
    }

    grid.addWall(candidate);
    grid.addWall(mirror);
    walls.push(candidate);
  }

  // Small boards can run out of legal placements before hitting the target.
  // Whatever we did place is still mirrored and still leaves both cats a path,
  // so a sparser board is a fine outcome — far better than failing to start.
  return {
    pawns,
    walls: grid.getWalls(),
  };
};
