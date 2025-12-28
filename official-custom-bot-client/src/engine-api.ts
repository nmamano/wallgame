/**
 * Engine API Types (v1)
 *
 * This module defines the interface between the official custom-bot client
 * and a bot engine (decision making process).
 *
 * The engine:
 * - Reads a single JSON request from stdin
 * - Writes a single JSON response to stdout
 * - May write logs to stderr
 */

import type {
  SerializedGameState,
  GameSnapshot,
  PlayerId,
} from "../../shared/domain/game-types";
import type { CustomBotSeatIdentity } from "../../shared/contracts/custom-bot-protocol";

export const ENGINE_API_VERSION = 1;

// ============================================================================
// Request Types
// ============================================================================

interface EngineRequestBase {
  engineApiVersion: number;
  requestId: string;
  server: {
    matchId: string;
    gameId: string;
    serverTime: number;
  };
  seat: CustomBotSeatIdentity;
  state: SerializedGameState;
  snapshot: GameSnapshot;
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
  response: { action: "move"; moveNotation: string } | { action: "resign" };
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
  matchId: string,
  gameId: string,
  serverTime: number,
  seat: CustomBotSeatIdentity,
  state: SerializedGameState,
  snapshot: GameSnapshot,
): EngineMoveRequest {
  return {
    engineApiVersion: ENGINE_API_VERSION,
    kind: "move",
    requestId,
    server: { matchId, gameId, serverTime },
    seat,
    state,
    snapshot,
  };
}

export function createDrawRequest(
  requestId: string,
  matchId: string,
  gameId: string,
  serverTime: number,
  seat: CustomBotSeatIdentity,
  offeredBy: PlayerId,
  state: SerializedGameState,
  snapshot: GameSnapshot,
): EngineDrawRequest {
  return {
    engineApiVersion: ENGINE_API_VERSION,
    kind: "draw",
    requestId,
    server: { matchId, gameId, serverTime },
    seat,
    offeredBy,
    state,
    snapshot,
  };
}
