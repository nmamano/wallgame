/**
 * The replay page's last-move arrows, for the callback lint
 * (render-game-video.mjs, callback-cover): the old spot that covers an
 * erased wall must not cover or bring back a move arrow near it.
 */
import { boardPawns, pawnCell } from "../../shared/domain/pawns.ts";
import { moveArrowCorner } from "../../shared/domain/move-arrow.ts";

/** How close a pawn's move arrow on the page may come to an erased wall. */
export const ARROW_CLEAR_CELLS = 0.3;

/**
 * The page's arrow of each pawn that moved from `before` to `after` (game
 * states), as routes of cells: straight from the old cell to the new one,
 * and, for a diagonal 2-step move, the L through the corner the board picks
 * (shared/domain/move-arrow.ts; the board draws it since the site deploy of
 * 2026-11-02 00:40 UTC, 52705b91). A capture keeps the look of its day, so
 * both shapes are given.
 * @param {{ pawns: any, grid: any }} before
 * @param {{ pawns: any, grid: any }} after
 * @param {string} variant
 * @returns {{ type: string, playerId: number, routes: number[][][] }[]}
 */
export const pageArrows = (before, after, variant) =>
  boardPawns(after.pawns).flatMap((p) => {
    const was = pawnCell(before.pawns, p.playerId, p.type);
    if (!was || (was[0] === p.cell[0] && was[1] === p.cell[1])) return [];
    const corner = moveArrowCorner(
      { from: was, to: p.cell, playerId: p.playerId, pawnType: p.type },
      after.pawns,
      after.grid,
      /** @type {any} */ (variant),
    );
    return [
      {
        type: p.type,
        playerId: p.playerId,
        routes: [[was, p.cell], ...(corner ? [[was, corner, p.cell]] : [])],
      },
    ];
  });

/**
 * Whether a route of cells comes within `clear` cells of a thing, sampled
 * at 21 points a leg: `toPoint` places a cell, `distance` measures a point
 * to the thing, in cells.
 * @param {number[][]} route
 * @param {(cell: number[]) => { x: number, y: number }} toPoint
 * @param {(p: { x: number, y: number }) => number} distance
 * @param {number} [clear]
 */
export const routeNear = (
  route,
  toPoint,
  distance,
  clear = ARROW_CLEAR_CELLS,
) =>
  route.slice(1).some((cell, i) => {
    const [a, b] = [toPoint(route[i]), toPoint(cell)];
    return Array.from({ length: 21 }, (_, j) => j / 20).some(
      (f) =>
        distance({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }) <
        clear,
    );
  });
