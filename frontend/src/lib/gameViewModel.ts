import type { BoardProps } from "@/components/board";
import type {
  PlayerId,
  GameResult,
  Cell,
  PawnType,
  Action,
  GameConfiguration,
} from "../../../shared/game-types";
import { GameState } from "../../../shared/game-state";
import type { GameSnapshot } from "../../../shared/game-types";
import { PLAYER_COLORS, type PlayerColor } from "@/lib/player-colors";

export type PlayerType =
  | "you"
  | "friend"
  | "matched-user"
  | "easy-bot"
  | "medium-bot"
  | "hard-bot"
  | "custom-bot";

// ============================================================================
// View Model Architecture
// ============================================================================
// The GameViewModel is the single source of truth for all server-controlled
// game state. All server updates flow through a single entry point, and all
// UI state is derived from this model plus local preferences.

export interface GameViewModel {
  // Game configuration (board size, time control, etc.)
  config: GameConfiguration | null;
  // Current game state (board, turn, clocks, history)
  gameState: GameState | null;
  // Match/lobby metadata (players, readiness, appearances)
  match: GameSnapshot | null;
  // Last move arrows to display on the board
  lastMoves: BoardProps["lastMoves"] | null;
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
  initialized: false,
};

const DEFAULT_PLAYER_COLORS: Record<PlayerId, PlayerColor> = {
  1: "red",
  2: "blue",
};

// ============================================================================
// Server Update Logic
// ============================================================================

/**
 * Computes the last moves by diffing previous and new game state.
 * Returns arrows to display on the board.
 */
export function computeLastMoves(
  before: GameState | null,
  after: GameState,
  playerColorsForBoard: Record<PlayerId, PlayerColor>,
): BoardProps["lastMoves"] | null {
  if (!before) return null;
  const moves: NonNullable<BoardProps["lastMoves"]> = [];
  (Object.keys(after.pawns) as unknown as PlayerId[]).forEach((playerId) => {
    const playerColor =
      playerColorsForBoard[playerId] ?? DEFAULT_PLAYER_COLORS[playerId];
    const beforePawns = before.pawns[playerId];
    const afterPawns = after.pawns[playerId];
    // Cat
    const catBefore = beforePawns.cat;
    const catAfter = afterPawns.cat;
    if (catBefore[0] !== catAfter[0] || catBefore[1] !== catAfter[1]) {
      moves.push({
        fromRow: catBefore[0],
        fromCol: catBefore[1],
        toRow: catAfter[0],
        toCol: catAfter[1],
        playerColor,
      });
    }
    // Mouse
    const mouseBefore = beforePawns.mouse;
    const mouseAfter = afterPawns.mouse;
    if (mouseBefore[0] !== mouseAfter[0] || mouseBefore[1] !== mouseAfter[1]) {
      moves.push({
        fromRow: mouseBefore[0],
        fromCol: mouseBefore[1],
        toRow: mouseAfter[0],
        toCol: mouseAfter[1],
        playerColor,
      });
    }
  });
  return moves.length ? moves : null;
}

/**
 * Applies a server update to the view model.
 * This is the single entry point for all server-controlled state updates.
 */
export function applyServerUpdate(
  prev: GameViewModel,
  update: ServerUpdate,
  playerColorsForBoard: Record<PlayerId, PlayerColor>,
): GameViewModel {
  switch (update.type) {
    case "game-state": {
      // Compute last moves by diffing previous and new game state
      const before = prev.gameState;
      const lastMoves = computeLastMoves(
        before,
        update.gameState,
        playerColorsForBoard,
      );
      return {
        ...prev,
        config: update.config,
        gameState: update.gameState,
        lastMoves,
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
    case "easy-bot":
      return "Easy Bot";
    case "medium-bot":
      return "Medium Bot";
    case "hard-bot":
      return "Hard Bot";
    case "custom-bot":
      return "Custom Bot";
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
  pawnType: PawnType,
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
    list.push("easy-bot");
  }
  if (forceYouFirst && list.indexOf("you") === 1) {
    [list[0], list[1]] = [list[1], list[0]];
  }
  return list;
}

export function resolvePlayerColor(value?: string | null): PlayerColor {
  if (!value || value === "default") {
    return "red";
  }
  return PLAYER_COLORS.includes(value as PlayerColor)
    ? (value as PlayerColor)
    : "red";
}
