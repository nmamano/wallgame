/**
 * Evaluation Bar WebSocket Protocol
 *
 * This protocol enables clients to request position evaluations from
 * official bots. It uses a separate WebSocket connection from the game
 * connection, allowing spectators and replay viewers to get evaluations.
 *
 * V2 Connection flow (deprecated):
 * 1. Client connects to /ws/eval/:gameId
 * 2. Client sends handshake request with variant info
 * 3. Server validates access and finds an official eval bot
 * 4. Server accepts or rejects the handshake
 * 5. Client can then request evaluations for positions
 *
 * V3 Connection flow (BGS-based):
 * 1. Client connects to /ws/eval/:gameId
 * 2. Client sends handshake request with variant info
 * 3. Server validates access and creates/reuses a BGS for evaluation
 * 4. Server initializes BGS by replaying all moves (may take time for long games)
 * 5. Server sends eval-history with full evaluation history
 * 6. Server streams eval-update messages as new moves are made
 * 7. BGS is closed when game ends (live) or immediately after history sent (replays)
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

// ============================================================================
// V3 BGS-based Eval Messages (Server -> Client)
// ============================================================================

/**
 * Entry in the evaluation history.
 * Each entry represents the evaluation at a specific ply (position).
 */
export interface EvalHistoryEntry {
  /** Ply number: 0 = initial position, increments after each move */
  ply: number;
  /**
   * Position evaluation from P1's perspective.
   * Range: [-1, +1] where +1 = P1 winning, 0 = even, -1 = P2 winning.
   */
  evaluation: number;
  /** Best move for the side-to-move at this ply (standard notation) */
  bestMove: string;
}

/**
 * V3: Server sends full evaluation history when eval bar is enabled.
 *
 * This is sent after the handshake is accepted and the BGS has been
 * initialized with all moves replayed. For long games, there may be
 * a delay between handshake acceptance and receiving this message.
 */
export interface EvalHistoryMessage {
  type: "eval-history";
  /** Full evaluation history from ply 0 to current position */
  entries: EvalHistoryEntry[];
}

/**
 * V3: Server streams evaluation updates as new moves are made.
 *
 * Sent whenever a move is made in a live game. Contains the evaluation
 * of the new position after the move was applied.
 */
export interface EvalUpdateMessage {
  type: "eval-update";
  /** Ply number of the evaluated position */
  ply: number;
  /**
   * Position evaluation from P1's perspective.
   * Range: [-1, +1] where +1 = P1 winning, 0 = even, -1 = P2 winning.
   */
  evaluation: number;
  /** Best move for the side-to-move at this ply (standard notation) */
  bestMove: string;
}

/**
 * V3: Sent while BGS is being initialized (replaying moves).
 *
 * This lets the client show a loading/pending state during initialization,
 * especially for long games where replaying all moves takes time.
 */
export interface EvalPendingMessage {
  type: "eval-pending";
  /** Number of moves being replayed (for progress indication) */
  totalMoves: number;
}

export type EvalServerMessage =
  | EvalHandshakeAccepted
  | EvalHandshakeRejected
  | EvalResponse
  | EvalError
  | EvalPong
  // V3 BGS-based messages
  | EvalHistoryMessage
  | EvalUpdateMessage
  | EvalPendingMessage;
