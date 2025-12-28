/**
 * Custom Bot Store
 *
 * Manages seat tokens for custom bot connections and tracks active bot connections.
 * A seat token uniquely identifies a custom bot seat within a game session.
 *
 * The protocol uses a single pending request model - only one request is valid at a time.
 */

import { nanoid } from "nanoid";
import type { PlayerId } from "../../shared/domain/game-types";
import type {
  CustomBotSupportedGame,
  BotRequestKind,
} from "../../shared/contracts/custom-bot-protocol";
import type { GameSession } from "./store";

// ============================================================================
// Types
// ============================================================================

export interface SeatTokenMapping {
  gameId: string;
  role: "host" | "joiner";
  createdAt: number;
  usedAt?: number; // Set when token is successfully used for attach
}

export interface PendingRequest {
  requestId: string;
  kind: BotRequestKind;
  createdAt: number;
}

export interface CustomBotConnection {
  gameId: string;
  role: "host" | "joiner";
  playerId: PlayerId;
  seatToken: string;
  attachedAt: number;
  matchId: string;

  // Abuse tracking
  lastMessageAt: number;
  invalidMessageCount: number;

  // Single pending request (only one valid at a time)
  pendingRequest?: PendingRequest;
}

// ============================================================================
// Storage
// ============================================================================

// Map from seatToken -> token info
const seatTokens = new Map<string, SeatTokenMapping>();

// Map from seatToken -> active connection
const activeConnections = new Map<string, CustomBotConnection>();

// Reverse lookup: gameId + role -> seatToken (for finding bot connection by seat)
const seatToTokenMap = new Map<string, string>();

const makeSeatKey = (gameId: string, role: "host" | "joiner"): string =>
  `${gameId}:${role}`;

// ============================================================================
// Seat Token Management
// ============================================================================

/**
 * Generate a new seat token for a custom bot seat.
 * Called when creating a game with a custom bot player.
 */
export const generateSeatToken = (
  gameId: string,
  role: "host" | "joiner",
): string => {
  const token = `cbt_${nanoid(24)}`; // Prefix for easy identification
  seatTokens.set(token, {
    gameId,
    role,
    createdAt: Date.now(),
  });
  seatToTokenMap.set(makeSeatKey(gameId, role), token);
  console.info("[custom-bot] generated seat token", { gameId, role });
  return token;
};

/**
 * Validate a seat token and return the mapping if valid.
 */
export const validateSeatToken = (token: string): SeatTokenMapping | null => {
  return seatTokens.get(token) ?? null;
};

/**
 * Check if a seat token has already been used.
 */
export const isSeatTokenUsed = (token: string): boolean => {
  const mapping = seatTokens.get(token);
  return mapping?.usedAt !== undefined;
};

/**
 * Mark a seat token as used (after successful attach).
 */
export const markSeatTokenUsed = (token: string): void => {
  const mapping = seatTokens.get(token);
  if (mapping) {
    mapping.usedAt = Date.now();
  }
};

/**
 * Get the seat token for a game seat (if one exists).
 */
export const getSeatToken = (
  gameId: string,
  role: "host" | "joiner",
): string | undefined => {
  return seatToTokenMap.get(makeSeatKey(gameId, role));
};

// ============================================================================
// Connection Management
// ============================================================================

/**
 * Create a new custom bot connection after successful attach.
 */
export const createConnection = (
  seatToken: string,
  gameId: string,
  role: "host" | "joiner",
  playerId: PlayerId,
  matchId: string,
): CustomBotConnection => {
  const connection: CustomBotConnection = {
    gameId,
    role,
    playerId,
    seatToken,
    attachedAt: Date.now(),
    matchId,
    lastMessageAt: Date.now(),
    invalidMessageCount: 0,
  };
  activeConnections.set(seatToken, connection);
  console.info("[custom-bot] connection created", {
    gameId,
    role,
    playerId,
    matchId,
  });
  return connection;
};

/**
 * Get an active connection by seat token.
 */
export const getConnection = (
  seatToken: string,
): CustomBotConnection | undefined => {
  return activeConnections.get(seatToken);
};

/**
 * Get an active connection by game ID and role.
 */
export const getConnectionByGameSeat = (
  gameId: string,
  role: "host" | "joiner",
): CustomBotConnection | undefined => {
  const token = seatToTokenMap.get(makeSeatKey(gameId, role));
  if (!token) return undefined;
  return activeConnections.get(token);
};

/**
 * Check if a seat already has an active connection.
 */
export const isSeatConnected = (
  gameId: string,
  role: "host" | "joiner",
): boolean => {
  const token = seatToTokenMap.get(makeSeatKey(gameId, role));
  if (!token) return false;
  return activeConnections.has(token);
};

/**
 * Remove a connection (on disconnect or resignation).
 */
export const removeConnection = (seatToken: string): void => {
  const connection = activeConnections.get(seatToken);
  if (connection) {
    activeConnections.delete(seatToken);
    console.info("[custom-bot] connection removed", {
      gameId: connection.gameId,
      role: connection.role,
    });
  }
};

/**
 * Update the connection for a rematch transition.
 * The same WebSocket connection persists across rematches within a match.
 */
export const transitionConnectionToRematch = (
  seatToken: string,
  newGameId: string,
  newPlayerId: PlayerId,
): void => {
  const connection = activeConnections.get(seatToken);
  if (!connection) return;

  // Remove old seat mapping
  seatToTokenMap.delete(makeSeatKey(connection.gameId, connection.role));

  // Update connection
  connection.gameId = newGameId;
  connection.playerId = newPlayerId;
  connection.pendingRequest = undefined; // Clear any pending request

  // Add new seat mapping
  seatToTokenMap.set(makeSeatKey(newGameId, connection.role), seatToken);

  console.info("[custom-bot] connection transitioned to rematch", {
    matchId: connection.matchId,
    newGameId,
    role: connection.role,
    newPlayerId,
  });
};

// ============================================================================
// Abuse Tracking
// ============================================================================

/**
 * Update last message time and check rate limit.
 * Returns true if the message should be processed, false if rate limited.
 */
export const checkRateLimit = (
  seatToken: string,
  minIntervalMs: number,
): boolean => {
  const connection = activeConnections.get(seatToken);
  if (!connection) return false;

  const now = Date.now();
  const timeSinceLastMessage = now - connection.lastMessageAt;

  if (timeSinceLastMessage < minIntervalMs) {
    return false;
  }

  connection.lastMessageAt = now;
  return true;
};

/**
 * Increment invalid message count.
 * Returns the new count.
 */
export const incrementInvalidMessageCount = (seatToken: string): number => {
  const connection = activeConnections.get(seatToken);
  if (!connection) return 0;

  connection.invalidMessageCount += 1;
  return connection.invalidMessageCount;
};

/**
 * Reset invalid message count (e.g., after a valid message).
 */
export const resetInvalidMessageCount = (seatToken: string): void => {
  const connection = activeConnections.get(seatToken);
  if (connection) {
    connection.invalidMessageCount = 0;
  }
};

// ============================================================================
// Pending Request Management
// ============================================================================

/**
 * Set the pending request for a connection.
 * Any prior pending request is automatically invalidated.
 */
export const setPendingRequest = (
  seatToken: string,
  requestId: string,
  kind: BotRequestKind,
): void => {
  const connection = activeConnections.get(seatToken);
  if (connection) {
    connection.pendingRequest = {
      requestId,
      kind,
      createdAt: Date.now(),
    };
  }
};

/**
 * Get the pending request for a connection.
 */
export const getPendingRequest = (
  seatToken: string,
): PendingRequest | undefined => {
  const connection = activeConnections.get(seatToken);
  return connection?.pendingRequest;
};

/**
 * Clear the pending request.
 */
export const clearPendingRequest = (seatToken: string): void => {
  const connection = activeConnections.get(seatToken);
  if (connection) {
    connection.pendingRequest = undefined;
  }
};

/**
 * Validate that a request ID matches the pending one.
 */
export const validateRequestId = (
  seatToken: string,
  requestId: string,
): boolean => {
  const connection = activeConnections.get(seatToken);
  if (!connection?.pendingRequest) return false;
  return connection.pendingRequest.requestId === requestId;
};

/**
 * Get the pending request kind (if any).
 */
export const getPendingRequestKind = (
  seatToken: string,
): BotRequestKind | undefined => {
  const connection = activeConnections.get(seatToken);
  return connection?.pendingRequest?.kind;
};

// ============================================================================
// Game Compatibility Checking
// ============================================================================

/**
 * Check if a bot client supports the game configuration.
 */
export const checkGameCompatibility = (
  session: GameSession,
  supportedGame: CustomBotSupportedGame,
): { compatible: boolean; reason?: string } => {
  const config = session.config;

  // Check variant support
  if (!supportedGame.variants.includes(config.variant)) {
    return {
      compatible: false,
      reason: `Unsupported variant: ${config.variant}. Client supports: ${supportedGame.variants.join(", ")}`,
    };
  }

  // Check board dimensions
  if (config.boardWidth > supportedGame.maxBoardWidth) {
    return {
      compatible: false,
      reason: `Board width ${config.boardWidth} exceeds client max ${supportedGame.maxBoardWidth}`,
    };
  }

  if (config.boardHeight > supportedGame.maxBoardHeight) {
    return {
      compatible: false,
      reason: `Board height ${config.boardHeight} exceeds client max ${supportedGame.maxBoardHeight}`,
    };
  }

  return { compatible: true };
};

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Clean up stale tokens and connections.
 * Should be called periodically or on server startup.
 */
export const cleanupStaleEntries = (
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): void => {
  const now = Date.now();
  let tokensCleaned = 0;
  let connectionsCleaned = 0;

  // Clean up old unused tokens
  for (const [token, mapping] of seatTokens.entries()) {
    if (!mapping.usedAt && now - mapping.createdAt > maxAgeMs) {
      seatTokens.delete(token);
      seatToTokenMap.delete(makeSeatKey(mapping.gameId, mapping.role));
      tokensCleaned++;
    }
  }

  // Clean up stale connections (shouldn't happen normally, but safety net)
  for (const [token, connection] of activeConnections.entries()) {
    if (now - connection.attachedAt > maxAgeMs) {
      activeConnections.delete(token);
      connectionsCleaned++;
    }
  }

  if (tokensCleaned > 0 || connectionsCleaned > 0) {
    console.info("[custom-bot] cleanup completed", {
      tokensCleaned,
      connectionsCleaned,
    });
  }
};
