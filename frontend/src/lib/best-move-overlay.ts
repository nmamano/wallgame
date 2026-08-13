import type { Arrow } from "@/components/board";
import type { WallPosition } from "../../../shared/domain/game-types";
import type { GameState } from "../../../shared/domain/game-state";
import { isMovablePawnType, pawnCell } from "../../../shared/domain/pawns";
import { moveFromStandardNotation } from "../../../shared/domain/standard-notation";

type WallState =
  | "placed"
  | "staged"
  | "premoved"
  | "calculated"
  | "missing"
  | "best-move";

type WallPositionWithState = WallPosition & {
  state?: WallState;
};

interface BestMoveOverlay {
  arrows: Arrow[];
  walls: WallPositionWithState[];
}

/**
 * Parse a best-move string (standard notation) into board overlay data.
 * Returns arrows for pawn moves and walls for wall placements, all typed as "best-move".
 */
export function parseBestMoveOverlay(
  bestMove: string,
  displayState: GameState,
): BestMoveOverlay | null {
  if (!bestMove || bestMove === "---") return null;

  try {
    const move = moveFromStandardNotation(
      bestMove,
      displayState.config.boardHeight,
    );

    const arrows: Arrow[] = [];
    const walls: WallPositionWithState[] = [];
    const currentPlayer = displayState.turn;

    for (const action of move.actions) {
      if (isMovablePawnType(action.type)) {
        const from = pawnCell(displayState.pawns, currentPlayer, action.type);
        if (from) {
          arrows.push({ from, to: action.target, type: "best-move" });
        }
      } else if (action.type === "wall") {
        walls.push({
          cell: action.target,
          orientation: action.wallOrientation!,
          playerId: currentPlayer,
          state: "best-move",
        });
      }
    }

    return { arrows, walls };
  } catch {
    return null;
  }
}
