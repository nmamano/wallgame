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

/**
 * One dot of the drawn walks, at a cell's centre or halfway between two
 * cells. Its place is in half-cell steps (a cell's centre is at twice its
 * row and column), so the same point of two walks is the same dot.
 */
export interface WalkDot {
  halfRow: number;
  halfCol: number;
  /** The players whose walks pass here: two where the walks meet. */
  playerIds: PlayerId[];
}

/**
 * The dots that draw `walks`: one between each two cells of a walk and one
 * on each cell between its ends, except a pawn's cell, so a dot never
 * covers a pawn.
 */
export const walkDots = (
  walks: readonly PlayerWalk[],
  pawnCells: readonly Cell[],
): WalkDot[] => {
  const onPawn = (cell: Cell) => pawnCells.some((c) => cellEq(c, cell));
  const dots = new Map<string, WalkDot>();
  const add = (halfRow: number, halfCol: number, playerId: PlayerId) => {
    const key = `${halfRow}:${halfCol}`;
    const dot = dots.get(key) ?? { halfRow, halfCol, playerIds: [] };
    dot.playerIds.push(playerId);
    dots.set(key, dot);
  };
  for (const { playerId, cells } of walks) {
    cells.forEach((cell, i) => {
      if (i === 0) return;
      const prev = cells[i - 1];
      add(prev[0] + cell[0], prev[1] + cell[1], playerId);
      if (i < cells.length - 1 && !onPawn(cell)) {
        add(2 * cell[0], 2 * cell[1], playerId);
      }
    });
  }
  return [...dots.values()];
};
