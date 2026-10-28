import { describe, expect, test } from "bun:test";
import type { CustomSetupStandardInitialState } from "../../shared/domain/game-types";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import { huntPath, huntWalks, huntsFor, replayDistances } from "./race-replay";

// 4x4, player 2 to move. P1's cat [0,0] is 3 steps from P2's mouse [0,3]
// along the top row; P2's cat [3,0] is 3 from P1's mouse [3,3].
const corridor: CustomSetupStandardInitialState = {
  pawns: {
    p1: { cat: [0, 0], mouse: [3, 3] },
    p2: { cat: [3, 0], mouse: [0, 3] },
  },
  walls: [],
  turn: { playerId: 2, actionsTaken: [] },
};

describe("huntPath", () => {
  test("walks the cells the counter counts, around the walls", () => {
    // >a4 and >a3 close the cat's right-hand edges at [0,0] and [1,0], so
    // it walks down two rows first: 2 down + 3 right + 2 up = 7.
    const { states } = replayDistances({
      variant: "standard",
      boardWidth: 4,
      boardHeight: 4,
      initialState: corridor,
      moves: [">a4.>a3"],
    });
    const after = states[1];
    const p1Cat = huntsFor("standard").find(
      (h) => h.hunter.player === 1 && h.hunter.type === "cat",
    )!;
    const path = huntPath(after.grid, after.pawns, p1Cat);
    expect(path).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 1],
      [2, 2],
      [2, 3],
      [1, 3],
      [0, 3],
    ]);
    // Before the walls it is the top row, 3 steps.
    expect(huntPath(states[0].grid, states[0].pawns, p1Cat)).toHaveLength(4);
  });

  test("has the length of the engine's walk in every position of a game", () => {
    const { states } = replayDistances({
      variant: "standard",
      boardWidth: 8,
      boardHeight: 8,
      initialState: buildStandardInitialState(8, 8) as never,
      moves: [">d5.>d4", "^e3.^f3", ">b7.^c6", "^g6.>e2", "^b3.>f6"],
    });
    const hunts = huntsFor("standard");
    for (const state of states) {
      const walks = huntWalks(state);
      hunts.forEach((hunt, i) => {
        const path = huntPath(state.grid, state.pawns, hunt);
        expect(path.length - 1).toBe(walks[i]);
        // Each step is to a neighbour the grid allows.
        for (let k = 1; k < path.length; k++) {
          expect(state.grid.accessibleNeighbors(path[k - 1])).toContainEqual(
            path[k],
          );
        }
      });
    }
  });
});
