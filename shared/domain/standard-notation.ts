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
  if (action.type === "dog")
    return `D${cellToStandardNotation(action.target, totalRows)}`;
  if (action.type === "cat")
    return `C${cellToStandardNotation(action.target, totalRows)}`;
  if (action.type === "mouse")
    return `M${cellToStandardNotation(action.target, totalRows)}`;
  if (action.type === "elephant")
    return `E${cellToStandardNotation(action.target, totalRows)}`;
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
  } else if (firstChar === "D") {
    return {
      type: "dog",
      target: cellFromStandardNotation(notation.slice(1), totalRows),
    };
  } else if (firstChar === "M") {
    return {
      type: "mouse",
      target: cellFromStandardNotation(notation.slice(1), totalRows),
    };
  } else if (firstChar === "E") {
    return {
      type: "elephant",
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
 *
 * A pawn that steps TWICE in one turn is ONE term naming where it ended, not
 * one term per step: a cat walking b2->c2->d2 is "Cd2", never "Cc2.Cd2". That
 * is the official notation, and it is also the only form the engine speaks —
 * `Move::standard_notation` in deep-wallwars collapses the same way, and its
 * parser resolves each term by path-finding to that destination, so a term per
 * step can expand past the two actions a turn allows and be rejected outright
 * ("Move has too many actions for the current turn state").
 *
 * Reading the collapsed form back is safe because an action's target is a
 * destination rather than a step: `moveFromStandardNotation` yields a single
 * action two cells away, and `GameState` charges it `dist` actions, so the turn
 * still costs two. Backtracking cannot make a term a no-op — the game forbids
 * returning a pawn to where it began the turn.
 *
 * Walls never collapse; each one is its own term.
 */
export function moveToStandardNotation(move: Move, totalRows: number): string {
  if (move.actions.length === 0) return "---";

  // An action's target is absolute, so the LAST action for a pawn already names
  // its final cell; there is no need to walk the steps.
  let catTarget: Cell | undefined;
  let dogTarget: Cell | undefined;
  let mouseTarget: Cell | undefined;
  let elephantTarget: Cell | undefined;
  const walls: Action[] = [];

  for (const action of move.actions) {
    if (action.type === "dog") dogTarget = action.target;
    else if (action.type === "cat") catTarget = action.target;
    else if (action.type === "mouse") mouseTarget = action.target;
    else if (action.type === "elephant") elephantTarget = action.target;
    else if (action.type === "wall") walls.push(action);
  }

  walls.sort((a, b) => {
    if (a.wallOrientation !== b.wallOrientation) {
      return a.wallOrientation === "vertical" ? -1 : 1;
    }
    if (a.target[1] !== b.target[1]) return a.target[1] - b.target[1];
    return a.target[0] - b.target[0];
  });

  // Cat, then mouse, then walls — the order the engine also emits.
  const terms: string[] = [];
  if (dogTarget) terms.push(`D${cellToStandardNotation(dogTarget, totalRows)}`);
  if (catTarget) terms.push(`C${cellToStandardNotation(catTarget, totalRows)}`);
  if (mouseTarget) {
    terms.push(`M${cellToStandardNotation(mouseTarget, totalRows)}`);
  }
  if (elephantTarget) {
    terms.push(`E${cellToStandardNotation(elephantTarget, totalRows)}`);
  }
  for (const wall of walls) {
    terms.push(actionToStandardNotation(wall, totalRows));
  }
  return terms.join(".");
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
