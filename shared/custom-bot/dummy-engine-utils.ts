import type { Cell, PlayerId, SerializedGameState } from "../domain/game-types";
import { Grid } from "../domain/grid";
import { moveFromStandardNotation } from "../domain/standard-notation";

export function reconstructGrid(state: SerializedGameState): Grid {
  const grid = new Grid(
    state.config.boardWidth,
    state.config.boardHeight,
    state.config.variant,
  );

  for (const wall of state.walls) {
    grid.addWall(wall);
  }

  return grid;
}

export function getCatGoal(
  state: SerializedGameState,
  myPlayerId: PlayerId,
): Cell {
  const opponentId: PlayerId = myPlayerId === 1 ? 2 : 1;
  return state.pawns[opponentId].mouse;
}

/**
 * Apply a move (in standard notation) to the grid and pawn positions.
 * This mutates the grid and pawns in place.
 *
 * @param grid - 2D boolean array where true = wall present
 * @param moveNotation - Move in standard notation (e.g., "Ce4.Md5.>f3" or "---")
 * @param boardHeight - Total rows for notation conversion
 * @param pawns - The moving player's pawn positions (mutated in place)
 * @returns Object with success flag and optional error message
 */
export function applyMoveToGrid(
  grid: boolean[][],
  moveNotation: string,
  boardHeight: number,
  pawns: { cat: Cell; mouse: Cell },
): { success: boolean; error?: string } {
  try {
    // Parse the move from standard notation
    const move = moveFromStandardNotation(moveNotation, boardHeight);

    // Apply each action
    for (const action of move.actions) {
      if (action.type === "cat") {
        pawns.cat = action.target;
      } else if (action.type === "mouse") {
        pawns.mouse = action.target;
      } else if (action.type === "wall") {
        const [row, col] = action.target;
        // Check bounds
        if (row < 0 || row >= grid.length || col < 0 || col >= grid[0].length) {
          return { success: false, error: `Wall position out of bounds: ${row},${col}` };
        }
        grid[row][col] = true;
      }
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
