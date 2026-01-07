/**
 * Engine API Types (v2)
 *
 * The engine:
 * - Reads a single JSON request from stdin
 * - Writes a single JSON response to stdout
 * - May write logs to stderr
 *
 * Note: In V2, the Official Client auto-declines draw offers without consulting
 * the engine. Draw request types are kept for potential future use.
 */

import type { PlayerId, SerializedGameState } from "../domain/game-types";

export const ENGINE_API_VERSION = 2;

// ============================================================================
// Evaluation Range
// ============================================================================

/**
 * Evaluation values represent the engine's assessment of the position.
 * Range: [-1.0, +1.0]
 *   +1.0 = Engine expects to win (winning position)
 *    0.0 = Even position
 *   -1.0 = Engine expects to lose (losing position)
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
// Request Types
// ============================================================================

interface EngineRequestBase {
  engineApiVersion: number;
  requestId: string;
  /** Which bot this request is for */
  botId: string;
  server: {
    gameId: string;
    serverTime: number;
  };
  /** The PlayerId the bot is playing as (1 or 2) */
  playerId: PlayerId;
  state: SerializedGameState;
}

export interface EngineMoveRequest extends EngineRequestBase {
  kind: "move";
}

export interface EngineDrawRequest extends EngineRequestBase {
  kind: "draw";
  offeredBy: PlayerId;
}

export type EngineRequest = EngineMoveRequest | EngineDrawRequest;

// ============================================================================
// Response Types
// ============================================================================

interface EngineResponseBase {
  engineApiVersion: number;
  requestId: string;
}

export interface EngineMoveResponse extends EngineResponseBase {
  response:
    | {
        action: "move";
        moveNotation: string;
        /** Position evaluation in range [-1, +1]. See EVALUATION_MIN/MAX. */
        evaluation: number;
      }
    | { action: "resign" };
}

export interface EngineDrawResponse extends EngineResponseBase {
  response: { action: "accept-draw" } | { action: "decline-draw" };
}

export type EngineResponse = EngineMoveResponse | EngineDrawResponse;

// ============================================================================
// Helper functions
// ============================================================================

export function createMoveRequest(
  requestId: string,
  botId: string,
  gameId: string,
  serverTime: number,
  playerId: PlayerId,
  state: SerializedGameState,
): EngineMoveRequest {
  return {
    engineApiVersion: ENGINE_API_VERSION,
    kind: "move",
    requestId,
    botId,
    server: { gameId, serverTime },
    playerId,
    state,
  };
}

export function createDrawRequest(
  requestId: string,
  botId: string,
  gameId: string,
  serverTime: number,
  playerId: PlayerId,
  offeredBy: PlayerId,
  state: SerializedGameState,
): EngineDrawRequest {
  return {
    engineApiVersion: ENGINE_API_VERSION,
    kind: "draw",
    requestId,
    botId,
    server: { gameId, serverTime },
    playerId,
    offeredBy,
    state,
  };
}
