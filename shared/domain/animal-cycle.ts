import type { Cell, GamePawnType, GamePawns, PlayerId } from "./game-types";
import { cellEq } from "./game-utils";

/** The owner of the first directed predator/prey overlap, if one exists. */
export function animalCycleCaptureWinner(
  pawns: Extract<GamePawns, { kind: "animal-cycle" }>,
): PlayerId | undefined {
  const { 1: p1, 2: p2 } = pawns.pawns;
  if (cellEq(p1.cat, p2.mouse)) return 1;
  if (cellEq(p2.mouse, p1.elephant)) return 2;
  if (cellEq(p1.elephant, p2.dog)) return 1;
  if (cellEq(p2.dog, p1.cat)) return 2;
  return undefined;
}

/** The other animal owned by this player. */
export function animalCycleTeammateCell(
  pawns: Extract<GamePawns, { kind: "animal-cycle" }>,
  playerId: PlayerId,
  pawnType: GamePawnType,
): Cell {
  if (playerId === 1) {
    if (pawnType === "cat") return pawns.pawns[1].elephant;
    if (pawnType === "elephant") return pawns.pawns[1].cat;
  } else {
    if (pawnType === "mouse") return pawns.pawns[2].dog;
    if (pawnType === "dog") return pawns.pawns[2].mouse;
  }
  throw new Error("Pawn not available for this Animal Cycle player");
}
