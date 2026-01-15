/**
 * Engine API Types (v3)
 *
 * V3 engines are long-lived processes that communicate via JSON-lines over stdin/stdout.
 * Each line is a complete JSON message.
 *
 * V3 Protocol Flow:
 * 1. Engine starts and waits for messages on stdin
 * 2. Client sends start_game_session → engine responds with game_session_started
 * 3. Client sends evaluate_position → engine responds with evaluate_response
 * 4. Client sends apply_move → engine responds with move_applied
 * 5. Client sends end_game_session → engine responds with game_session_ended
 * 6. Engine may handle multiple concurrent sessions (identified by bgsId)
 *
 * The engine maintains game state and MCTS trees across moves within each session.
 * This enables tree reuse: when apply_move is called, the engine prunes the MCTS
 * tree to the subtree rooted at the played move, preserving search work.
 */


// Re-export V3 BGS types from custom-bot-protocol
// These are the same types used for server ↔ client communication
export {
  // Protocol version
  CUSTOM_BOT_PROTOCOL_VERSION,

  // BGS Configuration
  type BgsConfig,

  // Server → Engine messages (requests)
  type StartGameSessionMessage,
  type EndGameSessionMessage,
  type EvaluatePositionMessage,
  type ApplyMoveMessage,
  type BgsServerMessage,

  // Engine → Server messages (responses)
  type GameSessionStartedMessage,
  type GameSessionEndedMessage,
  type EvaluateResponseMessage,
  type MoveAppliedMessage,
} from "../contracts/custom-bot-protocol";

// ============================================================================
// Engine API Version
// ============================================================================

export const ENGINE_API_VERSION = 3;

// ============================================================================
// Evaluation Range
// ============================================================================

/**
 * Evaluation values represent the position assessment from P1's perspective.
 * Range: [-1.0, +1.0]
 *   +1.0 = P1 is winning
 *    0.0 = Even position
 *   -1.0 = P2 is winning (P1 is losing)
 *
 * IMPORTANT: All evaluations must be from P1's perspective, regardless of
 * which player the engine is playing as. This ensures consistent display
 * in the UI evaluation bar.
 *
 * Values outside this range will be clamped by the bot client.
 */
export const EVALUATION_MIN = -1.0;
export const EVALUATION_MAX = 1.0;

/** Clamp evaluation to valid range [-1, +1] */
export function clampEvaluation(value: number): number {
  return Math.max(EVALUATION_MIN, Math.min(EVALUATION_MAX, value));
}

// ============================================================================
// V3 Engine Message Types
// ============================================================================

/**
 * Messages the engine receives from the client (via stdin).
 * These are requests that the engine must respond to.
 */
export type EngineRequestV3 =
  | import("../contracts/custom-bot-protocol").StartGameSessionMessage
  | import("../contracts/custom-bot-protocol").EndGameSessionMessage
  | import("../contracts/custom-bot-protocol").EvaluatePositionMessage
  | import("../contracts/custom-bot-protocol").ApplyMoveMessage;

/**
 * Messages the engine sends to the client (via stdout).
 * These are responses to client requests.
 */
export type EngineResponseV3 =
  | import("../contracts/custom-bot-protocol").GameSessionStartedMessage
  | import("../contracts/custom-bot-protocol").GameSessionEndedMessage
  | import("../contracts/custom-bot-protocol").EvaluateResponseMessage
  | import("../contracts/custom-bot-protocol").MoveAppliedMessage;

// ============================================================================
// BGS History Entry (for engine-side tracking)
// ============================================================================

/**
 * History entry for a position in a Bot Game Session.
 * Engines may maintain this internally to track evaluations.
 */
export interface BgsHistoryEntry {
  /** Ply number: 0 = initial position, increments after each move */
  ply: number;
  /** Position evaluation from P1's perspective: +1 = P1 winning, 0 = even, -1 = P2 winning */
  evaluation: number;
  /** Best move for the side-to-move at this ply (standard notation) */
  bestMove: string;
}

// ============================================================================
// V3 Helper Functions
// ============================================================================

/**
 * Create a game_session_started response message.
 */
export function createGameSessionStartedResponse(
  bgsId: string,
  success: boolean,
  error = "",
): import("../contracts/custom-bot-protocol").GameSessionStartedMessage {
  return {
    type: "game_session_started",
    bgsId,
    success,
    error,
  };
}

/**
 * Create a game_session_ended response message.
 */
export function createGameSessionEndedResponse(
  bgsId: string,
  success: boolean,
  error = "",
): import("../contracts/custom-bot-protocol").GameSessionEndedMessage {
  return {
    type: "game_session_ended",
    bgsId,
    success,
    error,
  };
}

/**
 * Create an evaluate_response message.
 */
export function createEvaluateResponse(
  bgsId: string,
  ply: number,
  bestMove: string,
  evaluation: number,
  success = true,
  error = "",
): import("../contracts/custom-bot-protocol").EvaluateResponseMessage {
  return {
    type: "evaluate_response",
    bgsId,
    ply,
    bestMove,
    evaluation: clampEvaluation(evaluation),
    success,
    error,
  };
}

/**
 * Create a move_applied response message.
 */
export function createMoveAppliedResponse(
  bgsId: string,
  ply: number,
  success = true,
  error = "",
): import("../contracts/custom-bot-protocol").MoveAppliedMessage {
  return {
    type: "move_applied",
    bgsId,
    ply,
    success,
    error,
  };
}

