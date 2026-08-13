/**
 * Dumb Bot - A simple fallback AI for testing (V3)
 *
 * This bot walks its cat towards the opponent's mouse without placing walls.
 * It's used when no external engine is provided.
 *
 * V3: Maintains stateful sessions like a real engine, but with simple logic.
 */

import type {
  Cell,
  AnimalCycleInitialState,
  GamePawns,
  ClassicInitialState,
  PlayerId,
  StandardInitialState,
  SurvivalInitialState,
  Variant,
} from "../../shared/domain/game-types";
import { Grid } from "../../shared/domain/grid";
import { computeDummyAiMove } from "../../shared/domain/dummy-ai";
import { computeAnimalCycleNaiveMove } from "../../shared/domain/animal-cycle-ai";
import {
  pawnCell,
  requirePawnCell,
  withPawnCell,
} from "../../shared/domain/pawns";
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
  pawns: GamePawns;
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
  let pawns: GamePawns;

  if (variant === "survival") {
    // Survival has flat cat/mouse structure
    const survivalState = initialState as SurvivalInitialState;
    pawns = {
      kind: "survival",
      cat: survivalState.cat,
      mouse: survivalState.mouse,
    };
    // Apply initial walls
    for (const wall of survivalState.walls || []) {
      grid.addWall(wall);
    }
  } else if (variant === "classic") {
    // Classic has cat/home structure (home stored in mouse slot for compatibility)
    const classicState = initialState as ClassicInitialState;
    pawns = {
      kind: "classic",
      pawns: {
        1: classicState.pawns.p1,
        2: classicState.pawns.p2,
      },
    };
    // Apply initial walls
    for (const wall of classicState.walls || []) {
      grid.addWall(wall);
    }
  } else if (variant === "animal-cycle") {
    const cycleState = initialState as AnimalCycleInitialState;
    pawns = {
      kind: "animal-cycle",
      pawns: { 1: cycleState.pawns.p1, 2: cycleState.pawns.p2 },
    };
    for (const wall of cycleState.walls) grid.addWall(wall);
  } else {
    // Standard/Freestyle have cat/mouse structure
    const standardState = initialState as StandardInitialState;
    pawns = {
      kind: "standard",
      pawns: { 1: standardState.pawns.p1, 2: standardState.pawns.p2 },
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
    logger.error(
      `[dumb-bot] Ply mismatch: expected ${msg.expectedPly}, got ${session.ply}`,
    );
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

  if (session.pawns.kind === "animal-cycle") {
    const move = computeAnimalCycleNaiveMove(
      session.grid,
      session.pawns,
      currentPlayer,
    );
    return {
      type: "evaluate_response",
      bgsId: msg.bgsId,
      ply: session.ply,
      bestMove: moveToStandardNotation(move, session.boardHeight),
      evaluation: 0,
      success: true,
      error: "",
    };
  }

  const myCatPos = requirePawnCell(session.pawns, currentPlayer, "cat");

  // Determine goal based on variant:
  // - Standard/Freestyle/Survival: chase opponent's mouse
  // - Classic: reach own home (stored in mouse slot)
  let goalPos: Cell;
  if (session.variant === "classic") {
    goalPos = requirePawnCell(session.pawns, currentPlayer, "home");
  } else {
    goalPos = requirePawnCell(session.pawns, opponent, "mouse");
  }

  const move = computeDummyAiMove(session.grid, myCatPos, goalPos);
  const bestMove = moveToStandardNotation(move, session.boardHeight);

  // Compute distance-based evaluation from P1's perspective
  const evaluation = computeDistanceEvaluation(session);

  return {
    type: "evaluate_response",
    bgsId: msg.bgsId,
    ply: session.ply,
    bestMove,
    evaluation,
    success: true,
    error: "",
  };
}

/**
 * Compute a simple distance-based evaluation.
 * Returns evaluation from P1's perspective:
 *   +0.5 if P1 is closer to their goal
 *    0.0 if both players are equidistant
 *   -0.5 if P2 is closer to their goal
 */
function computeDistanceEvaluation(session: DumbBotSession): number {
  if (session.pawns.kind === "animal-cycle") return 0;
  const p1CatPos = requirePawnCell(session.pawns, 1, "cat");
  const p2CatPos = pawnCell(session.pawns, 2, "cat") ?? p1CatPos;

  // Determine goals based on variant
  let p1Goal: Cell;
  let p2Goal: Cell;
  if (session.variant === "classic") {
    p1Goal = requirePawnCell(session.pawns, 1, "home");
    p2Goal = requirePawnCell(session.pawns, 2, "home");
  } else {
    p1Goal = requirePawnCell(session.pawns, 2, "mouse");
    p2Goal = requirePawnCell(session.pawns, 1, "mouse");
  }

  const p1Distance = session.grid.distance(p1CatPos, p1Goal);
  const p2Distance = session.grid.distance(p2CatPos, p2Goal);

  // Handle unreachable cases
  if (p1Distance === -1 && p2Distance === -1) return 0;
  if (p1Distance === -1) return -0.5;
  if (p2Distance === -1) return 0.5;

  if (p1Distance < p2Distance) return 0.5;
  if (p2Distance < p1Distance) return -0.5;
  return 0;
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
    logger.error(
      `[dumb-bot] Ply mismatch on apply: expected ${msg.expectedPly}, got ${session.ply}`,
    );
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
    // Parse the move from standard notation
    const move = moveFromStandardNotation(msg.move, session.boardHeight);

    // Apply each action
    for (const action of move.actions) {
      if (action.type !== "wall") {
        session.pawns = withPawnCell(
          session.pawns,
          playerToMove,
          action.type,
          action.target,
        );
      } else if (action.wallOrientation) {
        session.grid.addWall({
          cell: action.target,
          orientation: action.wallOrientation,
          playerId: playerToMove,
        });
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
