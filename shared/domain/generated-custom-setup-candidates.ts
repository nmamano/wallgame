import type {
  Cell,
  CustomSetupClassicInitialState,
  GameConfiguration,
  PlayerId,
  WallPosition,
} from "./game-types";

export interface GeneratedCustomSetupCandidate {
  id: string;
  config: GameConfiguration;
  humanPlaysAs: PlayerId;
  distances: { p1: number; p2: number };
}

const BOARD_SIZE = 6;
const WALL_COUNT = 18;
const CANDIDATE_COUNT = 32;
const TIME_CONTROL = {
  initialSeconds: 0,
  incrementSeconds: 0,
  preset: "unlimited" as const,
};

const manhattanDistance = (from: Cell, to: Cell): number =>
  Math.abs(from[0] - to[0]) + Math.abs(from[1] - to[1]);

const createRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

const randomCell = (random: () => number): Cell => [
  Math.floor(random() * BOARD_SIZE),
  Math.floor(random() * BOARD_SIZE),
];

const randomShortRace = (
  random: () => number,
): { cat: Cell; home: Cell; distance: number } => {
  while (true) {
    const cat = randomCell(random);
    const home = randomCell(random);
    const distance = manhattanDistance(cat, home);
    if (distance >= 3 && distance <= 6) {
      return { cat, home, distance };
    }
  }
};

const generateWalls = (random: () => number): WallPosition[] => {
  const walls: WallPosition[] = [];
  const keys = new Set<string>();

  while (walls.length < WALL_COUNT) {
    const orientation = random() < 0.5 ? "vertical" : "horizontal";
    const row =
      orientation === "horizontal"
        ? 1 + Math.floor(random() * (BOARD_SIZE - 1))
        : Math.floor(random() * BOARD_SIZE);
    const col =
      orientation === "vertical"
        ? Math.floor(random() * (BOARD_SIZE - 1))
        : Math.floor(random() * BOARD_SIZE);
    const key = `${row}:${col}:${orientation}`;
    if (keys.has(key)) continue;
    keys.add(key);
    walls.push({ cell: [row, col], orientation });
  }

  return walls;
};

const generateCandidate = (index: number): GeneratedCustomSetupCandidate => {
  const random = createRandom(0x51f15e + index * 7919);
  const p1 = randomShortRace(random);
  const p2 = randomShortRace(random);
  const humanPlaysAs: PlayerId = index % 2 === 0 ? 1 : 2;
  const initialState: CustomSetupClassicInitialState = {
    pawns: {
      p1: { cat: p1.cat, home: p1.home },
      p2: { cat: p2.cat, home: p2.home },
    },
    walls: generateWalls(random),
    turn: {
      playerId: humanPlaysAs,
      actionsTaken: [],
    },
  };

  return {
    id: `synthetic-6x6-${String(index + 1).padStart(2, "0")}`,
    humanPlaysAs,
    distances: { p1: p1.distance, p2: p2.distance },
    config: {
      variant: "custom-setup-classic",
      timeControl: TIME_CONTROL,
      rated: false,
      boardWidth: BOARD_SIZE,
      boardHeight: BOARD_SIZE,
      variantConfig: initialState,
    },
  };
};

/**
 * Deterministic, directly generated positions for human playtesting.
 *
 * These are intentionally candidates, not certified puzzles. Walls are sampled
 * without legality or reachability analysis; Nil supplies the quality filter.
 */
export const generateCustomSetupCandidates =
  (): GeneratedCustomSetupCandidate[] =>
    Array.from({ length: CANDIDATE_COUNT }, (_, index) =>
      generateCandidate(index),
    );
