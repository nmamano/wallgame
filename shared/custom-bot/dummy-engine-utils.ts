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
  return state.pawns[opponentId].mouse;
}
