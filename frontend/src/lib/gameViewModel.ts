import type { LastMove, LastWall } from "@/components/board";
import type {
  PlayerId,
  GameResult,
  Cell,
  GamePawnType,
  Action,
  GameConfiguration,
  GamePawns,
} from "../../../shared/domain/game-types";
import { boardPawns } from "../../../shared/domain/pawns";
import { GameState } from "../../../shared/domain/game-state";
import type { GameSnapshot } from "../../../shared/domain/game-types";
import { type PlayerColor } from "@/lib/player-colors";

export type PlayerType = "you" | "friend" | "matched-user";

// ============================================================================
// View Model Architecture
// ============================================================================
// The GameViewModel is the single source of truth for all server-controlled
// game state. All server updates flow through a single entry point, and all
// UI state is derived from this model plus local preferences.

/**
 * Colorless last-move identity: WHO moved WHERE. Colors are presentation and
 * are applied at render time (colorizeLastMoves) — never cached. Caching
 * colored arrows froze whatever color map existed when a server update
 * arrived, which mis-colored a puzzle's bot lead-in on first join (the local
 * seat had not resolved yet).
 */
export interface LastMoveDiff {
  fromRow: number;
  fromCol: number;
  toRow: number;
  toCol: number;
  playerId: PlayerId;
}

/** Colorless last-wall identity; ownership comes from the history grid. */
export interface LastWallDiff {
  row: number;
  col: number;
  orientation: NonNullable<Action["wallOrientation"]>;
  playerId: PlayerId;
}

export interface GameViewModel {
  // Game configuration (board size, time control, etc.)
  config: GameConfiguration | null;
  // Current game state (board, turn, clocks, history)
  gameState: GameState | null;
  // Match/lobby metadata (players, readiness, appearances)
  match: GameSnapshot | null;
  // Last move arrows (colorless identity; colorize at render time)
  lastMoves: LastMoveDiff[] | null;
  // Last placed walls (colorless identity; colorize at render time)
  lastWalls: LastWallDiff[] | null;
  // Whether the game has been initialized
  initialized: boolean;
}

export type ServerUpdate =
  | {
      type: "game-state";
      config: GameConfiguration;
      gameState: GameState;
      isInitial: boolean;
    }
  | { type: "match"; snapshot: GameSnapshot };

export const DEFAULT_VIEW_MODEL: GameViewModel = {
  config: null,
  gameState: null,
  match: null,
  lastMoves: null,
  lastWalls: null,
  initialized: false,
};

const DEFAULT_PLAYER_COLORS: Record<PlayerId, PlayerColor> = {
  1: "red",
  2: "blue",
};

// ============================================================================
// Server Update Logic
// ============================================================================

const pawnKey = (playerId: PlayerId, type: string) => `${playerId}:${type}`;

/**
 * One arrow per pawn that moved. Driven by `boardPawns`, so each variant
 * contributes exactly the pawns it has - a classic home is compared like
 * anything else and simply never moves.
 *
 * `playerId` comes off the Pawn itself, so it stays a real number. Iterating
 * Object.keys would hand back STRING keys, which index a color map fine but
 * must never be stored as a diff's playerId.
 */
const diffSnapshots = (
  before: GamePawns,
  after: GamePawns,
): LastMoveDiff[] | null => {
  const moves: LastMoveDiff[] = [];
  const beforeCells = new Map<string, Cell>(
    boardPawns(before).map((pawn) => [
      pawnKey(pawn.playerId, pawn.type),
      pawn.cell,
    ]),
  );

  boardPawns(after).forEach((pawn) => {
    const from = beforeCells.get(pawnKey(pawn.playerId, pawn.type));
    if (!from) return;
    const to = pawn.cell;
    if (from[0] === to[0] && from[1] === to[1]) return;
    moves.push({
      fromRow: from[0],
      fromCol: from[1],
      toRow: to[0],
      toCol: to[1],
      playerId: pawn.playerId,
    });
  });

  return moves.length ? moves : null;
};

/**
 * Computes colorless last-move diffs from the authoritative move history.
 * After a takeback, the history is truncated, so arrows disappear naturally.
 */
export function computeLastMoveDiffs(
  current: GameState | null,
): LastMoveDiff[] | null {
  if (!current || current.history.length === 0) {
    return null;
  }

  const lastEntry = current.history[current.history.length - 1];
  const beforeEntry =
    current.history.length > 1
      ? current.history[current.history.length - 2]
      : null;

  const afterSnapshot = lastEntry.pawns;
  const beforeSnapshot = beforeEntry
    ? beforeEntry.pawns
    : current.getInitialSnapshot().pawns;

  return diffSnapshots(beforeSnapshot, afterSnapshot);
}

/**
 * Computes colorless last-wall diffs from the authoritative move history.
 * Ownership comes from the resulting grid (placed walls are stamped with the
 * mover's playerId) — direct evidence, replacing an index-parity formula
 * whose cached attribution was incorrect (1-based indices flipped it; no
 * current consumer rendered that value, but future ones would). A wall
 * without stored ownership is deliberately omitted rather than guessed.
 */
export function computeLastWallDiffs(
  current: GameState | null,
): LastWallDiff[] | null {
  if (!current || current.history.length === 0) {
    return null;
  }

  const lastEntry = current.history[current.history.length - 1];
  const wallActions = lastEntry.move.actions.filter(
    (action) => action.type === "wall" && action.wallOrientation,
  );

  if (wallActions.length === 0) {
    return null;
  }

  const gridWalls = lastEntry.grid.getWalls();
  const diffs: LastWallDiff[] = [];
  for (const action of wallActions) {
    const placed = gridWalls.find(
      (wall) =>
        wall.cell[0] === action.target[0] &&
        wall.cell[1] === action.target[1] &&
        wall.orientation === action.wallOrientation,
    );
    if (placed?.playerId === undefined) {
      continue;
    }
    diffs.push({
      row: action.target[0],
      col: action.target[1],
      orientation: action.wallOrientation!,
      playerId: placed.playerId,
    });
  }

  return diffs.length ? diffs : null;
}

/** Applies the CURRENT color map to cached colorless move diffs, at render time. */
export function colorizeLastMoves(
  diffs: LastMoveDiff[] | null,
  playerColorsForBoard: Record<PlayerId, PlayerColor>,
): LastMove[] | null {
  if (!diffs) return null;
  return diffs.map(({ playerId, ...coordinates }) => ({
    ...coordinates,
    playerColor:
      playerColorsForBoard[playerId] ?? DEFAULT_PLAYER_COLORS[playerId],
  }));
}

/** Applies the CURRENT color map to cached colorless wall diffs, at render time. */
export function colorizeLastWalls(
  diffs: LastWallDiff[] | null,
  playerColorsForBoard: Record<PlayerId, PlayerColor>,
): LastWall[] | null {
  if (!diffs) return null;
  return diffs.map(({ playerId, ...wall }) => ({
    ...wall,
    playerColor:
      playerColorsForBoard[playerId] ?? DEFAULT_PLAYER_COLORS[playerId],
  }));
}

/**
 * Colored convenience wrapper for consumers whose color map is reactive at
 * the call site (showcase, scripted puzzles, solo campaign, history mode).
 */
export function computeLastMoves(
  current: GameState | null,
  playerColorsForBoard: Record<PlayerId, PlayerColor>,
): LastMove[] | null {
  return colorizeLastMoves(computeLastMoveDiffs(current), playerColorsForBoard);
}

/** Colored convenience wrapper; see computeLastMoves. */
export function computeLastWalls(
  current: GameState | null,
  playerColorsForBoard: Record<PlayerId, PlayerColor>,
): LastWall[] | null {
  return colorizeLastWalls(computeLastWallDiffs(current), playerColorsForBoard);
}

/**
 * Applies a server update to the view model.
 * This is the single entry point for all server-controlled state updates.
 */
export function applyServerUpdate(
  prev: GameViewModel,
  update: ServerUpdate,
): GameViewModel {
  switch (update.type) {
    case "game-state": {
      // Compute COLORLESS last-move/wall diffs solely from the new state's
      // history; colors are applied at render time so a color map that
      // settles after this update (fresh join) can never be frozen in.
      const lastMoves = computeLastMoveDiffs(update.gameState);
      const lastWalls = computeLastWallDiffs(update.gameState);
      return {
        ...prev,
        config: update.config,
        gameState: update.gameState,
        lastMoves,
        lastWalls,
        initialized: prev.initialized || update.isInitial,
      };
    }
    case "match": {
      return {
        ...prev,
        match: update.snapshot,
      };
    }
  }
}

// ============================================================================
// Pure Helper Functions
// ============================================================================

export function buildPlayerName(
  type: PlayerType,
  index: number,
  username?: string,
): string {
  switch (type) {
    case "you":
      if (username && username !== "Guest") {
        return index === 0 ? `${username} (You)` : `${username} (Also You)`;
      }
      return index === 0 ? "You" : "Also You";
    case "friend":
      return "Friend";
    case "matched-user":
      return "Matched Player";
    default:
      return `Player ${index + 1}`;
  }
}

export function actionsEqual(a: Action, b: Action): boolean {
  if (a.type !== b.type) return false;
  if (a.target[0] !== b.target[0] || a.target[1] !== b.target[1]) return false;
  if (a.type === "wall") {
    return a.wallOrientation === b.wallOrientation;
  }
  return true;
}

export function buildDoubleStepPaths(
  pawnType: GamePawnType,
  from: Cell,
  to: Cell,
): Action[][] {
  const paths: Action[][] = [];
  const rowDiff = Math.abs(from[0] - to[0]);
  const colDiff = Math.abs(from[1] - to[1]);
  const distance = rowDiff + colDiff;
  if (distance !== 2) {
    return paths;
  }

  if (from[0] === to[0]) {
    // Horizontal double step
    const midCol = (from[1] + to[1]) / 2;
    paths.push([
      { type: pawnType, target: [from[0], midCol] },
      { type: pawnType, target: to },
    ]);
    return paths;
  }

  if (from[1] === to[1]) {
    // Vertical double step
    const midRow = (from[0] + to[0]) / 2;
    paths.push([
      { type: pawnType, target: [midRow, from[1]] },
      { type: pawnType, target: to },
    ]);
    return paths;
  }

  // L-shaped double step (one row, one column)
  paths.push([
    { type: pawnType, target: [from[0], to[1]] },
    { type: pawnType, target: to },
  ]);
  paths.push([
    { type: pawnType, target: [to[0], from[1]] },
    { type: pawnType, target: to },
  ]);
  return paths;
}

export function formatWinReason(reason?: GameResult["reason"]): string {
  switch (reason) {
    case "capture":
      return "capture";
    case "timeout":
      return "timeout";
    case "resignation":
      return "resignation";
    case "draw-agreement":
      return "draw";
    case "one-move-rule":
      return "one-move rule";
    case "survival":
      return "survival";
    case "aborted":
      return "abort";
    default:
      return "unknown reason";
  }
}

export function sanitizePlayerList(
  players: PlayerType[],
  options?: { forceYouFirst?: boolean },
): PlayerType[] {
  const { forceYouFirst = true } = options ?? {};
  const list = players.slice(0, 2);
  if (!list.includes("you")) {
    if (list.length === 0) {
      list.push("you");
    } else {
      list[0] = "you";
    }
  }
  while (list.length < 2) {
    list.push("you");
  }
  if (forceYouFirst && list.indexOf("you") === 1) {
    [list[0], list[1]] = [list[1], list[0]];
  }
  return list;
}
