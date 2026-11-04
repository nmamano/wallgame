import type { Cell, PlayerId } from "./game-types";
import type { GameState } from "./game-state";
import { boardPawns, pawnCell } from "./pawns";
import { cellEq } from "./game-utils";
import { executableRulesFor, resolveRulePlayer } from "./variant-rules";

/** One player's shortest walk: its hunter's cell first, its target's last. */
export interface PlayerWalk {
  playerId: PlayerId;
  cells: Cell[];
}

const PLAYERS: readonly PlayerId[] = [1, 2];

/**
 * Each player's shortest walk to a target, from the variant's capture
 * relations: in Standard each cat to the other mouse, in Classic each cat
 * to its home, in Animal Cycle the shorter of the player's two hunts (the
 * first relation wins a tie). The walk goes around the other pawns when a
 * walk as short does (Grid.shortestPath). A player with no hunt, or whose
 * targets cannot be reached, has no walk.
 */
export const playerWalks = (
  state: Pick<GameState, "grid" | "pawns" | "config">,
): PlayerWalk[] => {
  const { captureRelations } = executableRulesFor(state.config.variant);
  const pawnCells = boardPawns(state.pawns).map((p) => p.cell);
  return PLAYERS.flatMap((playerId) => {
    let best: Cell[] | null = null;
    for (const relation of captureRelations) {
      const hunter = pawnCell(
        state.pawns,
        resolveRulePlayer(relation.hunter.player, playerId),
        relation.hunter.type,
      );
      const target = pawnCell(
        state.pawns,
        resolveRulePlayer(relation.target.player, playerId),
        relation.target.type,
      );
      // A relation with explicit players (Animal Cycle) belongs to the
      // hunter's owner only.
      if (
        !hunter ||
        !target ||
        resolveRulePlayer(relation.hunter.player, playerId) !== playerId
      ) {
        continue;
      }
      const others = pawnCells.filter(
        (c) => !cellEq(c, hunter) && !cellEq(c, target),
      );
      const cells = state.grid.shortestPath(hunter, target, others);
      if (cells && (!best || cells.length < best.length)) best = cells;
    }
    return best ? [{ playerId, cells: best }] : [];
  });
};
