import { describe, expect, test } from "bun:test";
import type { CustomSetupStandardInitialState } from "../../shared/domain/game-types";
import { replayDistances } from "./race-replay";
import { pageArrows, routeNear } from "./page-arrows.mjs";

// 4x4, player 2 to move. P2's cat on a1 [3,0] makes one diagonal 2-step
// move to b2 [2,1]: the board's arrow is an L through b1 [3,1] (the row
// first; shared/domain/move-arrow.ts).
const setup: CustomSetupStandardInitialState = {
  pawns: {
    p1: { cat: [0, 0], mouse: [0, 3] },
    p2: { cat: [3, 0], mouse: [3, 3] },
  },
  walls: [],
  turn: { playerId: 2, actionsTaken: [] },
};
const { states } = replayDistances({
  variant: "standard",
  boardWidth: 4,
  boardHeight: 4,
  initialState: setup,
  moves: ["Cb2"],
});

/** A cell's centre in cell units, and the distance to a point thing. */
const toPoint = ([row, col]: number[]) => ({ x: col, y: row });
const distanceTo =
  (thing: { x: number; y: number }) => (p: { x: number; y: number }) =>
    Math.hypot(p.x - thing.x, p.y - thing.y);

describe("the page's move arrows for the callback lint (2026-11-02, the L arrow)", () => {
  test("a diagonal 2-step move has the straight arrow and the L through the board's corner", () => {
    expect(pageArrows(states[0], states[1], "standard")).toEqual([
      {
        type: "cat",
        playerId: 2,
        routes: [
          [
            [3, 0],
            [2, 1],
          ],
          [
            [3, 0],
            [3, 1],
            [2, 1],
          ],
        ],
      },
    ]);
  });

  test("an erased wall at the L's corner is near the arrow, though the straight arrow misses it", () => {
    const [arrow] = pageArrows(states[0], states[1], "standard");
    const atCorner = distanceTo({ x: 1, y: 3 });
    const [straight, l] = arrow.routes;
    // The straight line passes about 0.71 cells from the corner.
    expect(routeNear(straight, toPoint, atCorner)).toBe(false);
    expect(routeNear(l, toPoint, atCorner)).toBe(true);
    // Away from both shapes: not near.
    const away = distanceTo({ x: 3, y: 0 });
    expect(arrow.routes.some((r) => routeNear(r, toPoint, away))).toBe(false);
  });

  test("a straight move has one route, and a pawn that did not move has none", () => {
    const { states: s } = replayDistances({
      variant: "standard",
      boardWidth: 4,
      boardHeight: 4,
      initialState: setup,
      moves: ["Ca3"],
    });
    expect(pageArrows(s[0], s[1], "standard")).toEqual([
      {
        type: "cat",
        playerId: 2,
        routes: [
          [
            [3, 0],
            [1, 0],
          ],
        ],
      },
    ]);
  });
});
