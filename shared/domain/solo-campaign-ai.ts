import type { Cell, Move } from "./game-types";

// Re-export the chase AI (same as dummy AI - moves toward goal)
export { computeDummyAiMove as computeChaseAiMove } from "./dummy-ai";

interface GridInterface {
  distance: (a: Cell, b: Cell) => number;
  inBounds: (cell: Cell) => boolean;
  accessibleNeighbors: (cell: Cell) => Cell[];
}

/**
 * Flee AI: moves AWAY from the threat (opposite of dummy/chase AI).
 * Used for the mouse AI in Level 1 where the mouse tries to evade the cat.
 *
 * Strategy:
 * 1. Look for cells 2 steps away that maximize distance from threat
 * 2. Fall back to 1 step if needed
 * 3. Among ties, pick randomly
 */
export function computeFleeAiMove(
  grid: GridInterface,
  aiPos: Cell,
  threatPos: Cell,
): Move {
  const curDist = grid.distance(aiPos, threatPos);

  // Try to find a cell at distance 2 that maximizes distance from threat
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

  // Collect all valid distance-2 moves with their resulting distances
  const dist2Candidates: { pos: Cell; resultDist: number }[] = [];

  for (const [or, oc] of dist2offsets) {
    const candidatePos: Cell = [aiPos[0] + or, aiPos[1] + oc];

    if (
      grid.inBounds(candidatePos) &&
      grid.distance(aiPos, candidatePos) === 2
    ) {
      const resultDist = grid.distance(candidatePos, threatPos);
      dist2Candidates.push({ pos: candidatePos, resultDist });
    }
  }

  // Find the maximum distance achievable
  if (dist2Candidates.length > 0) {
    const maxDist = Math.max(...dist2Candidates.map((c) => c.resultDist));
    // Only consider moves that increase or maintain distance (flee, don't approach)
    const bestCandidates = dist2Candidates.filter(
      (c) => c.resultDist === maxDist && c.resultDist >= curDist,
    );

    if (bestCandidates.length > 0) {
      // Pick randomly among best options
      const chosen =
        bestCandidates[Math.floor(Math.random() * bestCandidates.length)];
      return { actions: [{ type: "mouse", target: chosen.pos }] };
    }
  }

  // Fall back to distance-1 moves
  const dist1offsets = [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ];

  const dist1Candidates: { pos: Cell; resultDist: number }[] = [];

  for (const [or, oc] of dist1offsets) {
    const candidatePos: Cell = [aiPos[0] + or, aiPos[1] + oc];

    if (
      grid.inBounds(candidatePos) &&
      grid.distance(aiPos, candidatePos) === 1
    ) {
      const resultDist = grid.distance(candidatePos, threatPos);
      dist1Candidates.push({ pos: candidatePos, resultDist });
    }
  }

  if (dist1Candidates.length > 0) {
    const maxDist = Math.max(...dist1Candidates.map((c) => c.resultDist));
    const bestCandidates = dist1Candidates.filter(
      (c) => c.resultDist === maxDist,
    );

    if (bestCandidates.length > 0) {
      const chosen =
        bestCandidates[Math.floor(Math.random() * bestCandidates.length)];
      return { actions: [{ type: "mouse", target: chosen.pos }] };
    }
  }

  // If completely stuck (no valid moves), return empty move
  // This shouldn't happen in normal gameplay
  return { actions: [] };
}
