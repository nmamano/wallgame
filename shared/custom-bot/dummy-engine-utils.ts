import type { Cell, PlayerId, SerializedGameState } from "../domain/game-types";
import { Grid } from "../domain/grid";

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
  const variant = state.config.variant;

  if (variant === "classic") {
    const cols = state.config.boardWidth;
    if (myPlayerId === 1) {
      return [0, cols - 1];
    }
    return [0, 0];
  }

  return state.pawns[opponentId].mouse;
}
