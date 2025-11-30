// Pure functions for converting between game objects and standard notation

import type {
  PlayerId,
  WallOrientation,
  Cell,
  WallPosition,
  Turn,
  Move,
  Action,
} from "./game-types";

/**
 * Convert a Cell to standard notation (e.g., "e4")
 */
export function cellToStandardNotation(cell: Cell, totalRows: number): string {
  const colChar = String.fromCharCode("a".charCodeAt(0) + cell[1]);
  const rowNum = totalRows - cell[0];
  return `${colChar}${rowNum}`;
}

/**
 * Create a Cell from standard notation (e.g., "e4")
 */
export function cellFromStandardNotation(
  notation: string,
  totalRows: number,
): Cell {
  const colChar = notation.charAt(0).toLowerCase();
  const rowStr = notation.slice(1);

  const col = colChar.charCodeAt(0) - "a".charCodeAt(0);
  const rowNum = parseInt(rowStr, 10);

  // Convert 1-based bottom-up row to 0-based top-down row
  const row = totalRows - rowNum;

  return [row, col];
}

/**
 * Convert a WallPosition to standard notation (e.g., ">e4" or "^e4")
 */
export function wallToStandardNotation(
  wall: WallPosition,
  totalRows: number,
): string {
  const symbol = wall.orientation === "vertical" ? ">" : "^";
  return `${symbol}${cellToStandardNotation(wall.cell, totalRows)}`;
}

/**
 * Create a WallPosition from standard notation (e.g., ">e4" or "^e4")
 */
export function wallFromStandardNotation(
  notation: string,
  totalRows: number,
): WallPosition {
  const symbol = notation.charAt(0);
  const cellNotation = notation.slice(1);
  const cell = cellFromStandardNotation(cellNotation, totalRows);

  let orientation: WallOrientation;
  if (symbol === ">") {
    orientation = "vertical";
  } else if (symbol === "^") {
    orientation = "horizontal";
  } else {
    throw new Error(`Invalid wall notation symbol: ${symbol}`);
  }

  return { cell, orientation };
}

/**
 * Convert an Action to standard notation (e.g., "Ce4", "Md5", ">f3")
 */
export function actionToStandardNotation(
  action: Action,
  totalRows: number,
): string {
  if (action.type === "cat")
    return `C${cellToStandardNotation(action.target, totalRows)}`;
  if (action.type === "mouse")
    return `M${cellToStandardNotation(action.target, totalRows)}`;
  if (action.type === "wall") {
    const symbol = action.wallOrientation === "vertical" ? ">" : "^";
    return `${symbol}${cellToStandardNotation(action.target, totalRows)}`;
  }
  return "";
}

/**
 * Create an Action from standard notation (e.g., "Ce4", "Md5", ">f3")
 */
export function actionFromStandardNotation(
  notation: string,
  totalRows: number,
): Action {
  const firstChar = notation.charAt(0);
  if (firstChar === "C") {
    return {
      type: "cat",
      target: cellFromStandardNotation(notation.slice(1), totalRows),
    };
  } else if (firstChar === "M") {
    return {
      type: "mouse",
      target: cellFromStandardNotation(notation.slice(1), totalRows),
    };
  } else if (firstChar === ">" || firstChar === "^") {
    const orientation = firstChar === ">" ? "vertical" : "horizontal";
    return {
      type: "wall",
      target: cellFromStandardNotation(notation.slice(1), totalRows),
      wallOrientation: orientation,
    };
  }
  throw new Error(`Invalid action notation: ${notation}`);
}

/**
 * Convert a Move to standard notation (e.g., "Ce4.Md5.>f3" or "---")
 */
export function moveToStandardNotation(move: Move, totalRows: number): string {
  if (move.actions.length === 0) return "---";
  const sortedActions = [...move.actions].sort((a, b) => {
    const typeOrder = { cat: 1, mouse: 2, wall: 3 };
    const ta = typeOrder[a.type];
    const tb = typeOrder[b.type];
    if (ta !== tb) return ta - tb;
    if (a.type === "wall" && b.type === "wall") {
      if (a.wallOrientation !== b.wallOrientation) {
        return a.wallOrientation === "vertical" ? -1 : 1;
      }
      if (a.target[1] !== b.target[1]) return a.target[1] - b.target[1];
      return a.target[0] - b.target[0];
    }
    return 0;
  });
  return sortedActions
    .map((a) => actionToStandardNotation(a, totalRows))
    .join(".");
}

/**
 * Create a Move from standard notation (e.g., "Ce4.Md5.>f3" or "---")
 */
export function moveFromStandardNotation(
  notation: string,
  totalRows: number,
): Move {
  if (notation === "---") return { actions: [] };
  const actionStrs = notation.split(".");
  const actions = actionStrs.map((s) =>
    actionFromStandardNotation(s, totalRows),
  );
  return { actions };
}

/**
 * Create a WallPosition from standard notation with playerId
 */
export function playerWallFromStandardNotation(
  notation: string,
  totalRows: number,
  playerId: PlayerId,
): WallPosition {
  const wall = wallFromStandardNotation(notation, totalRows);
  return {
    ...wall,
    playerId,
  };
}

/**
 * Convert a Turn to standard notation (e.g., "Ce4.Md5 Ce6.Md7" or "Ce4.Md5")
 */
export function turnToStandardNotation(turn: Turn, totalRows: number): string {
  if (!turn.move2) return moveToStandardNotation(turn.move1, totalRows);
  return `${moveToStandardNotation(
    turn.move1,
    totalRows,
  )} ${moveToStandardNotation(turn.move2, totalRows)}`;
}

/**
 * Create a Turn from standard notation (e.g., "Ce4.Md5 Ce6.Md7" or "Ce4.Md5")
 */
export function turnFromStandardNotation(
  notation: string,
  totalRows: number,
): Turn {
  const parts = notation.trim().split(/\s+/);
  if (parts.length === 1) {
    return { move1: moveFromStandardNotation(parts[0], totalRows) };
  }
  if (parts.length !== 2) throw new Error(`Invalid turn notation: ${notation}`);
  return {
    move1: moveFromStandardNotation(parts[0], totalRows),
    move2: moveFromStandardNotation(parts[1], totalRows),
  };
}
