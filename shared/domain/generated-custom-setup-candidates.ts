import { Grid } from "./grid";
import type {
  Cell,
  CustomSetupStandardInitialState,
  GameConfiguration,
  PlayerId,
  WallPosition,
} from "./game-types";

/**
 * Every generated candidate is a custom-setup-standard position - the generator
 * places both pawn pairs and all of the walls itself, and can emit nothing
 * else. Saying that in the type, instead of the full GameConfiguration union,
 * is what lets a reader reach `config.variantConfig.turn` without first proving
 * which variant it got.
 */
export interface GeneratedCandidateConfig extends GameConfiguration {
  variant: "custom-setup-standard";
  variantConfig: CustomSetupStandardInitialState;
}

export interface GeneratedCustomSetupCandidate {
  id: string;
  /** Player-facing name. Ids like synthetic-6x6-01 must not reach the UI. */
  displayName: string;
  config: GeneratedCandidateConfig;
  humanPlaysAs: PlayerId;
  /**
   * ATTACK races, through the walls: p1 is p1.cat -> p2.mouse, p2 is
   * p2.cat -> p1.mouse (in standard the goal is the opponent's mouse).
   */
  distances: { p1: number; p2: number };
}

const BOARD_SIZE = 6;
const WALL_COUNT = 18;
const CANDIDATE_COUNT = 48;
const MIN_RACE = 3;
const MAX_RACE = 6;
/** Bounded sampling: fail loud rather than spin forever on a hostile wall set. */
const MAX_PAWN_SAMPLING_ATTEMPTS = 100_000;
const TIME_CONTROL = {
  initialSeconds: 0,
  incrementSeconds: 0,
  preset: "unlimited" as const,
};

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

const sameCell = (a: Cell, b: Cell): boolean => a[0] === b[0] && a[1] === b[1];

/**
 * Walls first, pawns second - the order matters.
 *
 * Walls are still sampled blind, with no quality judgement, but they are laid down
 * BEFORE the races are chosen so that the races can be measured against them.
 */
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

/**
 * Picks all four pawn cells so that BOTH attack races are short, measuring each
 * race as the ACTUAL path length through the walls rather than as a straight-line
 * count.
 *
 * The races that matter are the ATTACK races: in standard the goal is the
 * OPPONENT's mouse (game-state.ts goalCell), so the game's difficulty is set by
 * p1.cat -> p2.mouse and p2.cat -> p1.mouse. An earlier version constrained each
 * cat against its OWN mouse — the defense geometry — which left the actual races
 * unconstrained (measured 1 to 14 moves across the old batch) and did not even
 * guarantee the goals were reachable. Same wrong mental model as the old banner
 * copy ("reach your mouse"); the copy was fixed first, this catches the code up.
 *
 * `Grid.distance` returns -1 when there is no path, so requiring both attack
 * distances in [MIN_RACE, MAX_RACE] also guarantees reachability by construction.
 * An even earlier version used Manhattan distance with walls placed afterwards,
 * which produced sealed-off pawns and one engine hang (game 7y7LrnoN).
 *
 * This is not quality gating - it makes no judgement about whether a position is
 * a GOOD puzzle. It only guarantees the position is a playable short race.
 */
const randomCrossPairedPawns = (
  random: () => number,
  grid: Grid,
): {
  p1: { cat: Cell; mouse: Cell };
  p2: { cat: Cell; mouse: Cell };
  attackDistances: { p1: number; p2: number };
} => {
  for (let attempt = 0; attempt < MAX_PAWN_SAMPLING_ATTEMPTS; attempt++) {
    const cells = [
      randomCell(random),
      randomCell(random),
      randomCell(random),
      randomCell(random),
    ];
    const distinct = cells.every(
      (cell, i) => !cells.some((other, j) => j < i && sameCell(cell, other)),
    );
    if (!distinct) continue;

    const [p1Cat, p1Mouse, p2Cat, p2Mouse] = cells;
    const p1Attack = grid.distance(p1Cat, p2Mouse);
    if (p1Attack < MIN_RACE || p1Attack > MAX_RACE) continue;
    const p2Attack = grid.distance(p2Cat, p1Mouse);
    if (p2Attack < MIN_RACE || p2Attack > MAX_RACE) continue;

    return {
      p1: { cat: p1Cat, mouse: p1Mouse },
      p2: { cat: p2Cat, mouse: p2Mouse },
      attackDistances: { p1: p1Attack, p2: p2Attack },
    };
  }
  throw new Error(
    `Could not place pawns with both attack races in [${MIN_RACE},${MAX_RACE}] ` +
      `after ${MAX_PAWN_SAMPLING_ATTEMPTS} attempts`,
  );
};

const generateCandidate = (index: number): GeneratedCustomSetupCandidate => {
  const random = createRandom(0x51f15e + index * 7919);

  const walls = generateWalls(random);
  const grid = new Grid(BOARD_SIZE, BOARD_SIZE, "standard");
  for (const wall of walls) {
    grid.addWall(wall);
  }

  const pawns = randomCrossPairedPawns(random, grid);

  const humanPlaysAs: PlayerId = index % 2 === 0 ? 1 : 2;
  const initialState: CustomSetupStandardInitialState = {
    pawns: {
      p1: pawns.p1,
      p2: pawns.p2,
    },
    walls,
    turn: {
      playerId: humanPlaysAs,
      actionsTaken: [],
    },
  };

  return {
    id: `synthetic-6x6-${String(index + 1).padStart(2, "0")}`,
    displayName: `Synthetic Puzzle ${index + 1}`,
    humanPlaysAs,
    distances: pawns.attackDistances,
    config: {
      variant: "custom-setup-standard",
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
 * STANDARD, not classic, and that is the whole point. The transformer has only ever seen
 * classic with the goals in the board corners, so a classic position with a home dropped
 * anywhere is outside everything it was trained on - which is why its play there looked
 * arbitrary. In standard the target is the opponent's own mouse, which moves, so the
 * network has seen targets all over the board and a generated position sits inside its
 * training distribution. Standard also gives mouse moves, which make richer puzzles.
 *
 * These remain candidates, not certified puzzles: walls are sampled blind and no
 * judgement is made about whether a position is interesting. Nil supplies that filter.
 */
export const generateCustomSetupCandidates =
  (): GeneratedCustomSetupCandidate[] =>
    Array.from({ length: CANDIDATE_COUNT }, (_, index) =>
      generateCandidate(index),
    );

/**
 * Position fingerprint: pawns plus the wall set, order-independent.
 * Exported so engine-filter verdicts can be tied to the exact position they
 * were computed for (a candidate id alone is not stable across generator
 * edits — the fingerprint is).
 */
export const positionKey = (state: {
  pawns: {
    p1: { cat: Cell; mouse: Cell };
    p2: { cat: Cell; mouse: Cell };
  };
  walls: WallPosition[];
}): string => {
  const { p1, p2 } = state.pawns;
  const pawns = [p1.cat, p1.mouse, p2.cat, p2.mouse]
    .map((c) => `${c[0]},${c[1]}`)
    .join("|");
  const walls = state.walls
    .map((w) => `${w.cell[0]},${w.cell[1]},${w.orientation}`)
    .sort()
    .join("|");
  return `${pawns}#${walls}`;
};
