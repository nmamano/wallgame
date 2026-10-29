import { describe, expect, test } from "bun:test";
import type { CustomSetupStandardInitialState } from "../../shared/domain/game-types";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import {
  huntPath,
  huntWalks,
  huntsFor,
  pawnCellsOn,
  preyTypeOf,
  replayDistances,
} from "./race-replay";

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

  test("of the shortest walks, takes one around the other pawns", () => {
    // P1's cat [0,0] to P2's mouse [1,2]: 3 steps, by three walks. P2's
    // cat stands on [0,1], where the search's first walk went before
    // (right, right, down; checked against main e75f5a08, 2026-10-29).
    const setup: CustomSetupStandardInitialState = {
      pawns: {
        p1: { cat: [0, 0], mouse: [3, 3] },
        p2: { cat: [0, 1], mouse: [1, 2] },
      },
      walls: [],
      turn: { playerId: 2, actionsTaken: [] },
    };
    const { states } = replayDistances({
      variant: "standard",
      boardWidth: 4,
      boardHeight: 4,
      initialState: setup,
      moves: [],
    });
    const p1Cat = huntsFor("standard").find(
      (h) => h.hunter.player === 1 && h.hunter.type === "cat",
    )!;
    const path = huntPath(states[0].grid, states[0].pawns, p1Cat);
    expect(path).toHaveLength(4);
    // Not through P2's cat on [0,1]: down first.
    expect(path[1]).toEqual([1, 0]);
    expect(pawnCellsOn(states[0].pawns, path)).toEqual([]);
  });

  test("names the pawns a walk cannot avoid, the hunter and target left out", () => {
    // The top row is the only 3-step walk, and P2's cat stands on [0,1].
    const setup: CustomSetupStandardInitialState = {
      ...corridor,
      pawns: {
        p1: { cat: [0, 0], mouse: [3, 3] },
        p2: { cat: [0, 1], mouse: [0, 3] },
      },
    };
    const { states } = replayDistances({
      variant: "standard",
      boardWidth: 4,
      boardHeight: 4,
      initialState: setup,
      moves: [],
    });
    const p1Cat = huntsFor("standard").find(
      (h) => h.hunter.player === 1 && h.hunter.type === "cat",
    )!;
    const path = huntPath(states[0].grid, states[0].pawns, p1Cat);
    expect(path).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
    ]);
    expect(pawnCellsOn(states[0].pawns, path)).toEqual([1]);
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

describe("preyTypeOf: the one pawn of a seat that the other side hunts", () => {
  test("standard and survival: the mouse", () => {
    expect(preyTypeOf("standard", 1)).toEqual({ type: "mouse" });
    expect(preyTypeOf("standard", 2)).toEqual({ type: "mouse" });
    expect(preyTypeOf("survival", 2)).toEqual({ type: "mouse" });
  });
  test("no prey or two prey types: a reason, never a guess", () => {
    // Classic: each cat runs to its own home; no seat's pawn is hunted.
    expect(preyTypeOf("classic", 1)).toEqual({
      reason: "in classic the other side hunts none of player 1's pawns",
    });
    // Survival: only player 1's cat hunts.
    expect("reason" in preyTypeOf("survival", 1)).toBe(true);
    // Animal Cycle: player 2's mouse and dog are both hunted.
    const cycle = preyTypeOf("animal-cycle", 2);
    expect("reason" in cycle && cycle.reason).toContain("2 of player 2's");
  });
});
