import type { AnimalCycleInitialState, Cell, WallPosition } from "./game-types";
import { Grid } from "./grid";

export const buildAnimalCycleInitialState = (
  boardWidth: number,
  boardHeight: number,
): AnimalCycleInitialState => ({
  pawns: {
    p1: {
      dog: [boardHeight - 1, 0],
      mouse: [0, boardWidth - 1],
    },
    p2: {
      cat: [0, 0],
      elephant: [boardHeight - 1, boardWidth - 1],
    },
  },
  walls: [],
});

const randomInt = (rng: () => number, min: number, max: number): number =>
  Math.floor(rng() * (max - min + 1)) + min;

// These bounds produce two to three wall orbits on an 8x8 board. They scale
// the wall count with board area, as the Standard Random Start generator does.
const ANIMAL_CYCLE_RANDOM_ORBIT_MIN_CELLS = 24;
const ANIMAL_CYCLE_RANDOM_ORBIT_MAX_CELLS = 32;

export interface AnimalCycleRandomSquare {
  size: number;
  top: number;
  left: number;
}

/**
 * Pick a variable square of at least four cells. Four is the hard minimum:
 * adjacent corners are then three moves apart, beyond one two-action turn.
 */
export const chooseAnimalCycleRandomSquare = (
  boardWidth: number,
  boardHeight: number,
  rng: () => number = Math.random,
): AnimalCycleRandomSquare => {
  const maximumSize = Math.min(boardWidth, boardHeight);
  if (maximumSize < 4) {
    throw new Error(
      "Animal Cycle Random Start requires both board dimensions to be at least 4.",
    );
  }
  const dimensionsHaveSameParity = boardWidth % 2 === boardHeight % 2;
  let centeredRandomSizes = Array.from(
    { length: maximumSize - 3 },
    (_, index) => index + 4,
  ).filter((size) => !dimensionsHaveSameParity || size % 2 === boardWidth % 2);
  if (boardWidth === boardHeight && centeredRandomSizes.length > 1) {
    centeredRandomSizes = centeredRandomSizes.filter(
      (size) => size < maximumSize,
    );
  }
  const validSizes =
    centeredRandomSizes.length > 0 ? centeredRandomSizes : [maximumSize];
  const size = validSizes[randomInt(rng, 0, validSizes.length - 1)];
  return {
    size,
    top: Math.floor((boardHeight - size) / 2),
    left: Math.floor((boardWidth - size) / 2),
  };
};

const wallKey = (wall: WallPosition): string =>
  `${wall.orientation}:${wall.cell[0]}:${wall.cell[1]}`;

/** Rotate one wall edge 90 degrees clockwise about the selected square. */
export const rotateAnimalCycleWall = (
  wall: WallPosition,
  square: AnimalCycleRandomSquare,
): WallPosition => {
  const localRow = wall.cell[0] - square.top;
  const localColumn = wall.cell[1] - square.left;
  return wall.orientation === "vertical"
    ? {
        cell: [
          square.top + localColumn + 1,
          square.left + square.size - 1 - localRow,
        ],
        orientation: "horizontal",
      }
    : {
        cell: [
          square.top + localColumn,
          square.left + square.size - 1 - localRow,
        ],
        orientation: "vertical",
      };
};

export const animalCycleWallOrbit = (
  wall: WallPosition,
  square: AnimalCycleRandomSquare,
): WallPosition[] => {
  const orbit = new Map<string, WallPosition>();
  let rotated = wall;
  for (let turn = 0; turn < 4; turn += 1) {
    orbit.set(wallKey(rotated), rotated);
    rotated = rotateAnimalCycleWall(rotated, square);
  }
  return [...orbit.values()];
};

const hasPathForEveryAnimal = (
  grid: Grid,
  pawns: AnimalCycleInitialState["pawns"],
): boolean =>
  grid.distance(pawns.p1.dog, pawns.p2.cat) >= 0 &&
  grid.distance(pawns.p1.mouse, pawns.p2.elephant) >= 0 &&
  grid.distance(pawns.p2.cat, pawns.p1.mouse) >= 0 &&
  grid.distance(pawns.p2.elephant, pawns.p1.dog) >= 0;

const withinTwoSteps = (grid: Grid, source: Cell, target: Cell): boolean => {
  if (
    grid
      .accessibleNeighbors(source)
      .some((cell) => cell[0] === target[0] && cell[1] === target[1])
  ) {
    return true;
  }
  return grid
    .accessibleNeighbors(source)
    .some((first) =>
      grid
        .accessibleNeighbors(first)
        .some((cell) => cell[0] === target[0] && cell[1] === target[1]),
    );
};

export const hasImmediateAnimalCycleCapture = (
  grid: Grid,
  pawns: AnimalCycleInitialState["pawns"],
): boolean =>
  withinTwoSteps(grid, pawns.p1.dog, pawns.p2.cat) ||
  withinTwoSteps(grid, pawns.p1.mouse, pawns.p2.elephant) ||
  withinTwoSteps(grid, pawns.p2.cat, pawns.p1.mouse) ||
  withinTwoSteps(grid, pawns.p2.elephant, pawns.p1.dog);

export const generateAnimalCycleRandomInitialState = (
  boardWidth: number,
  boardHeight: number,
  rng: () => number = Math.random,
): AnimalCycleInitialState => {
  const square = chooseAnimalCycleRandomSquare(boardWidth, boardHeight, rng);
  const bottom = square.top + square.size - 1;
  const right = square.left + square.size - 1;
  const pawns: AnimalCycleInitialState["pawns"] = {
    p1: { dog: [bottom, square.left], mouse: [square.top, right] },
    p2: { cat: [square.top, square.left], elephant: [bottom, right] },
  };
  const grid = new Grid(boardWidth, boardHeight, "animal-cycle");
  if (hasImmediateAnimalCycleCapture(grid, pawns)) {
    throw new Error("Animal Cycle Random Start cannot begin with a capture.");
  }

  const boardArea = boardWidth * boardHeight;
  const minimumOrbits = Math.max(
    1,
    Math.floor(boardArea / ANIMAL_CYCLE_RANDOM_ORBIT_MAX_CELLS),
  );
  const maximumOrbits = Math.max(
    minimumOrbits,
    Math.ceil(boardArea / ANIMAL_CYCLE_RANDOM_ORBIT_MIN_CELLS),
  );
  const targetOrbits = randomInt(rng, minimumOrbits, maximumOrbits);
  let acceptedOrbits = 0;
  let attempts = 0;
  while (acceptedOrbits < targetOrbits && attempts < targetOrbits * 500) {
    attempts += 1;
    const orientation = rng() < 0.5 ? "vertical" : "horizontal";
    const row =
      orientation === "vertical"
        ? randomInt(rng, 0, boardHeight - 1)
        : randomInt(rng, 1, boardHeight - 1);
    const column =
      orientation === "vertical"
        ? randomInt(rng, 0, boardWidth - 2)
        : randomInt(rng, 0, boardWidth - 1);
    const orbit = animalCycleWallOrbit(
      {
        cell: [row, column],
        orientation,
      },
      square,
    );
    const trial = grid.clone();
    let legal = true;
    for (const wall of orbit) {
      const firstPairValid = trial.canBuildWall(
        [pawns.p1.dog, pawns.p1.mouse],
        [pawns.p2.cat, pawns.p2.elephant],
        wall,
      );
      const secondPairValid = trial.canBuildWall(
        [pawns.p2.cat, pawns.p2.elephant],
        [pawns.p1.mouse, pawns.p1.dog],
        wall,
      );
      if (!firstPairValid || !secondPairValid) {
        legal = false;
        break;
      }
      trial.addWall(wall);
    }
    if (!legal || !hasPathForEveryAnimal(trial, pawns)) continue;
    for (const wall of orbit) grid.addWall(wall);
    acceptedOrbits += 1;
  }

  return { pawns, walls: grid.getWalls() };
};
