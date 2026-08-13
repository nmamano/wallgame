import type { GamePawns, PlayerId } from "./game-types";
import { cellEq } from "./game-utils";

/** The owner of the first directed predator/prey overlap, if one exists. */
export function animalCycleCaptureWinner(
  pawns: Extract<GamePawns, { kind: "animal-cycle" }>,
): PlayerId | undefined {
  const { 1: p1, 2: p2 } = pawns.pawns;
  if (cellEq(p1.dog, p2.cat)) return 1;
  if (cellEq(p2.cat, p1.mouse)) return 2;
  if (cellEq(p1.mouse, p2.elephant)) return 1;
  if (cellEq(p2.elephant, p1.dog)) return 2;
  return undefined;
}
