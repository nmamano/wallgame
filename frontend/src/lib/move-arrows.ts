import type { Arrow } from "@/components/board";
import type {
  Action,
  Cell,
  GamePawnType,
  PlayerId,
} from "../../../shared/domain/game-types";
import type { GameState } from "../../../shared/domain/game-state";
import { isMovablePawnType, pawnCell } from "../../../shared/domain/pawns";
import { moveArrowCorner } from "../../../shared/domain/move-arrow";

/**
 * The arrows of one player's pawn moves in `actions` (a staged or premoved
 * queue, or a best move), from `state`. Two moves of the same pawn are one
 * arrow from its cell to its last target. A diagonal 2-step arrow turns at
 * the corner that moveArrowCorner picks, the rule of the last-move arrow
 * too, so a move looks the same before and after it is played (Nil,
 * 2026-11-04: "the premove arrow doesnt do the same L turn around a wall
 * as the actual move"). The walls are the board's and the walls in
 * `actions`.
 */
export function pawnMoveArrows(
  state: GameState,
  actions: readonly Action[],
  playerId: PlayerId,
  type: Arrow["type"],
): Arrow[] {
  const grid = state.grid.clone();
  for (const action of actions) {
    if (action.type === "wall" && action.wallOrientation) {
      grid.addWall({
        cell: action.target,
        orientation: action.wallOrientation,
        playerId,
      });
    }
  }
  const arrow = (pawnType: GamePawnType, from: Cell, to: Cell): Arrow => {
    // The teammate does not move in a 2-step move, so its cell now is its
    // cell after the move: the current pawns serve as `after`.
    const via = moveArrowCorner(
      { from, to, playerId, pawnType },
      state.pawns,
      grid,
      state.config.variant,
    );
    return { from, to, type, ...(via ? { via } : {}) };
  };

  const at: Partial<Record<GamePawnType, Cell>> = {};
  for (const pawnType of ["dog", "cat", "mouse", "elephant"] as const) {
    const cell = pawnCell(state.pawns, playerId, pawnType);
    if (cell) at[pawnType] = [cell[0], cell[1]];
  }

  const moves = actions.filter((action) => isMovablePawnType(action.type));
  if (
    actions.length === 2 &&
    moves.length === 2 &&
    moves.every((action) => action.type === moves[0].type)
  ) {
    const pawnType = moves[0].type as GamePawnType;
    const from = at[pawnType];
    if (!from) return [];
    const to = moves[1].target;
    return [arrow(pawnType, from, [to[0], to[1]])];
  }

  const arrows: Arrow[] = [];
  for (const action of moves) {
    const pawnType = action.type as GamePawnType;
    const from = at[pawnType];
    if (!from) continue;
    const to: Cell = [action.target[0], action.target[1]];
    arrows.push(arrow(pawnType, from, to));
    at[pawnType] = to;
  }
  return arrows;
}
