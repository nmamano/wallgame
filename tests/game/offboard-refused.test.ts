/**
 * A pawn may not be sent off the board.
 *
 * `applyMove` bounded a WALL target from the beginning — `canBuildWall` starts
 * with `inBounds` — but never a PAWN target. Measured against 66f6688 on an 8x8
 * board, all six of the sequences below were ACCEPTED, and the pawn ended up
 * outside the grid: [0,0] to [0,-1], to [-1,0], to [0,-2] (two cells off), to
 * [-1,-1], the mouse from [7,0] to [8,0], and p2's cat from [0,7] to [0,8].
 * Board task d39862b4.
 *
 * It was reachable from a socket frame, not only from hand-built state: the
 * crafted frame `{"type":"submit-move","move":{"actions":[{"type":"cat",
 * "target":[0,-1]}]}}` moved the authoritative state and persisted the term
 * "C`8". The wire half of that is pinned in
 * `tests/integration/offboard-frame-refused.test.ts`; this file pins the rule,
 * which is what protects every OTHER caller — client-side validation, replay,
 * the puzzle and campaign paths.
 *
 * No stored row anywhere in the archive holds an off-board cell (0 of 5,626
 * games and 270,385 notation terms, measured 2026-08-09), so unlike the
 * backtrack fix this one needs no stored-history escape hatch.
 *
 * THE BOUNDS ARE THE GAME'S OWN. The archive holds fifteen board shapes and six
 * are non-square, so "off the board" is not a constant. The last describe block
 * is the part that would fail if the check ever hardcoded 8, or read width where
 * it meant height.
 */

import { describe, expect, it } from "bun:test";
import { GameState } from "../../shared/domain/game-state";
import { timeControlConfigFromPreset } from "../../shared/domain/game-utils";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import { requirePawnCell } from "../../shared/domain/pawns";
import type {
  Cell,
  GameConfiguration,
  GameInitialState,
  Move,
  PlayerId,
} from "../../shared/domain/game-types";

const OFF_BOARD = "A pawn cannot leave the board";

const standard = (width: number, height: number): GameConfiguration => ({
  variant: "standard",
  timeControl: timeControlConfigFromPreset("unlimited"),
  rated: false,
  boardWidth: width,
  boardHeight: height,
  variantConfig: buildStandardInitialState(width, height),
});

interface Layout {
  p1cat: Cell;
  p1mouse: Cell;
  p2cat: Cell;
  p2mouse: Cell;
}

/**
 * A board of the given size with the four pawns exactly where the case wants
 * them. Placed rather than walked, so a case about the RIGHT edge of a 5-wide
 * board is not also a case about the four moves it takes to get there.
 */
const placed = (width: number, height: number, layout: Layout): GameState =>
  new GameState(
    {
      ...standard(width, height),
      variantConfig: {
        pawns: {
          p1: { cat: layout.p1cat, mouse: layout.p1mouse },
          p2: { cat: layout.p2cat, mouse: layout.p2mouse },
        },
        walls: [],
      } as unknown as GameInitialState,
    },
    0,
  );

const catTo = (target: Cell): Move => ({
  actions: [{ type: "cat", target }],
});

const submit = (state: GameState, playerId: PlayerId, move: Move) =>
  state.applyGameAction({ kind: "move", move, playerId, timestamp: 1_000 });

describe("an off-board pawn target", () => {
  // The six sequences the unfixed tree accepted, verbatim.
  const INCIDENTS: { label: string; move: Move; playerId: PlayerId }[] = [
    { label: "cat [0,0] -> [0,-1]", move: catTo([0, -1]), playerId: 1 },
    { label: "cat [0,0] -> [-1,0]", move: catTo([-1, 0]), playerId: 1 },
    { label: "cat [0,0] -> [0,-2]", move: catTo([0, -2]), playerId: 1 },
    { label: "cat [0,0] -> [-1,-1]", move: catTo([-1, -1]), playerId: 1 },
    {
      label: "mouse [7,0] -> [8,0]",
      move: { actions: [{ type: "mouse", target: [8, 0] }] },
      playerId: 1,
    },
  ];

  for (const incident of INCIDENTS) {
    it(`is refused: ${incident.label}`, () => {
      const state = new GameState(standard(8, 8), 0);
      expect(() => submit(state, incident.playerId, incident.move)).toThrow(
        OFF_BOARD,
      );
    });
  }

  it("is refused for player 2 as well: cat [0,7] -> [0,8]", () => {
    // Seat-independent, and it reaches the check through a real turn rather
    // than through the opening position.
    const opened = submit(new GameState(standard(8, 8), 0), 1, catTo([1, 0]));
    expect(() => submit(opened, 2, catTo([0, 8]))).toThrow(OFF_BOARD);
  });

  it("leaves the game exactly as it was", () => {
    const state = new GameState(standard(8, 8), 0);
    const catBefore = requirePawnCell(state.pawns, 1, "cat");

    expect(() => submit(state, 1, catTo([0, -1]))).toThrow(OFF_BOARD);

    expect(state.history).toHaveLength(0);
    expect(state.moveCount).toBe(0);
    expect(state.turn).toBe(1);
    expect(state.status).toBe("playing");
    expect(requirePawnCell(state.pawns, 1, "cat")).toEqual(catBefore);
  });

  it("still accepts a legal step, so the check is not refusing everything", () => {
    // Positive control. Without it, a check that threw unconditionally would
    // pass every assertion above.
    const next = submit(new GameState(standard(8, 8), 0), 1, catTo([0, 1]));
    expect(requirePawnCell(next.pawns, 1, "cat")).toEqual([0, 1]);
    expect(next.history).toHaveLength(1);
  });
});

describe("an off-board wall target", () => {
  // Pinned, not added: `canBuildWall` has always started with `inBounds`, and
  // the probe against 66f6688 confirmed all three of these were refused before
  // this change. Recorded here so the coverage is a test rather than folklore,
  // and so a later edit to the wall path cannot quietly drop it.
  const WALLS: Cell[] = [
    [0, -1],
    [-1, 0],
    [8, 8],
  ];

  for (const target of WALLS) {
    it(`is refused: wall at ${JSON.stringify(target)}`, () => {
      const state = new GameState(standard(8, 8), 0);
      expect(() =>
        submit(state, 1, {
          actions: [{ type: "wall", target, wallOrientation: "vertical" }],
        }),
      ).toThrow("Illegal wall placement");
    });
  }

  it("still accepts a legal wall", () => {
    const next = submit(new GameState(standard(8, 8), 0), 1, {
      actions: [{ type: "wall", target: [3, 3], wallOrientation: "vertical" }],
    });
    expect(next.history).toHaveLength(1);
  });
});

describe("the bounds are the game's own board, not a constant", () => {
  // Each pair below sends the SAME cell to two different boards. One accepts it
  // and the other refuses it, and the only difference is a dimension - which is
  // what "bounds come from the real grid" has to mean to be worth anything.

  it("refuses column 5 on a 5-wide board and accepts it on an 8-wide one", () => {
    const layout: Layout = {
      p1cat: [0, 4],
      p1mouse: [4, 4],
      p2cat: [0, 0],
      p2mouse: [4, 0],
    };
    expect(() => submit(placed(5, 5, layout), 1, catTo([0, 5]))).toThrow(
      OFF_BOARD,
    );

    const wider = submit(placed(8, 8, layout), 1, catTo([0, 5]));
    expect(requirePawnCell(wider.pawns, 1, "cat")).toEqual([0, 5]);
  });

  it("refuses row 5 on a 5-high board and accepts it on an 8-high one", () => {
    const layout: Layout = {
      p1cat: [4, 2],
      p1mouse: [4, 4],
      p2cat: [0, 0],
      p2mouse: [0, 4],
    };
    expect(() => submit(placed(5, 5, layout), 1, catTo([5, 2]))).toThrow(
      OFF_BOARD,
    );

    const taller = submit(placed(8, 8, layout), 1, catTo([5, 2]));
    expect(requirePawnCell(taller.pawns, 1, "cat")).toEqual([5, 2]);
  });

  it("reads width and height separately on a 12x10 board", () => {
    // 501 stored games are 12x10. A square board cannot tell a correct check
    // from one that compares a row against the width, so this pair does: on a
    // 12-wide, 10-high board, column 11 is legal and row 11 is not. Swap the two
    // dimensions in the check and BOTH assertions flip.
    const edge: Layout = {
      p1cat: [0, 11],
      p1mouse: [9, 11],
      p2cat: [0, 0],
      p2mouse: [9, 0],
    };
    const onColumn11 = submit(placed(12, 10, edge), 1, catTo([1, 11]));
    expect(requirePawnCell(onColumn11.pawns, 1, "cat")).toEqual([1, 11]);

    const low: Layout = {
      p1cat: [9, 5],
      p1mouse: [0, 11],
      p2cat: [0, 0],
      p2mouse: [9, 11],
    };
    expect(() => submit(placed(12, 10, low), 1, catTo([11, 5]))).toThrow(
      OFF_BOARD,
    );
    // And one step past the bottom edge, which is the ordinary case of the same
    // rule rather than the two-cell one above.
    expect(() => submit(placed(12, 10, low), 1, catTo([10, 5]))).toThrow(
      OFF_BOARD,
    );
    // Column 12 is past the right edge of the same board.
    expect(() => submit(placed(12, 10, edge), 1, catTo([0, 12]))).toThrow(
      OFF_BOARD,
    );
  });
});
