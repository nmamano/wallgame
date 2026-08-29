import type { Cell, GamePawnType, GamePawns, PlayerId } from "./game-types";
import { cellEq } from "./game-utils";
import { pawnCell } from "./pawns";
import { executableRulesFor, resolveRulePlayer } from "./variant-rules";

/** The owner of the first directed predator/prey overlap, if one exists. */
export function animalCycleCaptureWinner(
  pawns: Extract<GamePawns, { kind: "animal-cycle" }>,
): PlayerId | undefined {
  const rules = executableRulesFor("animal-cycle");
  for (const relation of rules.captureRelations) {
    const hunterPlayer = resolveRulePlayer(relation.hunter.player, 1);
    const targetPlayer = resolveRulePlayer(relation.target.player, 1);
    const hunter = pawnCell(pawns, hunterPlayer, relation.hunter.type);
    const target = pawnCell(pawns, targetPlayer, relation.target.type);
    if (hunter && target && cellEq(hunter, target)) return hunterPlayer;
  }
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
