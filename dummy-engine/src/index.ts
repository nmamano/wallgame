#!/usr/bin/env bun
/**
 * Wall Game Dummy Engine (v3)
 *
 * A reference implementation of the V3 Bot Game Session (BGS) protocol.
 * This engine is long-lived: it reads JSON-lines from stdin and writes responses to stdout.
 * Each line is a complete JSON message.
 *
 * V3 Protocol Flow:
 * 1. Engine starts and waits for messages on stdin
 * 2. Client sends start_game_session → engine responds with game_session_started
 * 3. Client sends evaluate_position → engine responds with evaluate_response
 * 4. Client sends apply_move → engine responds with move_applied
 * 5. Client sends end_game_session → engine responds with game_session_ended
 *
 * The engine maintains game state across moves within each session, enabling
 * more sophisticated engines to persist MCTS trees and evaluation caches.
 */

import { computeDummyAiMove } from "../../shared/domain/dummy-ai";
import { moveToStandardNotation } from "../../shared/domain/standard-notation";
import { moveFromStandardNotation } from "../../shared/domain/standard-notation";
import { Grid } from "../../shared/domain/grid";
import type {
  Cell,
  PlayerId,
  GameInitialState,
  StandardInitialState,
  ClassicInitialState,
  SurvivalInitialState,
  Variant,
} from "../../shared/domain/game-types";
import type {
  EngineRequestV3,
  EngineResponseV3,
  BgsConfig,
} from "../../shared/custom-bot/engine-api";
import {
  createGameSessionStartedResponse,
  createGameSessionEndedResponse,
  createEvaluateResponse,
  createMoveAppliedResponse,
} from "../../shared/custom-bot/engine-api";

// ============================================================================
// Session State
// ============================================================================

/**
 * State for a single Bot Game Session.
 * The dummy engine maintains a simplified view of the game state
 * sufficient for computing moves using the dummy AI.
 */
interface DummyBgsState {
  bgsId: string;
  variant: Variant;
  boardWidth: number;
  boardHeight: number;
  grid: Grid;
  /** Pawn positions for both players */
  pawns: Record<PlayerId, { cat: Cell; mouse: Cell }>;
  /** Current ply (0 = initial position, increments after each move) */
  ply: number;
}

/**
 * Map of active BGS sessions keyed by bgsId.
 * The V3 protocol allows multiple concurrent sessions per engine.
 */
const sessions = new Map<string, DummyBgsState>();

// ============================================================================
// Initial State Type Guards
// ============================================================================

function isStandardInitialState(
  state: GameInitialState,
): state is StandardInitialState {
  return (
    "pawns" in state && "mouse" in (state as StandardInitialState).pawns.p1
  );
}

function isClassicInitialState(
  state: GameInitialState,
): state is ClassicInitialState {
  return "pawns" in state && "home" in (state as ClassicInitialState).pawns.p1;
}

function isSurvivalInitialState(
  state: GameInitialState,
): state is SurvivalInitialState {
  return "turnsToSurvive" in state;
}

// ============================================================================
// Session Creation
// ============================================================================

/**
 * Create a new BGS state from the provided configuration.
 * Initializes the grid, pawns, and initial walls from the BgsConfig.
 */
function createSession(bgsId: string, config: BgsConfig): DummyBgsState {
  const { variant, boardWidth, boardHeight, initialState } = config;

  // Create grid with initial walls
  const grid = new Grid(boardWidth, boardHeight, variant);
  for (const wall of initialState.walls) {
    grid.addWall(wall);
  }

  // Initialize pawns based on variant type
  let pawns: Record<PlayerId, { cat: Cell; mouse: Cell }>;

  if (isSurvivalInitialState(initialState)) {
    // Survival has flat cat/mouse structure (single cat chases single mouse)
    pawns = {
      1: {
        cat: [initialState.cat[0], initialState.cat[1]],
        mouse: [boardHeight - 1, 0], // P1 mouse not used in survival
      },
      2: {
        cat: [0, boardWidth - 1], // P2 cat not used in survival
        mouse: [initialState.mouse[0], initialState.mouse[1]],
      },
    };
  } else if (isClassicInitialState(initialState)) {
    // Classic has cat/home structure - store home in mouse slot
    pawns = {
      1: {
        cat: [initialState.pawns.p1.cat[0], initialState.pawns.p1.cat[1]],
        mouse: [initialState.pawns.p1.home[0], initialState.pawns.p1.home[1]],
      },
      2: {
        cat: [initialState.pawns.p2.cat[0], initialState.pawns.p2.cat[1]],
        mouse: [initialState.pawns.p2.home[0], initialState.pawns.p2.home[1]],
      },
    };
  } else {
    // Standard/Freestyle have cat/mouse structure
    pawns = {
      1: {
        cat: [initialState.pawns.p1.cat[0], initialState.pawns.p1.cat[1]],
        mouse: [initialState.pawns.p1.mouse[0], initialState.pawns.p1.mouse[1]],
      },
      2: {
        cat: [initialState.pawns.p2.cat[0], initialState.pawns.p2.cat[1]],
        mouse: [initialState.pawns.p2.mouse[0], initialState.pawns.p2.mouse[1]],
      },
    };
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
// Move Application
// ============================================================================

/**
 * Apply a move to the session state.
 * Updates pawn positions, walls, and increments the ply counter.
 */
function applyMoveToSession(
  session: DummyBgsState,
  moveNotation: string,
): void {
  const move = moveFromStandardNotation(moveNotation, session.boardHeight);

  // Determine whose turn it is (P1 moves on even plies, P2 on odd plies)
  const currentPlayer: PlayerId = session.ply % 2 === 0 ? 1 : 2;

  for (const action of move.actions) {
    if (action.type === "cat") {
      session.pawns[currentPlayer].cat = [action.target[0], action.target[1]];
    } else if (action.type === "mouse") {
      session.pawns[currentPlayer].mouse = [action.target[0], action.target[1]];
    } else if (action.type === "wall" && action.wallOrientation) {
      session.grid.addWall({
        cell: action.target,
        orientation: action.wallOrientation,
        playerId: currentPlayer,
      });
    }
  }

  session.ply += 1;
}

// ============================================================================
// Move Computation
// ============================================================================

/**
 * Get the goal position for a player based on the variant.
 */
function getGoalPos(session: DummyBgsState, player: PlayerId): Cell {
  const opponent: PlayerId = player === 1 ? 2 : 1;
  if (session.variant === "classic") {
    // In classic, the goal is own home (stored in mouse slot)
    return session.pawns[player].mouse;
  } else {
    // In standard/freestyle/survival, the goal is opponent's mouse
    return session.pawns[opponent].mouse;
  }
}

/**
 * Compute the best move for the current position.
 * Uses the dummy AI which walks the cat toward its goal.
 */
function computeBestMove(session: DummyBgsState): string {
  // Determine whose turn it is
  const currentPlayer: PlayerId = session.ply % 2 === 0 ? 1 : 2;
  const myCatPos = session.pawns[currentPlayer].cat;
  const goalPos = getGoalPos(session, currentPlayer);

  const move = computeDummyAiMove(session.grid, myCatPos, goalPos);
  return moveToStandardNotation(move, session.boardHeight);
}

/**
 * Compute a simple distance-based evaluation.
 * Returns evaluation from P1's perspective:
 *   +0.5 if P1 is closer to their goal
 *    0.0 if both players are equidistant
 *   -0.5 if P2 is closer to their goal
 */
function computeEvaluation(session: DummyBgsState): number {
  const p1CatPos = session.pawns[1].cat;
  const p2CatPos = session.pawns[2].cat;
  const p1Goal = getGoalPos(session, 1);
  const p2Goal = getGoalPos(session, 2);

  const p1Distance = session.grid.distance(p1CatPos, p1Goal);
  const p2Distance = session.grid.distance(p2CatPos, p2Goal);

  // Handle unreachable cases (shouldn't happen in normal games)
  if (p1Distance === -1 && p2Distance === -1) return 0;
  if (p1Distance === -1) return -0.5; // P1 can't reach, P2 advantage
  if (p2Distance === -1) return 0.5; // P2 can't reach, P1 advantage

  if (p1Distance < p2Distance) return 0.5;
  if (p2Distance < p1Distance) return -0.5;
  return 0;
}

// ============================================================================
// Request Handlers
// ============================================================================

function handleStartGameSession(
  bgsId: string,
  _botId: string,
  config: BgsConfig,
): EngineResponseV3 {
  try {
    const session = createSession(bgsId, config);
    sessions.set(bgsId, session);
    return createGameSessionStartedResponse(bgsId, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createGameSessionStartedResponse(bgsId, false, message);
  }
}

function handleEndGameSession(bgsId: string): EngineResponseV3 {
  const session = sessions.get(bgsId);
  if (!session) {
    return createGameSessionEndedResponse(
      bgsId,
      false,
      `Session ${bgsId} not found`,
    );
  }

  sessions.delete(bgsId);
  return createGameSessionEndedResponse(bgsId, true);
}

function handleEvaluatePosition(
  bgsId: string,
  expectedPly: number,
): EngineResponseV3 {
  const session = sessions.get(bgsId);
  if (!session) {
    return createEvaluateResponse(
      bgsId,
      expectedPly,
      "",
      0,
      false,
      `Session ${bgsId} not found`,
    );
  }

  // Validate ply matches expected
  if (session.ply !== expectedPly) {
    return createEvaluateResponse(
      bgsId,
      session.ply,
      "",
      0,
      false,
      `Ply mismatch: expected ${expectedPly}, got ${session.ply}`,
    );
  }

  const bestMove = computeBestMove(session);
  const evaluation = computeEvaluation(session);

  return createEvaluateResponse(bgsId, session.ply, bestMove, evaluation);
}

function handleApplyMove(
  bgsId: string,
  expectedPly: number,
  moveNotation: string,
): EngineResponseV3 {
  const session = sessions.get(bgsId);
  if (!session) {
    return createMoveAppliedResponse(
      bgsId,
      expectedPly,
      false,
      `Session ${bgsId} not found`,
    );
  }

  // Validate ply matches expected
  if (session.ply !== expectedPly) {
    return createMoveAppliedResponse(
      bgsId,
      session.ply,
      false,
      `Ply mismatch: expected ${expectedPly}, got ${session.ply}`,
    );
  }

  try {
    applyMoveToSession(session, moveNotation);
    return createMoveAppliedResponse(bgsId, session.ply);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createMoveAppliedResponse(bgsId, session.ply, false, message);
  }
}

// ============================================================================
// Request Router
// ============================================================================

function handleRequest(request: EngineRequestV3): EngineResponseV3 {
  switch (request.type) {
    case "start_game_session":
      return handleStartGameSession(
        request.bgsId,
        request.botId,
        request.config,
      );

    case "end_game_session":
      return handleEndGameSession(request.bgsId);

    case "evaluate_position":
      return handleEvaluatePosition(request.bgsId, request.expectedPly);

    case "apply_move":
      return handleApplyMove(request.bgsId, request.expectedPly, request.move);

    default: {
      // TypeScript exhaustiveness check - this should never happen
      const _exhaustive: never = request;
      throw new Error(`Unknown request type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ============================================================================
// Main Loop
// ============================================================================

/**
 * Read lines from stdin asynchronously.
 * Yields one line at a time (without the newline character).
 */
async function* readLines(): AsyncGenerator<string> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        // Yield any remaining content in buffer
        if (buffer.trim()) {
          yield buffer;
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.trim()) {
          yield line;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function main(): Promise<void> {
  // V3: Read JSON lines continuously (long-lived process)
  for await (const line of readLines()) {
    try {
      const request = JSON.parse(line) as EngineRequestV3;
      const response = handleRequest(request);
      // Write response as a single JSON line
      process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      // Log parsing errors to stderr (don't crash the engine)
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Dummy engine error: ${message}`);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Dummy engine fatal error: ${message}`);
  process.exit(1);
});
