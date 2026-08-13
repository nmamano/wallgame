import type { AnimalCycleInitialState } from "./game-types";

export const buildAnimalCycleInitialState = (
  boardWidth: number,
  boardHeight: number,
): AnimalCycleInitialState => ({
  pawns: {
    p1: { dog: [0, 0], mouse: [boardHeight - 1, 0] },
    p2: {
      cat: [0, boardWidth - 1],
      elephant: [boardHeight - 1, boardWidth - 1],
    },
  },
  walls: [],
});
