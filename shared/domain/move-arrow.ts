import type {
  Cell,
  GamePawns,
  PawnType,
  PlayerId,
  Variant,
} from "./game-types";
import type { Grid } from "./grid";
import { isMovablePawnType } from "./pawns";
import { animalCycleTeammateCell } from "./animal-cycle";
import { executableRulesFor } from "./variant-rules";

const cellsEqual = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1];

/**
 * The corner of a diagonal 2-step move, so its arrow can follow a route the
 * pawn could walk instead of a straight line past a wall. The stored record
 * cannot say which corner the pawn took (notation joins both steps into one
 * action), so this is a rule, the same in live play and in replays: the first
 * open corner in the order the rules engine tries them (game-state.ts
 * applyMove), along the row first, then along the column. A corner is open when
 * no wall blocks either step and, as in the engine, it is not `teammate`'s cell
 * (Animal Cycle teammates may not share a cell). `grid` is the grid after the
 * move; a 2-step pawn move uses the whole turn, so no wall was added.
 */
const diagonalCorner = (
  from: Cell,
  to: Cell,
  grid: Grid,
  teammate: Cell | undefined,
): Cell | undefined => {
  if (Math.abs(from[0] - to[0]) !== 1 || Math.abs(from[1] - to[1]) !== 1) {
    return undefined;
  }
  const corners: Cell[] = [
    [from[0], to[1]],
    [to[0], from[1]],
  ];
  return corners.find(
    (corner) =>
      !(teammate && cellsEqual(corner, teammate)) &&
      grid.accessibleNeighbors(from).some((cell) => cellsEqual(cell, corner)) &&
      grid.accessibleNeighbors(corner).some((cell) => cellsEqual(cell, to)),
  );
};

/**
 * The corner the board's last-move arrow bends at for one pawn's move, or
 * undefined for a straight arrow: the board (frontend gameViewModel) and the
 * game video's lints (scripts/game-video) draw and check the same arrow.
 * `after` and `grid` are the position after the move.
 */
export const moveArrowCorner = (
  move: {
    from: Cell;
    to: Cell;
    playerId: PlayerId;
    pawnType: PawnType;
  },
  after: GamePawns,
  grid: Grid,
  variant: Variant,
): Cell | undefined => {
  // The teammate did not move: a 2-step move spends both actions on one
  // pawn, so its cell after the move is its cell during the move.
  const teammate =
    after.kind === "animal-cycle" &&
    !executableRulesFor(variant).teammatesMayShareCell &&
    isMovablePawnType(move.pawnType)
      ? animalCycleTeammateCell(after, move.playerId, move.pawnType)
      : undefined;
  return diagonalCorner(move.from, move.to, grid, teammate);
};
