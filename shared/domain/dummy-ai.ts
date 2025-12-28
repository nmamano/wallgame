import type { Cell } from "./game-types";

/**
 * Simple AI that walks towards the goal. Does not build walls.
 * This is shared between the frontend dumb AI and the official custom bot client.
 */
export function computeDummyAiMove(
  grid: {
    distance: (a: Cell, b: Cell) => number;
    inBounds: (cell: Cell) => boolean;
    accessibleNeighbors: (cell: Cell) => Cell[];
  },
  aiPos: Cell,
  goalPos: Cell,
): { actions: { type: "cat"; target: Cell }[] } {
  const curDist = grid.distance(aiPos, goalPos);

  // Try to find a cell at distance 2 that is 2 steps closer
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

  for (const [or, oc] of dist2offsets) {
    const candidatePos: Cell = [aiPos[0] + or, aiPos[1] + oc];

    if (
      grid.inBounds(candidatePos) &&
      grid.distance(aiPos, candidatePos) === 2 &&
      grid.distance(candidatePos, goalPos) === curDist - 2
    ) {
      return { actions: [{ type: "cat", target: candidatePos }] };
    }
  }

  // If no distance-2 cell gets us closer, try distance-1 cells
  const dist1offsets = [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ];

  for (const [or, oc] of dist1offsets) {
    const candidatePos: Cell = [aiPos[0] + or, aiPos[1] + oc];

    if (
      grid.inBounds(candidatePos) &&
      grid.distance(aiPos, candidatePos) === 1 &&
      grid.distance(candidatePos, goalPos) === curDist - 1
    ) {
      return { actions: [{ type: "cat", target: candidatePos }] };
    }
  }

  // If at distance 1, move to the goal
  if (curDist === 1) {
    return { actions: [{ type: "cat", target: goalPos }] };
  }

  // Fallback: just try any reachable neighbor that gets us closer
  const neighbors = grid.accessibleNeighbors(aiPos);
  for (const nbr of neighbors) {
    const nbrDist = grid.distance(nbr, goalPos);
    if (nbrDist < curDist) {
      return { actions: [{ type: "cat", target: nbr }] };
    }
  }

  // If stuck, make an empty move
  return { actions: [] };
}
