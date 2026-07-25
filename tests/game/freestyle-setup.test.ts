import { describe, expect, it } from "bun:test";
import { generateFreestyleInitialState } from "../../shared/domain/freestyle-setup";
import { Grid } from "../../shared/domain/grid";
import type { Cell, WallPosition } from "../../shared/domain/game-types";

/**
 * Freestyle generates a random starting position for any board size the server
 * accepts (3x3 up to 20x20). Two properties have to hold for every one of them:
 * the position must be left-right mirrored, and both players must still be able
 * to reach their goal. These tests sample the whole size range.
 */

// Sizes worth naming: the smallest the UI offers, the original fixed size, a
// square mid-size board, and two non-square boards in both orientations.
const SIZES: [number, number][] = [
  [4, 4],
  [12, 10],
  [8, 8],
  [5, 12],
  [12, 5],
];

const SAMPLES = 100;

const wallKey = (wall: WallPosition): string =>
  `${wall.orientation}:${wall.cell[0]},${wall.cell[1]}`;

const mirrorWall = (wall: WallPosition, boardWidth: number): WallPosition =>
  wall.orientation === "vertical"
    ? {
        cell: [wall.cell[0], boardWidth - 2 - wall.cell[1]],
        orientation: "vertical",
      }
    : {
        cell: [wall.cell[0], boardWidth - 1 - wall.cell[1]],
        orientation: "horizontal",
      };

const mirrorCell = (cell: Cell, boardWidth: number): Cell => [
  cell[0],
  boardWidth - 1 - cell[1],
];

describe("generateFreestyleInitialState", () => {
  for (const [boardWidth, boardHeight] of SIZES) {
    describe(`${boardWidth}x${boardHeight}`, () => {
      const samples = Array.from({ length: SAMPLES }, () =>
        generateFreestyleInitialState(boardWidth, boardHeight),
      );

      it("keeps every pawn on the board and on its own cell", () => {
        for (const { pawns } of samples) {
          const cells = [
            pawns.p1.cat,
            pawns.p1.mouse,
            pawns.p2.cat,
            pawns.p2.mouse,
          ];
          for (const [row, col] of cells) {
            expect(row).toBeGreaterThanOrEqual(0);
            expect(row).toBeLessThan(boardHeight);
            expect(col).toBeGreaterThanOrEqual(0);
            expect(col).toBeLessThan(boardWidth);
          }
          const distinct = new Set(cells.map(([row, col]) => `${row},${col}`));
          expect(distinct.size).toBe(4);
        }
      });

      it("mirrors player 1's pawns onto player 2", () => {
        for (const { pawns } of samples) {
          expect(pawns.p2.cat).toEqual(mirrorCell(pawns.p1.cat, boardWidth));
          expect(pawns.p2.mouse).toEqual(
            mirrorCell(pawns.p1.mouse, boardWidth),
          );
        }
      });

      it("produces a wall set that is its own mirror image", () => {
        for (const { walls } of samples) {
          const placed = new Set(walls.map(wallKey));
          for (const wall of walls) {
            expect(placed.has(wallKey(mirrorWall(wall, boardWidth)))).toBe(
              true,
            );
          }
        }
      });

      it("leaves both players an equal-length path to their goal", () => {
        for (const { pawns, walls } of samples) {
          const grid = new Grid(boardWidth, boardHeight, "freestyle");
          for (const wall of walls) {
            grid.addWall(wall);
          }
          // In standard/freestyle a cat chases the opponent's mouse.
          const p1Distance = grid.distance(pawns.p1.cat, pawns.p2.mouse);
          const p2Distance = grid.distance(pawns.p2.cat, pawns.p1.mouse);
          expect(p1Distance).not.toBe(-1);
          expect(p1Distance).toBe(p2Distance);
        }
      });
    });
  }

  it("scales the wall count with the board area", () => {
    const wallsFor = (boardWidth: number, boardHeight: number): number[] =>
      Array.from(
        { length: SAMPLES },
        () =>
          generateFreestyleInitialState(boardWidth, boardHeight).walls.length,
      );

    // 12x10 keeps its original tuning of 4-10 wall pairs. A pair is two wall
    // segments unless it mirrors onto itself on the centre line, so the segment
    // count lands somewhere in 4-20.
    const large = wallsFor(12, 10);
    expect(Math.min(...large)).toBeGreaterThanOrEqual(4);
    expect(Math.max(...large)).toBeLessThanOrEqual(20);

    // A 4x4 board has a fourteenth of the area and must not be wall-choked.
    const small = wallsFor(4, 4);
    expect(Math.max(...small)).toBeLessThanOrEqual(2);
  });
});
