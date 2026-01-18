/**
 * Utilities for converting old wallwars puzzle notation to wallgame format.
 *
 * Old wallwars notation:
 * - Positions: "a1" = column a (0), row 1 (1-based from bottom)
 * - Cat move: "a1" (just the position)
 * - Vertical wall (right of cell): "a1>"
 * - Horizontal wall (below cell): "a1v"
 *
 * New wallgame notation:
 * - Cells use 0-based indexing from top-left: [row, col]
 * - Cat move action: { type: 'cat', target: [row, col] }
 * - Wall actions include orientation: { type: 'wall', target: [row, col], wallOrientation }
 */

import type { Cell, Action, Move } from "./game-types";

/**
 * Convert old wallwars position notation to a Cell.
 * Old: 1-based row numbering (a1, a2, etc.)
 * New: 0-based row from top (so a1 on any board = [0, 0], top-left)
 *
 * This places row 1 at the top of the board, matching the original wallwars.net display
 * where cats start at the top and race to homes at the bottom.
 */
export function oldPosToCell(pos: string, totalRows: number): Cell {
  void totalRows; // Not needed when row 1 = top
  const col = pos.charCodeAt(0) - "a".charCodeAt(0);
  const rowNum = parseInt(pos.slice(1), 10);
  const row = rowNum - 1; // 1-based to 0-based, row 1 = top
  return [row, col];
}

/**
 * Convert old wallwars action notation to a wallgame Action.
 *
 * Old formats:
 * - "a1" = cat move to a1
 * - "a1>" = vertical wall to the right of a1
 * - "a1v" = horizontal wall below a1 (toward higher row numbers)
 *
 * Wall orientation mapping:
 * - ">" means wall to the RIGHT of the cell → "vertical" orientation at that cell
 * - "v" means wall BELOW the cell → "horizontal" orientation at the same cell
 */
export function oldActionToAction(
  actionStr: string,
  totalRows: number,
): Action {
  const trimmed = actionStr.trim();

  // Length 2 = pure cell reference = cat move
  if (trimmed.length === 2) {
    return {
      type: "cat",
      target: oldPosToCell(trimmed, totalRows),
    };
  }

  // Length 3 = cell + wall modifier
  const cellPart = trimmed.slice(0, 2);
  const modifier = trimmed[2];

  if (modifier === ">") {
    // Vertical wall to the right of this cell
    return {
      type: "wall",
      target: oldPosToCell(cellPart, totalRows),
      wallOrientation: "vertical",
    };
  }

  if (modifier === "v" || modifier === "V") {
    // Horizontal wall below this cell (toward higher row numbers)
    // In wallgame, horizontal wall at [r, c] blocks movement between rows r-1 and r
    // So to block movement from row r to r+1, we place the wall at [r+1, c]
    const baseCell = oldPosToCell(cellPart, totalRows);
    return {
      type: "wall",
      target: [baseCell[0] + 1, baseCell[1]],
      wallOrientation: "horizontal",
    };
  }

  throw new Error(`Invalid action notation: ${trimmed}`);
}

/**
 * Parse a single move string (space-separated actions within one turn).
 * Example: "a4> a3>" → Move with 2 wall actions
 * Example: "c2" → Move with 1 cat action
 */
export function parseSingleMove(moveStr: string, totalRows: number): Move {
  const actionStrs = moveStr.trim().split(/\s+/);
  const actions = actionStrs
    .filter((s) => s.length > 0)
    .map((s) => oldActionToAction(s, totalRows));
  return { actions };
}

/**
 * Parse a full puzzle move string into the moves array.
 *
 * Format: "a4> a3>; a2> c3>; d2v c3v; ..."
 * - Semicolon separates turns
 * - Comma separates alternatives for the same turn (any alternative is correct)
 * - Space separates actions within a single move
 *
 * Returns: Move[][] where moves[turnIndex][alternativeIndex] = Move
 */
export function parsePuzzleMoves(
  moveString: string,
  totalRows: number,
): Move[][] {
  const turns = moveString.split(";");
  return turns.map((turnStr) => {
    const alternatives = turnStr.split(",");
    return alternatives.map((altStr) => parseSingleMove(altStr, totalRows));
  });
}
