import type {
  Cell,
  GameConfiguration,
  StandardInitialState,
  WallPosition,
} from "./game-types";
import { Grid } from "./grid";

export const FREESTYLE_BOARD_WIDTH = 12;
export const FREESTYLE_BOARD_HEIGHT = 10;

const LEFT_PAWN_COLUMNS = [0, 1, 2, 3];
const LEFT_WALL_COLUMNS_MAX = 5;
const WALL_COUNT_MIN = 4;
const WALL_COUNT_MAX = 10;

const randomInt = (rng: () => number, min: number, max: number): number =>
  Math.floor(rng() * (max - min + 1)) + min;

const randomChoice = <T>(rng: () => number, options: T[]): T =>
  options[Math.floor(rng() * options.length)];

const mirrorCell = (cell: Cell): Cell => [
  cell[0],
  FREESTYLE_BOARD_WIDTH - 1 - cell[1],
];

const mirrorWall = (wall: WallPosition): WallPosition => {
  if (wall.orientation === "vertical") {
    return {
      cell: [wall.cell[0], FREESTYLE_BOARD_WIDTH - 2 - wall.cell[1]],
      orientation: "vertical",
    };
  }
  return {
    cell: [wall.cell[0], FREESTYLE_BOARD_WIDTH - 1 - wall.cell[1]],
    orientation: "horizontal",
  };
};

const normalizeCatMouseOrder = (cat: Cell, mouse: Cell): [Cell, Cell] => {
  if (mouse[0] < cat[0]) {
    return [mouse, cat];
  }
  return [cat, mouse];
};

export const generateFreestyleInitialState = (
  rng: () => number = Math.random,
): StandardInitialState => {
  const catCell: Cell = [
    randomInt(rng, 0, FREESTYLE_BOARD_HEIGHT - 1),
    randomChoice(rng, LEFT_PAWN_COLUMNS),
  ];
  const mouseCell: Cell = [
    randomInt(rng, 0, FREESTYLE_BOARD_HEIGHT - 1),
    randomChoice(rng, LEFT_PAWN_COLUMNS),
  ];
  const [orderedCat, orderedMouse] = normalizeCatMouseOrder(catCell, mouseCell);

  const pawns: StandardInitialState["pawns"] = {
    p1: {
      cat: orderedCat,
      mouse: orderedMouse,
    },
    p2: {
      cat: mirrorCell(orderedCat),
      mouse: mirrorCell(orderedMouse),
    },
  };

  const grid = new Grid(
    FREESTYLE_BOARD_WIDTH,
    FREESTYLE_BOARD_HEIGHT,
    "freestyle",
  );
  const cats: [Cell, Cell] = [pawns.p1.cat, pawns.p2.cat];
  // Wall legality uses opponent mice as the path targets.
  const mice: [Cell, Cell] = [pawns.p2.mouse, pawns.p1.mouse];

  const walls: WallPosition[] = [];
  const wallCount = randomInt(rng, WALL_COUNT_MIN, WALL_COUNT_MAX);
  let attempts = 0;
  const maxAttempts = wallCount * 500;

  while (walls.length < wallCount && attempts < maxAttempts) {
    attempts += 1;
    const orientation = rng() < 0.5 ? "vertical" : "horizontal";
    const row = randomInt(rng, 0, FREESTYLE_BOARD_HEIGHT - 1);
    const col = randomInt(rng, 0, LEFT_WALL_COLUMNS_MAX);
    const candidate: WallPosition = { cell: [row, col], orientation };
    if (!grid.canBuildWall(cats, mice, candidate)) {
      continue;
    }

    const mirror = mirrorWall(candidate);
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

  if (walls.length < wallCount) {
    throw new Error("Failed to generate a legal freestyle wall layout.");
  }

  return {
    pawns,
    walls: grid.getWalls(),
  };
};

export const normalizeFreestyleConfig = (
  config: GameConfiguration,
): GameConfiguration => {
  if (config.variant !== "freestyle") {
    return config;
  }
  return {
    ...config,
    boardWidth: FREESTYLE_BOARD_WIDTH,
    boardHeight: FREESTYLE_BOARD_HEIGHT,
  };
};
