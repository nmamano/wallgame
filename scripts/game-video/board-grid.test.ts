import { describe, expect, test } from "bun:test";
import { boardGrid, onSiteWall } from "./board-grid.mjs";

// An 8x8 board as the replay page draws it: 45.9 css px cells with a 14.4 px
// (0.9rem) gap between them and none outside, in a clip with 10 px of air.
const CELL = 45.9;
const GAP = 14.4;
const GRID_PX = 8 * CELL + 7 * GAP;
const clip = { x: 90, y: 190, width: GRID_PX + 20, height: GRID_PX + 20 };
const cell = (row: number, col: number) => ({
  x: 100 + col * (CELL + GAP),
  y: 200 + row * (CELL + GAP),
  width: CELL,
  height: CELL,
});
const grid = boardGrid({
  clip,
  first: cell(0, 0),
  last: cell(7, 7),
  cols: 8,
  rows: 8,
});
/** Where the page draws >b3 (the right edge of b3, row 5 from the top). */
const pageWall = {
  vertical: true,
  x: (cell(5, 1).x + CELL + GAP / 2 - clip.x) / clip.width,
  y: (cell(5, 1).y + CELL / 2 - clip.y) / clip.height,
};
const ONE_PX = { x: 1 / clip.width, y: 1 / clip.height };

describe("boardGrid", () => {
  test("puts cell centres and the lines between cells where the page draws them", () => {
    expect(grid.x(1.5) * clip.width + clip.x).toBeCloseTo(
      cell(0, 1).x + CELL / 2,
      6,
    );
    expect(grid.x(2) * clip.width + clip.x).toBeCloseTo(
      cell(0, 1).x + CELL + GAP / 2,
      6,
    );
    expect(grid.y(5) * clip.height + clip.y).toBeCloseTo(
      cell(4, 0).y + CELL + GAP / 2,
      6,
    );
    expect(grid.pitchX * clip.width).toBeCloseTo(CELL + GAP, 6);
  });

  test("refuses cells that overlap", () => {
    expect(() =>
      boardGrid({
        clip,
        first: cell(0, 0),
        last: { ...cell(7, 7), x: 100 + 7 * CELL * 0.9 },
        cols: 8,
        rows: 8,
      }),
    ).toThrow(/overlap/);
  });
});

describe("onSiteWall", () => {
  // >b3 as a line from the top to the bottom of b3, on its right edge.
  const line = (x: (u: number) => number, y: (v: number) => number) =>
    [x(2), y(5), x(2), y(6)] as [number, number, number, number];

  test("a highlight from the page's cells lies on the page's wall", () => {
    expect(onSiteWall(line(grid.x, grid.y), [pageWall], ONE_PX)).toBe(true);
  });

  test("the old even map (VoSWbMDd cold open, 2026-10-26) is off the wall", () => {
    const pad = 10 / clip.width;
    const even = (u: number) => pad + (u / 8) * (1 - 2 * pad);
    expect(onSiteWall(line(even, even), [pageWall], ONE_PX)).toBe(false);
  });

  test("a wall the other way, or none, does not count", () => {
    const l = line(grid.x, grid.y);
    expect(onSiteWall(l, [{ ...pageWall, vertical: false }], ONE_PX)).toBe(
      false,
    );
    expect(onSiteWall(l, [], ONE_PX)).toBe(false);
  });
});
