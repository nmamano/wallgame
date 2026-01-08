/**
 * Evaluation Bar WebSocket Protocol
 *
 * This protocol enables clients to request position evaluations from
 * official bots. It uses a separate WebSocket connection from the game
 * connection, allowing spectators and replay viewers to get evaluations.
 *
 * Connection flow:
 * 1. Client connects to /ws/eval/:gameId
 * 2. Client sends handshake request with variant info
 * 3. Server validates access and finds an official eval bot
 * 4. Server accepts or rejects the handshake
 * 5. Client can then request evaluations for positions
 */

import type { SerializedGameState, Variant } from "../domain/game-types";

// ============================================================================
// Client -> Server Messages
// ============================================================================

/** Initial handshake to establish eval connection */
export interface EvalHandshakeRequest {
  type: "eval-handshake";
  /** The game ID this eval connection is for */
  gameId: string;
  /** The variant being played */
  variant: Variant;
  /** Board dimensions */
  boardWidth: number;
  boardHeight: number;
}

/** Request evaluation for a specific position */
export interface EvalPositionRequest {
  type: "eval-request";
  /** Client-generated request ID for matching responses */
  requestId: string;
  /** The game state to evaluate */
  state: SerializedGameState;
}

/** Ping to keep connection alive */
export interface EvalPing {
  type: "ping";
}

export type EvalClientMessage =
  | EvalHandshakeRequest
  | EvalPositionRequest
  | EvalPing;

// ============================================================================
// Server -> Client Messages
// ============================================================================

/** Handshake was successful, eval requests can now be made */
export interface EvalHandshakeAccepted {
  type: "eval-handshake-accepted";
}

export type EvalHandshakeRejectedCode =
  | "NO_BOT"
  | "RATED_PLAYER"
  | "UNSUPPORTED_VARIANT"
  | "GAME_NOT_FOUND";

/** Handshake was rejected */
export interface EvalHandshakeRejected {
  type: "eval-handshake-rejected";
  code: EvalHandshakeRejectedCode;
  message: string;
}

/** Successful evaluation response */
export interface EvalResponse {
  type: "eval-response";
  /** Matches the requestId from the request */
  requestId: string;
  /**
   * Position evaluation from P1's perspective.
   * Range: [-1, +1] where +1 = P1 winning, 0 = even, -1 = P2 winning.
   */
  evaluation: number;
  /** Best move in standard notation (for future use) */
  bestMove?: string;
}

export type EvalErrorCode =
  | "TIMEOUT"
  | "BOT_DISCONNECTED"
  | "INVALID_POSITION"
  | "NOT_CONNECTED"
  | "INTERNAL_ERROR";

/** Evaluation request failed */
export interface EvalError {
  type: "eval-error";
  /** Matches the requestId if this was for a specific request */
  requestId?: string;
  code: EvalErrorCode;
  message: string;
}

/** Pong response to ping */
export interface EvalPong {
  type: "pong";
}

export type EvalServerMessage =
  | EvalHandshakeAccepted
  | EvalHandshakeRejected
  | EvalResponse
  | EvalError
  | EvalPong;
