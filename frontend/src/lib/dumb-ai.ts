// Frontend-specific game functionality

import { Grid } from "../../../shared/grid";
import type { Cell, Move } from "../../../shared/game-types";

export function getAiMove(
  grid: Grid,
  aiCatPos: Cell,
  opponentMousePos: Cell
): Promise<Move> {
  return Promise.resolve(DoubleWalkMove(grid, aiCatPos, opponentMousePos));
}

// Simple AI that walks towards the goal. It does not build any walls.
function DoubleWalkMove(grid: Grid, aiPos: Cell, aiGoal: Cell): Move {
  const curDist = grid.distance(aiPos, aiGoal);
  const dist2offsets = [
    [0, 2],
    [1, 1],
    [2, 0],
    [1, -1],
    [0, -2],
    [-1, -1],
    [-2, 0],
    [-1, 1],
  ];
  for (let k = 0; k < 8; k++) {
    const [or, oc] = [dist2offsets[k][0], dist2offsets[k][1]];
    const candidatePos: Cell = [aiPos[0] + or, aiPos[1] + oc];
    if (
      grid.inBounds(candidatePos) &&
      grid.distance(aiPos, candidatePos) === 2 &&
      grid.distance(candidatePos, aiGoal) === curDist - 2
    ) {
      return { actions: [{ type: "cat", target: candidatePos }] };
    }
  }
  // If there is no cell at distance 2 which is 2 steps closer to the goal,
  // it means that the AI is at distance 1 from its goal. In this case, we simply
  // move to the goal.
  return { actions: [{ type: "cat", target: aiGoal }] };
}
