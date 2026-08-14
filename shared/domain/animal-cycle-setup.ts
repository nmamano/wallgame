import type { AnimalCycleInitialState } from "./game-types";

export const buildAnimalCycleInitialState = (
  boardWidth: number,
  boardHeight: number,
): AnimalCycleInitialState => ({
  pawns: {
    p1: {
      dog: [boardHeight - 1, 0],
      mouse: [0, boardWidth - 1],
    },
    p2: {
      cat: [0, 0],
      elephant: [boardHeight - 1, boardWidth - 1],
    },
  },
  walls: [],
});
