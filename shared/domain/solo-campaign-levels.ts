import type {
  Cell,
  PlayerId,
  WallPosition,
  GameConfiguration,
  TimeControlConfig,
} from "./game-types";

export type SoloCampaignAIType = "flee" | "chase";

export interface SoloCampaignLevel {
  id: string;
  name: string;
  boardWidth: number;
  boardHeight: number;
  turnsToSurvive: number;
  mouseCanMove: boolean;
  initialWalls: WallPosition[];
  initialPawns: {
    p1Cat: Cell;
    p2Mouse: Cell;
  };
  /** Which player the user controls (1 = cat player, 2 = mouse player) */
  userPlaysAs: PlayerId;
  /** AI behavior: 'flee' moves away from opponent, 'chase' moves toward opponent */
  aiType: SoloCampaignAIType;
  /** Rich text for info panel. Use **text** for bold, {red} and {blue} for colors. */
  infoText: string;
}

/** Default time control for solo campaign (not used for timing, just required by config) */
const SOLO_TIME_CONTROL: TimeControlConfig = {
  initialSeconds: 600,
  incrementSeconds: 0,
  preset: "rapid",
};

/**
 * Generate walls forming a box ring around a rectangular area.
 * The box surrounds cells from (topRow, leftCol) to (bottomRow, rightCol).
 */
function generateBoxWalls(
  topRow: number,
  leftCol: number,
  bottomRow: number,
  rightCol: number,
): WallPosition[] {
  const walls: WallPosition[] = [];

  // Top edge: horizontal walls above the top row of the box
  for (let col = leftCol; col <= rightCol; col++) {
    walls.push({ cell: [topRow, col], orientation: "horizontal" });
  }

  // Bottom edge: horizontal walls below the bottom row (above row+1)
  for (let col = leftCol; col <= rightCol; col++) {
    walls.push({ cell: [bottomRow + 1, col], orientation: "horizontal" });
  }

  // Left edge: vertical walls to the left of the left column (right of col-1)
  for (let row = topRow; row <= bottomRow; row++) {
    walls.push({ cell: [row, leftCol - 1], orientation: "vertical" });
  }

  // Right edge: vertical walls to the right of the right column
  for (let row = topRow; row <= bottomRow; row++) {
    walls.push({ cell: [row, rightCol], orientation: "vertical" });
  }

  return walls;
}

export const SOLO_CAMPAIGN_LEVELS: Record<string, SoloCampaignLevel> = {
  "1": {
    id: "1",
    name: "First Steps",
    boardWidth: 6,
    boardHeight: 6,
    turnsToSurvive: 10,
    mouseCanMove: true,
    // Central 2x2 on 6x6 = cells [2,2], [2,3], [3,2], [3,3]
    initialWalls: generateBoxWalls(2, 2, 3, 3),
    initialPawns: {
      p1Cat: [0, 0], // top-left
      p2Mouse: [5, 5], // bottom-right
    },
    userPlaysAs: 1,
    aiType: "flee",
    infoText: `You are the {red}**red cat**{/red}. Your goal is to catch the {blue}**blue mouse**{/blue}. Try moving toward it. If it gets away, block it with walls.

You can make two steps at once, make one step and place one wall, or place two walls.`,
  },
  "2": {
    id: "2",
    name: "Basic Walls",
    boardWidth: 5,
    boardHeight: 3,
    turnsToSurvive: 4,
    mouseCanMove: false,
    initialWalls: [],
    initialPawns: {
      p1Cat: [1, 0], // a2 (middle row, left column)
      p2Mouse: [1, 4], // e2 (middle row, right column)
    },
    userPlaysAs: 2,
    aiType: "chase",
    infoText: `You are the {red}**red mouse**{/red}. In this level, you cannot move. Your goal is to survive 4 turns by placing walls to delay the {blue}**blue cat**{/blue}. You can place two walls per turn, but you can't completely block the cat.`,
  },
};

/** Get all level IDs in order */
export function getLevelIds(): string[] {
  return Object.keys(SOLO_CAMPAIGN_LEVELS).sort(
    (a, b) => parseInt(a) - parseInt(b),
  );
}

/** Get the next level ID after the given one, or null if at the end */
export function getNextLevelId(currentId: string): string | null {
  const ids = getLevelIds();
  const currentIndex = ids.indexOf(currentId);
  if (currentIndex === -1 || currentIndex === ids.length - 1) {
    return null;
  }
  return ids[currentIndex + 1];
}

/** Build a GameConfiguration from a level definition */
export function buildLevelConfig(level: SoloCampaignLevel): GameConfiguration {
  return {
    variant: "survival",
    timeControl: SOLO_TIME_CONTROL,
    rated: false,
    boardWidth: level.boardWidth,
    boardHeight: level.boardHeight,
    variantConfig: {
      cat: level.initialPawns.p1Cat,
      mouse: level.initialPawns.p2Mouse,
      turnsToSurvive: level.turnsToSurvive,
      mouseCanMove: level.mouseCanMove,
      walls: level.initialWalls,
    },
  };
}
