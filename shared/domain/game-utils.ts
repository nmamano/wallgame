import type {
  TimeControlPreset,
  Cell,
  WallPosition,
  TimeControlConfig,
  Pawn,
} from "./game-types";

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
  }
}

/**
 * V3: Bot games are untimed. This constant provides a placeholder time control
 * config for bot games where time control is not applicable.
 * Uses very large values to effectively mean "no time limit".
 */
export const BOT_GAME_TIME_CONTROL: TimeControlConfig = {
  initialSeconds: 86400, // 24 hours - effectively unlimited
  incrementSeconds: 0,
  // No preset - indicates this is a special untimed game
};

export function formatTimeControl(timeControl: TimeControlConfig): string {
  return `${timeControl.initialSeconds}+${timeControl.incrementSeconds}`;
}

export function pawnId(pawn: Pawn): string {
  return `p${pawn.playerId}-${pawn.type}`;
}
