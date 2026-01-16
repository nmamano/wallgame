/**
 * Dumb Bot - A simple fallback AI for testing (V3)
 *
 * This bot walks its cat towards the opponent's mouse without placing walls.
 * It's used when no external engine is provided.
 *
 * V3: Maintains stateful sessions like a real engine, but with simple logic.
 */

import type { Cell, PlayerId, Variant } from "../../shared/domain/game-types";
import { Grid } from "../../shared/domain/grid";
import { computeDummyAiMove } from "../../shared/domain/dummy-ai";
import {
  moveFromStandardNotation,
  moveToStandardNotation,
} from "../../shared/domain/standard-notation";
import type {
  BgsConfig,
  StartGameSessionMessage,
  EndGameSessionMessage,
  EvaluatePositionMessage,
  ApplyMoveMessage,
  GameSessionStartedMessage,
  GameSessionEndedMessage,
  EvaluateResponseMessage,
  MoveAppliedMessage,
} from "../../shared/contracts/custom-bot-protocol";
import { logger } from "./logger";

// ============================================================================
// Session State
// ============================================================================

interface DumbBotSession {
  bgsId: string;
  variant: Variant;
  boardWidth: number;
  boardHeight: number;
  grid: Grid; // Grid with pathfinding support
  pawns: {
    p1: { cat: Cell; mouse: Cell };
    p2: { cat: Cell; mouse: Cell };
  };
  ply: number;
}

const sessions = new Map<string, DumbBotSession>();

// ============================================================================
// Session Management
// ============================================================================

function createSession(bgsId: string, config: BgsConfig): DumbBotSession {
  const { variant, boardWidth, boardHeight, initialState } = config;

  // Initialize Grid with pathfinding support
  const grid = new Grid(boardWidth, boardHeight, variant);

  // Extract pawn positions based on variant
  let pawns: DumbBotSession["pawns"];

  if (variant === "survival") {
    // Survival has flat cat/mouse structure
    const survivalState = initialState as {
      cat: Cell;
      mouse: Cell;
      walls: Cell[];
    };
    pawns = {
      p1: { cat: survivalState.cat, mouse: survivalState.mouse },
      p2: { cat: survivalState.cat, mouse: survivalState.mouse }, // Survival is 1-player
    };
    // Apply initial walls
    for (const wall of survivalState.walls || []) {
      grid.addWall(wall);
    }
  } else if (variant === "classic") {
    // Classic has cat/home structure (home stored in mouse slot for compatibility)
    const classicState = initialState as {
      pawns: { p1: { cat: Cell; home: Cell }; p2: { cat: Cell; home: Cell } };
      walls: Cell[];
    };
    pawns = {
      p1: { cat: classicState.pawns.p1.cat, mouse: classicState.pawns.p1.home },
      p2: { cat: classicState.pawns.p2.cat, mouse: classicState.pawns.p2.home },
    };
    // Apply initial walls
    for (const wall of classicState.walls || []) {
      grid.addWall(wall);
    }
  } else {
    // Standard/Freestyle have cat/mouse structure
    const standardState = initialState as {
      pawns: {
        p1: { cat: Cell; mouse: Cell };
        p2: { cat: Cell; mouse: Cell };
      };
      walls: Cell[];
    };
    pawns = {
      p1: standardState.pawns.p1,
      p2: standardState.pawns.p2,
    };
    // Apply initial walls
    for (const wall of standardState.walls || []) {
      grid.addWall(wall);
    }
  }

  return {
    bgsId,
    variant,
    boardWidth,
    boardHeight,
    grid,
    pawns,
    ply: 0,
  };
}

// ============================================================================
// V3 Message Handlers
// ============================================================================

export function handleStartGameSession(
  msg: StartGameSessionMessage,
): GameSessionStartedMessage {
  logger.debug(`[dumb-bot] Starting session ${msg.bgsId}`);

  try {
    const session = createSession(msg.bgsId, msg.config);
    sessions.set(msg.bgsId, session);

    return {
      type: "game_session_started",
      bgsId: msg.bgsId,
      success: true,
      error: "",
    };
  } catch (error) {
    logger.error(`[dumb-bot] Failed to start session:`, error);
    return {
      type: "game_session_started",
      bgsId: msg.bgsId,
      success: false,
      error: String(error),
    };
  }
}

export function handleEndGameSession(
  msg: EndGameSessionMessage,
): GameSessionEndedMessage {
  logger.debug(`[dumb-bot] Ending session ${msg.bgsId}`);

  sessions.delete(msg.bgsId);

  return {
    type: "game_session_ended",
    bgsId: msg.bgsId,
    success: true,
    error: "",
  };
}

export function handleEvaluatePosition(
  msg: EvaluatePositionMessage,
): EvaluateResponseMessage {
  const session = sessions.get(msg.bgsId);

  if (!session) {
    logger.error(`[dumb-bot] Session not found: ${msg.bgsId}`);
    return {
      type: "evaluate_response",
      bgsId: msg.bgsId,
      ply: msg.expectedPly,
      bestMove: "",
      evaluation: 0,
      success: false,
      error: `Session not found: ${msg.bgsId}`,
    };
  }

  // Validate ply matches expected
  if (session.ply !== msg.expectedPly) {
    logger.error(`[dumb-bot] Ply mismatch: expected ${msg.expectedPly}, got ${session.ply}`);
    return {
      type: "evaluate_response",
      bgsId: msg.bgsId,
      ply: session.ply,
      bestMove: "",
      evaluation: 0,
      success: false,
      error: `Ply mismatch: expected ${msg.expectedPly}, got ${session.ply}`,
    };
  }

  logger.debug(`[dumb-bot] Evaluating position:`, {
    bgsId: msg.bgsId,
    ply: session.ply,
  });

  // Compute the best move using the shared dummy AI logic
  const currentPlayer: PlayerId = session.ply % 2 === 0 ? 1 : 2;
  const opponent: PlayerId = currentPlayer === 1 ? 2 : 1;

  const myCatPos = session.pawns[currentPlayer === 1 ? "p1" : "p2"].cat;

  // Determine goal based on variant:
  // - Standard/Freestyle/Survival: chase opponent's mouse
  // - Classic: reach own home (stored in mouse slot)
  let goalPos: Cell;
  if (session.variant === "classic") {
    goalPos = session.pawns[currentPlayer === 1 ? "p1" : "p2"].mouse;
  } else {
    goalPos = session.pawns[opponent === 1 ? "p1" : "p2"].mouse;
  }

  const move = computeDummyAiMove(session.grid, myCatPos, goalPos);
  const bestMove = moveToStandardNotation(move, session.boardHeight);

  return {
    type: "evaluate_response",
    bgsId: msg.bgsId,
    ply: session.ply,
    bestMove,
    evaluation: 0, // Dumb bot always returns neutral evaluation
    success: true,
    error: "",
  };
}

export function handleApplyMove(msg: ApplyMoveMessage): MoveAppliedMessage {
  const session = sessions.get(msg.bgsId);

  if (!session) {
    logger.error(`[dumb-bot] Session not found: ${msg.bgsId}`);
    return {
      type: "move_applied",
      bgsId: msg.bgsId,
      ply: msg.expectedPly + 1,
      success: false,
      error: `Session not found: ${msg.bgsId}`,
    };
  }

  // Validate ply matches expected
  if (session.ply !== msg.expectedPly) {
    logger.error(`[dumb-bot] Ply mismatch on apply: expected ${msg.expectedPly}, got ${session.ply}`);
    return {
      type: "move_applied",
      bgsId: msg.bgsId,
      ply: session.ply,
      success: false,
      error: `Ply mismatch: expected ${msg.expectedPly}, got ${session.ply}`,
    };
  }

  try {
    // Determine whose turn it is
    const playerToMove: PlayerId = session.ply % 2 === 0 ? 1 : 2;
    const pawns = playerToMove === 1 ? session.pawns.p1 : session.pawns.p2;

    // Parse the move from standard notation
    const move = moveFromStandardNotation(msg.move, session.boardHeight);

    // Apply each action
    for (const action of move.actions) {
      if (action.type === "cat") {
        pawns.cat = action.target;
      } else if (action.type === "mouse") {
        pawns.mouse = action.target;
      } else if (action.type === "wall") {
        session.grid.addWall(action.target);
      }
    }

    // Update session state
    session.ply += 1;

    logger.debug(`[dumb-bot] Move applied:`, {
      bgsId: msg.bgsId,
      move: msg.move,
      newPly: session.ply,
    });

    return {
      type: "move_applied",
      bgsId: msg.bgsId,
      ply: session.ply,
      success: true,
      error: "",
    };
  } catch (error) {
    logger.error(`[dumb-bot] Failed to apply move:`, error);
    return {
      type: "move_applied",
      bgsId: msg.bgsId,
      ply: session.ply,
      success: false,
      error: String(error),
    };
  }
}

// ============================================================================
// Utility
// ============================================================================

export function hasSession(bgsId: string): boolean {
  return sessions.has(bgsId);
}

export function clearAllSessions(): void {
  sessions.clear();
}
