/**
 * Bot Game Session (BGS) Store
 *
 * Manages stateful Bot Game Sessions for the V3 protocol.
 * Each BGS tracks game state and evaluation history for a single bot-vs-human game
 * or eval bar session.
 *
 * Key concepts:
 * - A BGS is identified by a unique bgsId (typically the gameId or gameId_username)
 * - Each BGS tracks the bot composite ID, game configuration, and evaluation history
 * - History entries store position evaluations at each ply for the eval bar
 * - BGS lifecycle: creating → initializing → ready → ended
 *
 * BGS Status States:
 * - "initializing": BGS created, waiting for game_session_started response
 * - "ready": Session active and ready for evaluate/apply_move requests
 * - "ended": Session terminated, no further requests accepted
 */

import type { BgsConfig } from "../../shared/contracts/custom-bot-protocol";

// ============================================================================
// Types
// ============================================================================

/**
 * History entry for a position in a Bot Game Session.
 * Stores evaluation data for the eval bar feature.
 */
export interface BgsHistoryEntry {
  /** Ply number: 0 = initial position, increments after each move */
  ply: number;
  /** Position evaluation from P1's perspective: +1 = P1 winning, 0 = even, -1 = P2 winning */
  evaluation: number;
  /** Best move for the side-to-move at this ply (standard notation) */
  bestMove: string;
}

/**
 * Request types that can be pending in a BGS.
 */
export type PendingBgsRequestType =
  | "start_game_session"
  | "evaluate_position"
  | "apply_move"
  | "end_game_session";

/**
 * Tracks a pending request awaiting response from the bot client.
 */
export interface PendingBgsRequest {
  type: PendingBgsRequestType;
  bgsId: string;
  expectedPly: number;
  createdAt: number;
  /** Resolver to call when response received */
  resolve: (success: boolean, error?: string) => void;
}

/**
 * BGS session status.
 * - initializing: Waiting for game_session_started response
 * - ready: Active and accepting requests
 * - ended: Session terminated
 */
export type BgsStatus = "initializing" | "ready" | "ended";

/**
 * A Bot Game Session tracks state for one game/eval session with a bot.
 */
export interface BotGameSession {
  /** Unique session identifier */
  bgsId: string;
  /** The bot handling this session (clientId:botId) */
  botCompositeId: string;
  /** Associated game ID (if this is a game session) */
  gameId: string;
  /** Game configuration */
  config: BgsConfig;
  /** Session lifecycle status */
  status: BgsStatus;
  /** Evaluation history for all positions */
  history: BgsHistoryEntry[];
  /** Current ply (number of half-moves played) */
  currentPly: number;
  /** Currently pending request (if any) */
  pendingRequest: PendingBgsRequest | null;
  /** When the session was created */
  createdAt: number;
  /** When the session was last updated */
  updatedAt: number;
}

// ============================================================================
// Storage
// ============================================================================

/** Map from bgsId -> BotGameSession */
const sessions = new Map<string, BotGameSession>();

/** Maximum number of concurrent BGS (matches Deep Wallwars limit) */
const MAX_SESSIONS = 256;

// ============================================================================
// Session Lifecycle
// ============================================================================

/**
 * Create a new Bot Game Session.
 * The session starts in "initializing" status until the bot confirms with game_session_started.
 *
 * @param bgsId - Unique session identifier
 * @param botCompositeId - Bot composite ID (clientId:botId)
 * @param gameId - Associated game ID
 * @param config - Game configuration
 * @returns The created session, or null if at capacity
 */
export const createBgs = (
  bgsId: string,
  botCompositeId: string,
  gameId: string,
  config: BgsConfig,
): BotGameSession | null => {
  // Check capacity
  if (sessions.size >= MAX_SESSIONS) {
    console.warn("[bgs-store] at capacity, cannot create BGS", {
      bgsId,
      currentCount: sessions.size,
      maxSessions: MAX_SESSIONS,
    });
    return null;
  }

  // Check for duplicate
  if (sessions.has(bgsId)) {
    console.warn("[bgs-store] BGS already exists", { bgsId });
    return null;
  }

  const now = Date.now();
  const session: BotGameSession = {
    bgsId,
    botCompositeId,
    gameId,
    config,
    status: "initializing",
    history: [],
    currentPly: 0,
    pendingRequest: null,
    createdAt: now,
    updatedAt: now,
  };

  sessions.set(bgsId, session);
  console.info("[bgs-store] BGS created", {
    bgsId,
    botCompositeId,
    gameId,
    variant: config.variant,
  });

  return session;
};

/**
 * Get a Bot Game Session by ID.
 */
export const getBgs = (bgsId: string): BotGameSession | undefined => {
  return sessions.get(bgsId);
};

/**
 * End a Bot Game Session and remove it from storage.
 * Returns the ended session, or undefined if not found.
 */
export const endBgs = (bgsId: string): BotGameSession | undefined => {
  const session = sessions.get(bgsId);
  if (!session) {
    return undefined;
  }

  session.status = "ended";
  session.updatedAt = Date.now();

  // Clear any pending request
  if (session.pendingRequest) {
    session.pendingRequest.resolve(false, "Session ended");
    session.pendingRequest = null;
  }

  sessions.delete(bgsId);
  console.info("[bgs-store] BGS ended", {
    bgsId,
    historyLength: session.history.length,
    finalPly: session.currentPly,
  });

  return session;
};

// ============================================================================
// Status Management
// ============================================================================

/**
 * Mark a BGS as ready (after receiving game_session_started).
 */
export const markBgsReady = (bgsId: string): boolean => {
  const session = sessions.get(bgsId);
  if (!session) {
    return false;
  }

  if (session.status !== "initializing") {
    console.warn("[bgs-store] cannot mark ready - invalid status", {
      bgsId,
      currentStatus: session.status,
    });
    return false;
  }

  session.status = "ready";
  session.updatedAt = Date.now();
  console.info("[bgs-store] BGS marked ready", { bgsId });
  return true;
};

// ============================================================================
// History Management
// ============================================================================

/**
 * Add a history entry to a BGS.
 * History entries track evaluations for the eval bar.
 */
export const addHistoryEntry = (
  bgsId: string,
  entry: BgsHistoryEntry,
): boolean => {
  const session = sessions.get(bgsId);
  if (!session) {
    console.warn("[bgs-store] cannot add history - BGS not found", { bgsId });
    return false;
  }

  // Validate ply ordering
  const expectedPly = session.history.length;
  if (entry.ply !== expectedPly) {
    console.warn("[bgs-store] history ply mismatch", {
      bgsId,
      expectedPly,
      receivedPly: entry.ply,
    });
    // Still add it, but log the warning for debugging
  }

  session.history.push(entry);
  session.updatedAt = Date.now();

  return true;
};

/**
 * Get the evaluation history for a BGS.
 * Returns a copy of the history array.
 */
export const getBgsHistory = (bgsId: string): BgsHistoryEntry[] => {
  const session = sessions.get(bgsId);
  if (!session) {
    return [];
  }
  // Return a copy to prevent external mutation
  return [...session.history];
};

/**
 * Get the latest history entry for a BGS.
 */
export const getLatestHistoryEntry = (
  bgsId: string,
): BgsHistoryEntry | undefined => {
  const session = sessions.get(bgsId);
  if (!session || session.history.length === 0) {
    return undefined;
  }
  return session.history[session.history.length - 1];
};

// ============================================================================
// Ply Management
// ============================================================================

/**
 * Update the current ply for a BGS.
 * Called after a move is applied.
 */
export const updateCurrentPly = (bgsId: string, newPly: number): boolean => {
  const session = sessions.get(bgsId);
  if (!session) {
    return false;
  }

  session.currentPly = newPly;
  session.updatedAt = Date.now();
  return true;
};

/**
 * Get the current ply for a BGS.
 */
export const getCurrentPly = (bgsId: string): number | undefined => {
  const session = sessions.get(bgsId);
  return session?.currentPly;
};

// ============================================================================
// Pending Request Management
// ============================================================================

/**
 * Set a pending request for a BGS.
 * Returns false if there's already a pending request.
 */
export const setPendingRequest = (
  bgsId: string,
  request: PendingBgsRequest,
): boolean => {
  const session = sessions.get(bgsId);
  if (!session) {
    return false;
  }

  if (session.pendingRequest) {
    console.warn("[bgs-store] BGS already has pending request", {
      bgsId,
      existingType: session.pendingRequest.type,
      newType: request.type,
    });
    return false;
  }

  session.pendingRequest = request;
  session.updatedAt = Date.now();
  return true;
};

/**
 * Get the pending request for a BGS.
 */
export const getPendingRequest = (
  bgsId: string,
): PendingBgsRequest | null | undefined => {
  const session = sessions.get(bgsId);
  return session?.pendingRequest;
};

/**
 * Clear the pending request for a BGS.
 * Returns the cleared request, or null if none was pending.
 */
export const clearPendingRequest = (
  bgsId: string,
): PendingBgsRequest | null => {
  const session = sessions.get(bgsId);
  if (!session) {
    return null;
  }

  const pending = session.pendingRequest;
  session.pendingRequest = null;
  session.updatedAt = Date.now();
  return pending;
};

// ============================================================================
// Query Functions
// ============================================================================

/**
 * Get all BGS for a specific bot.
 */
export const getBgsForBot = (botCompositeId: string): BotGameSession[] => {
  const results: BotGameSession[] = [];
  for (const session of Array.from(sessions.values())) {
    if (session.botCompositeId === botCompositeId) {
      results.push(session);
    }
  }
  return results;
};

/**
 * Get the BGS for a specific game (if any).
 */
export const getBgsForGame = (gameId: string): BotGameSession | undefined => {
  for (const session of Array.from(sessions.values())) {
    if (session.gameId === gameId) {
      return session;
    }
  }
  return undefined;
};

/**
 * Get the total number of active BGS.
 */
export const getBgsCount = (): number => {
  return sessions.size;
};

/**
 * Check if we're at capacity.
 */
export const isAtCapacity = (): boolean => {
  return sessions.size >= MAX_SESSIONS;
};

// ============================================================================
// Cleanup
// ============================================================================

/**
 * End all BGS for a specific bot.
 * Called when a bot client disconnects.
 */
export const endAllBgsForBot = (botCompositeId: string): BotGameSession[] => {
  const ended: BotGameSession[] = [];
  // Collect bgsIds first to avoid modifying the map while iterating
  const bgsIdsToEnd: string[] = [];
  for (const session of Array.from(sessions.values())) {
    if (session.botCompositeId === botCompositeId) {
      bgsIdsToEnd.push(session.bgsId);
    }
  }
  for (const bgsId of bgsIdsToEnd) {
    const endedSession = endBgs(bgsId);
    if (endedSession) {
      ended.push(endedSession);
    }
  }
  if (ended.length > 0) {
    console.info("[bgs-store] ended all BGS for bot", {
      botCompositeId,
      count: ended.length,
    });
  }
  return ended;
};

/**
 * Clean up stale BGS (older than maxAgeMs).
 * Should be called periodically.
 */
export const cleanupStaleBgs = (
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): number => {
  const now = Date.now();
  // Collect bgsIds first to avoid modifying the map while iterating
  const staleIds: string[] = [];
  for (const session of Array.from(sessions.values())) {
    if (now - session.updatedAt > maxAgeMs) {
      staleIds.push(session.bgsId);
    }
  }
  for (const bgsId of staleIds) {
    endBgs(bgsId);
  }

  if (staleIds.length > 0) {
    console.info("[bgs-store] cleanup completed", {
      cleanedCount: staleIds.length,
    });
  }
  return staleIds.length;
};

// ============================================================================
// Debug / Testing
// ============================================================================

/**
 * Clear all BGS (for testing).
 */
export const clearAll = (): void => {
  sessions.clear();
};

/**
 * Get all BGS (for debugging).
 */
export const getAllBgs = (): BotGameSession[] => {
  return Array.from(sessions.values());
};
