import type {
  TimeControlPreset,
  Cell,
  WallPosition,
  TimeControlConfig,
  Pawn,
  GameResult,
} from "./game-types";

/**
 * A game only becomes a real game once both players have had a turn.
 *
 * Below this many completed moves, ending the game by resignation, timeout or
 * draw agreement is an abort rather than a result: there is no winner, ratings
 * and win/loss records are untouched, the match score is unchanged, and the
 * game is not written to past games.
 *
 * Every consumer must derive its threshold from this constant. The number used
 * to be written down only in the persistence layer, which is how a rated game
 * once moved both players' ratings while leaving no trace in the games table.
 */
export const MIN_MOVES_FOR_A_COUNTED_GAME = 2;

/** Whether a game ended before both players had a turn. */
export function endedBeforeBothPlayersMoved(moveCount: number): boolean {
  return moveCount < MIN_MOVES_FOR_A_COUNTED_GAME;
}

/**
 * Whether a finished game's result should affect ratings, win/loss records,
 * the match score and past games. False for aborted games.
 */
export function isCountedResult(
  result: GameResult | null | undefined,
): result is GameResult {
  return result != null && result.reason !== "aborted";
}

export function cellEq(a: Cell, b: Cell): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function sameWallPosition(a: WallPosition, b: WallPosition): boolean {
  return (
    a.cell[0] === b.cell[0] &&
    a.cell[1] === b.cell[1] &&
    a.orientation === b.orientation
  );
}

export function timeControlConfigFromPreset(
  preset: TimeControlPreset,
): TimeControlConfig {
  switch (preset) {
    case "bullet":
      return { initialSeconds: 60, incrementSeconds: 0, preset: "bullet" };
    case "blitz":
      return { initialSeconds: 180, incrementSeconds: 2, preset: "blitz" };
    case "rapid":
      return { initialSeconds: 600, incrementSeconds: 2, preset: "rapid" };
    case "classical":
      return {
        initialSeconds: 1800,
        incrementSeconds: 0,
        preset: "classical",
      };
    case "unlimited":
      return {
        initialSeconds: 0,
        incrementSeconds: 0,
        preset: "unlimited",
      };
  }
}

/**
 * V3: Bot games are untimed. This constant provides the time control config
 * for games where time control is not applicable (bot games, puzzles, etc.).
 * The "unlimited" preset signals to the UI that timers should be hidden.
 */
export const BOT_GAME_TIME_CONTROL: TimeControlConfig = {
  initialSeconds: 0,
  incrementSeconds: 0,
  preset: "unlimited",
};

/**
 * Check if a time control config represents unlimited time (no time control).
 */
export function isUnlimitedTimeControl(
  timeControl: TimeControlConfig,
): boolean {
  return timeControl.preset === "unlimited";
}

export function formatTimeControl(timeControl: TimeControlConfig): string {
  if (timeControl.preset === "unlimited") {
    return "Unlimited";
  }
  return `${timeControl.initialSeconds}+${timeControl.incrementSeconds}`;
}

export function pawnId(pawn: Pawn): string {
  return `p${pawn.playerId}-${pawn.type}`;
}
