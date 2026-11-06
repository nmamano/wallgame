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

import { logLine } from "../log-line";
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
 * Who a session counts against in the pool.
 * - official-game: an official bot's seat in a game. Never limited per owner,
 *   and the only owner that can use the reserve.
 * - community-game: a seat of a bot from a client without the official token,
 *   counted per bot client.
 * - eval: an eval bar session (live shared or replay), counted per source
 *   address of the viewer that opened it.
 */
export type BgsOwner =
  | { kind: "official-game" }
  | { kind: "community-game"; clientId: string }
  | { kind: "eval"; source: string };

/**
 * A Bot Game Session tracks state for one game/eval session with a bot.
 */
export interface BotGameSession {
  /** Unique session identifier */
  bgsId: string;
  /** The bot handling this session (clientId:botId) */
  botCompositeId: string;
  /** Who this session counts against in the pool */
  owner: BgsOwner;
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
export const MAX_SESSIONS = 256;

/**
 * Sessions only official games can use. Community and eval sessions together
 * stop at MAX_SESSIONS - OFFICIAL_GAME_RESERVE, so nobody without the official
 * token can keep an official bot game from starting.
 */
export const OFFICIAL_GAME_RESERVE = 64;

/**
 * Per-owner limits. 16 per community client keeps the at most 10 anonymous
 * clients (custom-bot-store.ts) under the non-reserved share by themselves.
 */
export const MAX_SESSIONS_PER_COMMUNITY_CLIENT = 16;
export const MAX_SESSIONS_PER_EVAL_SOURCE = 8;

const ownerKey = (owner: BgsOwner): string | null => {
  switch (owner.kind) {
    case "official-game":
      return null;
    case "community-game":
      return `client:${owner.clientId}`;
    case "eval":
      return `source:${owner.source}`;
  }
};

const ownerLimit = (owner: BgsOwner): number => {
  switch (owner.kind) {
    case "official-game":
      return MAX_SESSIONS;
    case "community-game":
      return MAX_SESSIONS_PER_COMMUNITY_CLIENT;
    case "eval":
      return MAX_SESSIONS_PER_EVAL_SOURCE;
  }
};

/**
 * What a session is for: a bot's seat in a game, or an eval bar opened from a
 * source address.
 */
export type BgsPurpose = { kind: "game" } | { kind: "eval"; source: string };

/** Who a session for this purpose on this bot counts against. */
export const bgsOwnerFor = (
  purpose: BgsPurpose,
  bot: { clientId: string; isOfficial: boolean },
): BgsOwner => {
  if (purpose.kind === "eval") return purpose;
  return bot.isOfficial
    ? { kind: "official-game" }
    : { kind: "community-game", clientId: bot.clientId };
};

export type CreateBgsResult =
  | { ok: true; session: BotGameSession }
  | { ok: false; reason: "duplicate-id" | "at-capacity" | "over-quota" };

/**
 * Why the pool refuses a new session for this owner, or null if it has room.
 * createBgs enforces it; a route asks it first to refuse with a clear reason.
 * The counts come from the sessions map itself (at most MAX_SESSIONS entries),
 * so endBgs stays the only removal and no counter can drift.
 */
export const bgsPoolRefusal = (
  owner: BgsOwner,
): "at-capacity" | "over-quota" | null => {
  if (sessions.size >= MAX_SESSIONS) return "at-capacity";
  const key = ownerKey(owner);
  if (key === null) return null;
  let unreserved = 0;
  let ownCount = 0;
  for (const session of sessions.values()) {
    if (session.owner.kind === "official-game") continue;
    unreserved++;
    if (ownerKey(session.owner) === key) ownCount++;
  }
  if (unreserved >= MAX_SESSIONS - OFFICIAL_GAME_RESERVE) return "at-capacity";
  if (ownCount >= ownerLimit(owner)) return "over-quota";
  return null;
};

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
 * @param owner - Who the session counts against in the pool
 */
export const createBgs = (
  bgsId: string,
  botCompositeId: string,
  gameId: string,
  config: BgsConfig,
  owner: BgsOwner,
): CreateBgsResult => {
  if (sessions.has(bgsId)) {
    console.warn("[bgs-store] BGS already exists", { bgsId });
    return { ok: false, reason: "duplicate-id" };
  }

  const refusal = bgsPoolRefusal(owner);
  if (refusal) {
    console.warn("[bgs-store] pool refused BGS", {
      bgsId,
      reason: refusal,
      owner,
      currentCount: sessions.size,
    });
    return { ok: false, reason: refusal };
  }

  const now = Date.now();
  const session: BotGameSession = {
    bgsId,
    botCompositeId,
    owner,
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
  logLine("[bgs-store] BGS created", {
    bgsId,
    botCompositeId,
    gameId,
    variant: config.variant,
    owner: owner.kind,
  });

  return { ok: true, session };
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
  logLine("[bgs-store] BGS ended", {
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
  logLine("[bgs-store] BGS marked ready", { bgsId });
  return true;
};

/**
 * Reset promises and their resolvers, keyed by bgsId.
 *
 * These live OUTSIDE the BGS objects because a takeback reset spans the
 * entire lifecycle: end old BGS → create new BGS → replay → done.
 * The BGS is deleted and recreated during this process, but the promise
 * must survive the whole thing so awaiters (e.g., the move handler) only
 * wake up when the reset is truly complete.
 */
const resetPromises = new Map<string, Promise<void>>();
const resetResolvers = new Map<string, () => void>();
const resetGenerations = new Map<string, number>();

/**
 * Mark a bgsId as resetting (takeback replay in progress).
 * Creates a promise that persists across BGS deletion/recreation.
 * Returns a generation token — pass it to clearBgsResetting so that
 * an earlier takeback's finally block doesn't destroy a later one's promise.
 */
export const markBgsResetting = (bgsId: string): number => {
  // Resolve any pre-existing reset promise (e.g., rapid double-takeback)
  const existing = resetResolvers.get(bgsId);
  if (existing) existing();

  const generation = (resetGenerations.get(bgsId) ?? 0) + 1;
  resetGenerations.set(bgsId, generation);

  let resolve: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  resetPromises.set(bgsId, promise);
  resetResolvers.set(bgsId, resolve!);
  return generation;
};

/**
 * Clear the resetting state for a bgsId (takeback replay complete).
 * Only clears if the generation matches — prevents an earlier takeback's
 * finally block from destroying a later takeback's promise.
 */
export const clearBgsResetting = (bgsId: string, generation: number): void => {
  if (resetGenerations.get(bgsId) !== generation) return; // stale
  const resolve = resetResolvers.get(bgsId);
  if (resolve) resolve();
  resetResolvers.delete(bgsId);
  resetPromises.delete(bgsId);
  resetGenerations.delete(bgsId);
};

/**
 * Get the reset promise for a bgsId, or null if not resetting.
 * Used by the move handler to await reset completion.
 */
export const getResetPromise = (bgsId: string): Promise<void> | null => {
  return resetPromises.get(bgsId) ?? null;
};

// ============================================================================
// History Management
// ============================================================================

/**
 * Callback type for eval history update notifications.
 * Called when a new eval entry is added to a BGS.
 */
type EvalUpdateListener = (
  gameId: string,
  bgsId: string,
  entry: BgsHistoryEntry,
) => void;

/** Listener for eval update notifications (set by eval-socket.ts) */
let evalUpdateListener: EvalUpdateListener | null = null;

/**
 * Register a listener for eval history updates.
 * Used by eval-socket.ts to receive notifications for connected eval bar sockets.
 */
export const setEvalUpdateListener = (
  listener: EvalUpdateListener | null,
): void => {
  evalUpdateListener = listener;
};

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

  // Notify listener (eval bar sockets)
  if (evalUpdateListener) {
    evalUpdateListener(session.gameId, bgsId, entry);
  }

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
 * How long a BGS may go with no update before the janitor ends it.
 *
 * No legitimate session gets near this. A live game updates its BGS on every
 * move, and every live game ends long before a day passes with no move: an
 * untimed game after 30 minutes (IDLE_TIMEOUT_MS in store.ts), a timed one on
 * its clock (at most 1 hour plus banked increments, timeControlSchema). A
 * replay BGS ends as soon as its history is sent. So a session this idle has
 * leaked: an end path that never ran.
 */
export const BGS_MAX_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * The sessions with no update for MORE than `maxIdleMs` before `now`.
 * Ends nothing: the janitor (routes/bgs-janitor.ts) ends them through the
 * normal end paths, which also tell the engine, where a bare endBgs would
 * forget a session the engine still holds.
 */
export const findStaleBgs = (
  now: number,
  maxIdleMs: number = BGS_MAX_IDLE_MS,
): BotGameSession[] =>
  Array.from(sessions.values()).filter(
    (session) => now - session.updatedAt > maxIdleMs,
  );

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
