import { nanoid } from "nanoid";
import { GameState } from "../../shared/domain/game-state";
import {
  generateFreestyleInitialState,
  normalizeFreestyleConfig,
} from "../../shared/domain/freestyle-setup";
import type { GameAction } from "../../shared/domain/game-types";
import { moveToStandardNotation } from "../../shared/domain/standard-notation";
import type {
  GameConfiguration,
  GameSnapshot,
  PlayerId,
  SessionStatus,
  SerializedGameState,
  GamePlayerSummary,
  PlayerAppearance,
  Move,
  MatchScore,
  GameResult,
} from "../../shared/domain/game-types";
import type {
  GameAccessWaitingReason,
  LiveGameSummary,
} from "../../shared/contracts/games";
import {
  getRatingStateForAuthUser,
  updateRatingStateForAuthUser,
} from "../db/rating-helpers";
import {
  newRatingsAfterGame,
  initialRating,
  Outcome,
  type RatingState,
} from "./rating-system";

// Match type determines how players join the game
export type MatchType = "friend" | "matchmaking";

export interface SessionPlayer {
  role: "host" | "joiner";
  playerId: PlayerId;
  token: string;
  socketToken: string;
  displayName: string;
  connected: boolean;
  ready: boolean;
  lastSeenAt: number;
  appearance: PlayerAppearance;
  authUserId?: string; // Auth provider's user ID (for rating updates)
  ratingAtStart?: number; // Rating at game start, captured before updates
  elo?: number; // Looked up from DB based on authenticated user
}

export interface RematchSeatCredentials {
  token: string;
  socketToken: string;
}

type SessionMatchScore = Record<SessionPlayer["role"], number>;

export interface GameSession {
  id: string;
  seriesId: string;
  rematchParentId?: string;
  rematchNumber: number;
  nextGameId?: string;
  nextGameSeatCredentials?: {
    host: RematchSeatCredentials;
    joiner: RematchSeatCredentials;
  };
  createdAt: number;
  startedAt?: number | null;
  updatedAt: number;
  config: GameConfiguration;
  status: SessionStatus;
  matchType: MatchType;
  cancelled: boolean;
  players: {
    host: SessionPlayer;
    joiner: SessionPlayer;
  };
  matchScore: SessionMatchScore;
  gameInstanceId: number;
  lastScoredGameInstanceId: number;
  gameState: GameState;
  // Chat guest index tracking (per-session)
  chatGuestCounter: number;
  chatGuestIndexMap: Map<string, number>; // socketId -> guestIndex
}

export interface GameCreationResult {
  session: GameSession;
  hostToken: string;
  hostSocketToken: string;
}

const refreshSeatCredential = (player: SessionPlayer) => {
  player.token = nanoid();
  player.socketToken = nanoid();
  player.connected = false;
  player.lastSeenAt = Date.now();
};

export type JoinGameSessionResult =
  | {
      kind: "player";
      session: GameSession;
      player: SessionPlayer;
    }
  | {
      kind: "spectator";
      session: GameSession;
    };

const sessions = new Map<string, GameSession>();

const ensureSession = (id: string): GameSession => {
  const session = sessions.get(id);
  if (!session) {
    throw new Error("Game session not found");
  }
  return session;
};

export const getSession = (id: string): GameSession => ensureSession(id);

const createGameState = (config: GameConfiguration): GameState => {
  if (config.variant === "freestyle") {
    return new GameState(config, Date.now(), generateFreestyleInitialState());
  }
  return new GameState(config, Date.now());
};

const buildMatchScoreSnapshot = (session: GameSession): MatchScore => {
  const hostId = session.players.host.playerId;
  const joinerId = session.players.joiner.playerId;
  const snapshot: MatchScore = { 1: 0, 2: 0 };
  snapshot[hostId] = session.matchScore.host;
  snapshot[joinerId] = session.matchScore.joiner;
  return snapshot;
};

const awardWin = (session: GameSession, winner: PlayerId) => {
  if (session.players.host.playerId === winner) {
    session.matchScore.host += 1;
    return;
  }
  if (session.players.joiner.playerId === winner) {
    session.matchScore.joiner += 1;
  }
};

const awardDraw = (session: GameSession) => {
  session.matchScore.host += 0.5;
  session.matchScore.joiner += 0.5;
};

const finalizeMatchScore = (
  session: GameSession,
  result: GameResult | null | undefined,
) => {
  if (session.lastScoredGameInstanceId === session.gameInstanceId) {
    return;
  }
  if (!result) {
    return;
  }
  if (result.winner === 1 || result.winner === 2) {
    awardWin(session, result.winner);
  } else {
    awardDraw(session);
  }
  session.lastScoredGameInstanceId = session.gameInstanceId;
};

/**
 * Creates a new game session.
 *
 * @param hostIsPlayer1 - Whether the host becomes Player 1 (who starts first).
 *   If not provided, the server randomly chooses. Tests can pass this explicitly
 *   for deterministic behavior.
 * @param hostAuthUserId - Host's auth provider user ID (for rating updates).
 * @param hostElo - Host's ELO rating, looked up from DB by the route handler.
 */
export const createGameSession = (args: {
  config: GameConfiguration;
  matchType: MatchType;
  hostDisplayName?: string;
  hostAppearance?: PlayerAppearance;
  hostIsPlayer1?: boolean;
  hostAuthUserId?: string;
  hostElo?: number;
}): GameCreationResult => {
  const normalizedConfig = normalizeFreestyleConfig(args.config);
  const id = nanoid(8); // Short, shareable game ID (62^8 = 218 trillion combinations)
  // No invite code needed - the game ID itself is secure enough
  const hostToken = nanoid(); // 21 chars by default for security
  const hostSocketToken = nanoid();
  const guestToken = nanoid();
  const guestSocketToken = nanoid();
  const now = Date.now();

  // Determine which role gets which PlayerId based on hostIsPlayer1
  // If not provided, randomly choose. See game-types.ts for Player A/B vs Player 1/2 terminology.
  const hostIsPlayer1 = args.hostIsPlayer1 ?? Math.random() < 0.5;
  const hostPlayerId: PlayerId = hostIsPlayer1 ? 1 : 2;
  const joinerPlayerId: PlayerId = hostIsPlayer1 ? 2 : 1;

  const session: GameSession = {
    id,
    seriesId: id,
    rematchParentId: undefined,
    rematchNumber: 0,
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    config: normalizedConfig,
    status: "waiting",
    matchType: args.matchType,
    cancelled: false,
    players: {
      host: {
        role: "host",
        playerId: hostPlayerId,
        token: hostToken,
        socketToken: hostSocketToken,
        displayName: args.hostDisplayName ?? `Player ${hostPlayerId}`,
        connected: false,
        ready: true,
        lastSeenAt: now,
        appearance: args.hostAppearance ?? {},
        authUserId: args.hostAuthUserId,
        ratingAtStart: args.hostElo,
        elo: args.hostElo,
      },
      joiner: {
        role: "joiner",
        playerId: joinerPlayerId,
        token: guestToken,
        socketToken: guestSocketToken,
        displayName:
          args.matchType === "friend" ? "Friend" : `Player ${joinerPlayerId}`,
        connected: false,
        ready: false,
        lastSeenAt: now,
        appearance: {},
        ratingAtStart: undefined,
      },
    },
    matchScore: {
      host: 0,
      joiner: 0,
    },
    gameInstanceId: 0,
    lastScoredGameInstanceId: -1,
    gameState: createGameState(normalizedConfig),
    chatGuestCounter: 0,
    chatGuestIndexMap: new Map(),
  };

  sessions.set(id, session);

  return {
    session,
    hostToken,
    hostSocketToken,
  };
};

export const joinGameSession = (args: {
  id: string;
  displayName?: string;
  appearance?: PlayerAppearance;
  authUserId?: string; // Auth provider's user ID (for rating updates + seat ownership)
  elo?: number; // Looked up from DB by the route handler
}): JoinGameSessionResult => {
  const session = ensureSession(args.id);
  if (session.cancelled) {
    throw new Error("The game was aborted by the creator.");
  }

  const joiner = session.players.joiner;

  // Seat is available – assign it immediately.
  if (!joiner.ready) {
    joiner.ready = true;
    joiner.displayName =
      args.displayName?.trim() ??
      (session.matchType === "friend" ? "Friend" : "Player 2");
    joiner.appearance = {
      ...joiner.appearance,
      ...args.appearance,
    };
    joiner.authUserId = args.authUserId;
    joiner.ratingAtStart = args.elo;
    joiner.elo = args.elo;
    joiner.lastSeenAt = Date.now();
    session.updatedAt = Date.now();
    session.status = session.players.host.ready ? "ready" : "waiting";
    return {
      kind: "player",
      session,
      player: joiner,
    };
  }

  // Seat already claimed. Allow reissue only if the authenticated user owns it.
  if (args.authUserId && joiner.authUserId === args.authUserId) {
    refreshSeatCredential(joiner);
    session.updatedAt = Date.now();
    return {
      kind: "player",
      session,
      player: joiner,
    };
  }

  return {
    kind: "spectator",
    session,
  };
};

export const markHostReady = (id: string): void => {
  const session = ensureSession(id);
  session.players.host.ready = true;
  session.updatedAt = Date.now();
  session.status = session.players.joiner.ready ? "ready" : "waiting";
};

export const getSessionSnapshot = (id: string): GameSnapshot => {
  const session = ensureSession(id);
  return {
    id: session.id,
    status: session.status,
    config: session.config,
    matchType: session.matchType,

    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    players: [session.players.host, session.players.joiner].map(
      (player): GamePlayerSummary => ({
        role: player.role,
        playerId: player.playerId,
        displayName: player.displayName,
        connected: player.connected,
        ready: player.ready,
        appearance: player.appearance,
        elo: player.elo,
      }),
    ),
    matchScore: buildMatchScoreSnapshot(session),
  };
};

export const resolveSessionForToken = (args: {
  id: string;
  token: string;
}): { session: GameSession; player: SessionPlayer } | null => {
  const session = ensureSession(args.id);
  const player =
    session.players.host.token === args.token
      ? session.players.host
      : session.players.joiner.token === args.token
        ? session.players.joiner
        : null;
  if (!player) return null;
  player.lastSeenAt = Date.now();
  return { session, player };
};

export type SessionAccessResolution =
  | { kind: "not-found" }
  | { kind: "player"; session: GameSession; player: SessionPlayer }
  | { kind: "waiting"; session: GameSession; reason?: GameAccessWaitingReason }
  | { kind: "spectator"; session: GameSession }
  | { kind: "replay"; session: GameSession };

export const resolveGameAccess = (args: {
  id: string;
  token?: string;
  authUserId?: string;
}): SessionAccessResolution => {
  const session = sessions.get(args.id);
  if (!session) {
    return { kind: "not-found" };
  }

  const now = Date.now();

  const matchByToken = (): SessionPlayer | null => {
    if (!args.token) return null;
    if (session.players.host.token === args.token) {
      return session.players.host;
    }
    if (session.players.joiner.token === args.token) {
      return session.players.joiner;
    }
    return null;
  };

  const matchByAuth = (): SessionPlayer | null => {
    if (!args.authUserId) return null;
    if (session.players.host.authUserId === args.authUserId) {
      refreshSeatCredential(session.players.host);
      session.updatedAt = now;
      return session.players.host;
    }
    if (session.players.joiner.authUserId === args.authUserId) {
      refreshSeatCredential(session.players.joiner);
      session.updatedAt = now;
      return session.players.joiner;
    }
    return null;
  };

  const matchedPlayer = matchByToken() ?? matchByAuth();
  if (matchedPlayer) {
    matchedPlayer.lastSeenAt = now;
    return { kind: "player", session, player: matchedPlayer };
  }

  if (session.status === "waiting") {
    if (session.cancelled) {
      return { kind: "waiting", session, reason: "host-aborted" };
    }
    return { kind: "waiting", session };
  }

  if (session.status === "completed") {
    return { kind: "replay", session };
  }

  return { kind: "spectator", session };
};

export const resolveSessionForSocketToken = (args: {
  id: string;
  socketToken: string;
}): { session: GameSession; player: SessionPlayer } | null => {
  const session = ensureSession(args.id);
  const player =
    session.players.host.socketToken === args.socketToken
      ? session.players.host
      : session.players.joiner.socketToken === args.socketToken
        ? session.players.joiner
        : null;
  if (!player) return null;
  return { session, player };
};

export const listSessions = (): GameSnapshot[] => {
  return [...sessions.values()].map((session) => ({
    id: session.id,
    status: session.status,
    config: session.config,
    matchType: session.matchType,

    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    players: [session.players.host, session.players.joiner].map(
      (player): GamePlayerSummary => ({
        role: player.role,
        playerId: player.playerId,
        displayName: player.displayName,
        connected: player.connected,
        ready: player.ready,
        appearance: player.appearance,
        elo: player.elo,
      }),
    ),
    matchScore: buildMatchScoreSnapshot(session),
  }));
};

// List only matchmaking games that are waiting for players
export const listMatchmakingGames = (): GameSnapshot[] => {
  return [...sessions.values()]
    .filter(
      (session) =>
        session.matchType === "matchmaking" &&
        session.status === "waiting" &&
        !session.cancelled,
    )
    .map((session) => ({
      id: session.id,
      status: session.status,
      config: session.config,
      matchType: session.matchType,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      players: [session.players.host, session.players.joiner].map(
        (player): GamePlayerSummary => ({
          role: player.role,
          playerId: player.playerId,
          displayName: player.displayName,
          connected: player.connected,
          ready: player.ready,
          appearance: player.appearance,
          elo: player.elo,
        }),
      ),
      matchScore: buildMatchScoreSnapshot(session),
    }));
};

// ============================================================================
// Spectator Tracking
// ============================================================================

const spectatorCounts = new Map<string, number>();

export const incrementSpectatorCount = (gameId: string): number => {
  const count = (spectatorCounts.get(gameId) ?? 0) + 1;
  spectatorCounts.set(gameId, count);
  return count;
};

export const decrementSpectatorCount = (gameId: string): number => {
  const count = Math.max(0, (spectatorCounts.get(gameId) ?? 1) - 1);
  if (count === 0) {
    spectatorCounts.delete(gameId);
  } else {
    spectatorCounts.set(gameId, count);
  }
  return count;
};

export const getSpectatorCount = (gameId: string): number => {
  return spectatorCounts.get(gameId) ?? 0;
};

// ============================================================================
// Chat Guest Index Tracking
// ============================================================================

/**
 * Assigns a guest index to a socket for chat display names.
 * If the socket already has an index, returns the existing one.
 * Index starts at 1 and increments for each new guest.
 */
export const assignChatGuestIndex = (
  sessionId: string,
  socketId: string,
): number => {
  const session = ensureSession(sessionId);

  // Return existing index if already assigned
  const existing = session.chatGuestIndexMap.get(socketId);
  if (existing !== undefined) {
    return existing;
  }

  // Assign new index
  session.chatGuestCounter += 1;
  const index = session.chatGuestCounter;
  session.chatGuestIndexMap.set(socketId, index);
  return index;
};

/**
 * Gets the guest index for a socket, if one has been assigned.
 */
export const getChatGuestIndex = (
  sessionId: string,
  socketId: string,
): number | undefined => {
  const session = sessions.get(sessionId);
  return session?.chatGuestIndexMap.get(socketId);
};

// ============================================================================
// Live Games (In-Progress Games for Spectating)
// ============================================================================

/**
 * Lists all in-progress games for the live games page.
 * Returns games sorted by average ELO (descending), then by lastMoveAt (descending).
 */
const buildLiveGameSummary = (session: GameSession): LiveGameSummary => {
  const players = [session.players.host, session.players.joiner];
  const elos = players.map((p) => p.elo ?? 1500);
  const averageElo = Math.round((elos[0] + elos[1]) / 2);
  const status: LiveGameSummary["status"] =
    session.status === "ready" ? "ready" : "in-progress";

  return {
    id: session.id,
    variant: session.config.variant,
    rated: session.config.rated,
    timeControl: session.config.timeControl,
    boardWidth: session.config.boardWidth,
    boardHeight: session.config.boardHeight,
    players: players.map((p) => ({
      playerId: p.playerId,
      displayName: p.displayName,
      elo: p.elo,
      role: p.role,
    })),
    status,
    moveCount: session.gameState.moveCount,
    averageElo,
    lastMoveAt: session.updatedAt,
    spectatorCount: getSpectatorCount(session.id),
  };
};

export const listLiveGames = (limit = 100): LiveGameSummary[] => {
  return [...sessions.values()]
    .filter(
      (session) =>
        (session.status === "ready" || session.status === "in-progress") &&
        !session.cancelled,
    )
    .map((session) => buildLiveGameSummary(session))
    .sort((a, b) => b.averageElo - a.averageElo || b.lastMoveAt - a.lastMoveAt)
    .slice(0, limit);
};

/**
 * Gets a single live game summary by ID.
 * Returns null if the game doesn't exist or is not in-progress.
 */
export const getLiveGameSummary = (gameId: string): LiveGameSummary | null => {
  const session = sessions.get(gameId);
  if (
    !session ||
    (session.status !== "ready" && session.status !== "in-progress")
  ) {
    return null;
  }

  return buildLiveGameSummary(session);
};

const applyActionToSession = (
  session: GameSession,
  action: GameAction,
): GameState => {
  if (
    action.kind === "move" &&
    session.gameState.moveCount === 0 &&
    session.startedAt == null
  ) {
    session.startedAt = action.timestamp;
  }
  const next = session.gameState.applyGameAction(action);
  session.gameState = next;
  session.updatedAt = Date.now();
  session.status = next.status === "finished" ? "completed" : "in-progress";
  if (next.status === "finished") {
    finalizeMatchScore(session, next.result ?? null);
  }
  return next;
};

export const applyPlayerMove = (args: {
  id: string;
  playerId: PlayerId;
  move: Move;
  timestamp: number;
}): GameState => {
  const session = ensureSession(args.id);
  if (session.gameState.status !== "playing") {
    throw new Error("Game has already finished");
  }
  return applyActionToSession(session, {
    kind: "move",
    move: args.move,
    playerId: args.playerId,
    timestamp: args.timestamp,
  });
};

export const resignGame = (args: {
  id: string;
  playerId: PlayerId;
  timestamp: number;
}): GameState => {
  const session = ensureSession(args.id);
  if (session.gameState.status !== "playing") {
    return session.gameState;
  }
  return applyActionToSession(session, {
    kind: "resign",
    playerId: args.playerId,
    timestamp: args.timestamp,
  });
};

export const giveTime = (args: {
  id: string;
  playerId: PlayerId;
  seconds: number;
}): GameState => {
  const session = ensureSession(args.id);
  const state = session.gameState;

  if (state.status !== "playing") {
    return state;
  }

  const opponent: PlayerId = args.playerId === 1 ? 2 : 1;
  state.timeLeft[opponent] += args.seconds;

  session.updatedAt = Date.now();
  return state;
};

export const takeback = (args: {
  id: string;
  playerId: PlayerId;
}): GameState => {
  const session = ensureSession(args.id);
  return applyActionToSession(session, {
    kind: "takeback",
    playerId: args.playerId,
    timestamp: Date.now(),
  });
};

export const acceptDraw = (args: {
  id: string;
  playerId: PlayerId;
}): GameState => {
  const session = ensureSession(args.id);
  return applyActionToSession(session, {
    kind: "draw",
    playerId: args.playerId,
    timestamp: Date.now(),
  });
};

export const rejectDraw = (args: { id: string; playerId: PlayerId }): void => {
  // This is handled in the WebSocket layer for broadcasting
  // The function exists for API consistency
  console.info("Draw rejected", {
    sessionId: args.id,
    playerId: args.playerId,
  });
};

export const acceptTakeback = (args: {
  id: string;
  playerId: PlayerId;
}): GameState => {
  const session = ensureSession(args.id);
  return applyActionToSession(session, {
    kind: "takeback",
    playerId: args.playerId,
    timestamp: Date.now(),
  });
};

export const rejectTakeback = (args: {
  id: string;
  playerId: PlayerId;
}): void => {
  // This is handled in the WebSocket layer for broadcasting
  // The function exists for API consistency
  console.info("Takeback rejected", {
    sessionId: args.id,
    playerId: args.playerId,
  });
};

export const serializeGameState = (
  session: GameSession,
): SerializedGameState => {
  const state = session.gameState;
  const historyRows = state.config.boardHeight;
  console.info("[debug-serialize] walls", {
    sessionId: session.id,
    walls: state.grid.getWalls(),
  });
  return {
    status: state.status,
    result: state.result,
    turn: state.turn,
    moveCount: state.moveCount,
    timeLeft: { ...state.timeLeft },
    lastMoveTime: state.lastMoveTime,
    pawns: {
      1: {
        cat: state.pawns[1].cat,
        mouse: state.pawns[1].mouse,
      },
      2: {
        cat: state.pawns[2].cat,
        mouse: state.pawns[2].mouse,
      },
    },
    walls: state.grid.getWalls(),
    initialState: state.getInitialState(),
    history: state.history.map((entry) => ({
      index: entry.index,
      notation: moveToStandardNotation(entry.move, historyRows),
    })),
    config: {
      boardWidth: state.config.boardWidth,
      boardHeight: state.config.boardHeight,
      variant: state.config.variant,
      rated: session.config.rated,
      timeControl: session.config.timeControl,
    },
  };
};

export const getSerializedState = (id: string): SerializedGameState => {
  const session = ensureSession(id);
  return serializeGameState(session);
};

export interface RematchSessionResult {
  newSession: GameSession;
  seatCredentials: {
    host: RematchSeatCredentials;
    joiner: RematchSeatCredentials;
  };
}

export const createRematchSession = (
  previousSessionId: string,
): RematchSessionResult => {
  const previous = ensureSession(previousSessionId);

  if (previous.gameState.status !== "finished") {
    throw new Error("Cannot start a rematch before the game is finished.");
  }

  if (previous.nextGameId) {
    throw new Error("Rematch already started for this game.");
  }

  const now = Date.now();
  const newId = nanoid(8);
  const hostCredentials: RematchSeatCredentials = {
    token: nanoid(),
    socketToken: nanoid(),
  };
  const joinerCredentials: RematchSeatCredentials = {
    token: nanoid(),
    socketToken: nanoid(),
  };
  const normalizedConfig = normalizeFreestyleConfig(previous.config);

  // Swap player IDs so the other player goes first in the rematch
  const hostPlayerId = previous.players.host.playerId;
  const joinerPlayerId = previous.players.joiner.playerId;

  const newSession: GameSession = {
    id: newId,
    seriesId: previous.seriesId ?? previous.id,
    rematchParentId: previous.id,
    rematchNumber: previous.rematchNumber + 1,
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    config: normalizedConfig,
    status: "ready",
    matchType: previous.matchType,
    cancelled: false,
    players: {
      host: {
        ...previous.players.host,
        playerId: joinerPlayerId,
        token: hostCredentials.token,
        socketToken: hostCredentials.socketToken,
        connected: false,
        ready: true,
        lastSeenAt: now,
        ratingAtStart: previous.players.host.elo,
      },
      joiner: {
        ...previous.players.joiner,
        playerId: hostPlayerId,
        token: joinerCredentials.token,
        socketToken: joinerCredentials.socketToken,
        connected: false,
        ready: true,
        lastSeenAt: now,
        ratingAtStart: previous.players.joiner.elo,
      },
    },
    matchScore: {
      host: previous.matchScore.host,
      joiner: previous.matchScore.joiner,
    },
    gameInstanceId: 0,
    lastScoredGameInstanceId: -1,
    gameState: createGameState(normalizedConfig),
    chatGuestCounter: 0,
    chatGuestIndexMap: new Map(),
  };

  sessions.set(newId, newSession);
  previous.nextGameId = newId;
  previous.nextGameSeatCredentials = {
    host: hostCredentials,
    joiner: joinerCredentials,
  };
  previous.updatedAt = now;

  return {
    newSession,
    seatCredentials: {
      host: hostCredentials,
      joiner: joinerCredentials,
    },
  };
};

export const updateConnectionState = (args: {
  id: string;
  socketToken: string;
  connected: boolean;
}): void => {
  const session = ensureSession(args.id);
  const player =
    session.players.host.socketToken === args.socketToken
      ? session.players.host
      : session.players.joiner.socketToken === args.socketToken
        ? session.players.joiner
        : null;
  if (!player) {
    console.warn(
      "[sessions] updateConnectionState skipped for unknown socket",
      {
        sessionId: args.id,
        socketToken: args.socketToken,
        connected: args.connected,
      },
    );
    return;
  }
  player.connected = args.connected;
  player.lastSeenAt = Date.now();
  session.updatedAt = Date.now();
};

/**
 * Processes rating updates after a game ends.
 * Returns the new rating values if ratings were updated, or undefined otherwise.
 *
 * Rating updates only happen for rated games where both players are authenticated.
 */
export const processRatingUpdate = async (
  id: string,
): Promise<{ player1NewElo: number; player2NewElo: number } | undefined> => {
  const session = ensureSession(id);
  const gameState = session.gameState;

  // Only process if game is finished
  if (gameState.status !== "finished") {
    return undefined;
  }

  // Only process rated games
  if (!session.config.rated) {
    return undefined;
  }

  // Get player info - find which player is which by playerId
  const player1 =
    session.players.host.playerId === 1
      ? session.players.host
      : session.players.joiner;
  const player2 =
    session.players.host.playerId === 2
      ? session.players.host
      : session.players.joiner;

  // Both players must be authenticated for rating updates
  if (!player1.authUserId || !player2.authUserId) {
    console.info("[ratings] Skipping update - not all players authenticated", {
      sessionId: id,
      player1Auth: !!player1.authUserId,
      player2Auth: !!player2.authUserId,
    });
    return undefined;
  }

  const variant = session.config.variant;
  const timeControl = session.config.timeControl.preset ?? "rapid";

  // Get current rating states from DB
  const [player1State, player2State] = await Promise.all([
    getRatingStateForAuthUser(player1.authUserId, variant, timeControl),
    getRatingStateForAuthUser(player2.authUserId, variant, timeControl),
  ]);

  // Use initial rating if players don't have a rating yet
  const state1: RatingState = player1State ?? initialRating();
  const state2: RatingState = player2State ?? initialRating();

  // Determine outcome from game result
  const result = gameState.result;
  if (!result) {
    console.warn("[ratings] Game finished but no result found", {
      sessionId: id,
    });
    return undefined;
  }

  let outcomeForPlayer1: Outcome;
  if (result.winner === 1) {
    outcomeForPlayer1 = Outcome.Win;
  } else if (result.winner === 2) {
    outcomeForPlayer1 = Outcome.Loss;
  } else {
    outcomeForPlayer1 = Outcome.Tie;
  }
  const outcomeForPlayer2 =
    outcomeForPlayer1 === Outcome.Win
      ? Outcome.Loss
      : outcomeForPlayer1 === Outcome.Loss
        ? Outcome.Win
        : Outcome.Tie;

  const recordDeltaForOutcome = (outcome: Outcome) => ({
    wins: outcome === Outcome.Win ? 1 : outcome === Outcome.Tie ? 0.5 : 0,
    losses: outcome === Outcome.Loss ? 1 : outcome === Outcome.Tie ? 0.5 : 0,
  });

  // Calculate new ratings
  const { a: newState1, b: newState2 } = newRatingsAfterGame(
    state1,
    state2,
    outcomeForPlayer1,
  );

  console.info("[ratings] Updating ratings", {
    sessionId: id,
    player1: {
      authUserId: player1.authUserId,
      oldRating: state1.rating,
      newRating: newState1.rating,
    },
    player2: {
      authUserId: player2.authUserId,
      oldRating: state2.rating,
      newRating: newState2.rating,
    },
    outcome: outcomeForPlayer1,
  });

  // Update ratings in DB
  await Promise.all([
    updateRatingStateForAuthUser(
      player1.authUserId,
      variant,
      timeControl,
      newState1,
      recordDeltaForOutcome(outcomeForPlayer1),
    ),
    updateRatingStateForAuthUser(
      player2.authUserId,
      variant,
      timeControl,
      newState2,
      recordDeltaForOutcome(outcomeForPlayer2),
    ),
  ]);

  // Update session's ELO values so match-status reflects new ratings
  player1.elo = newState1.rating;
  player2.elo = newState2.rating;

  return {
    player1NewElo: newState1.rating,
    player2NewElo: newState2.rating,
  };
};

export const cancelGameSession = (args: {
  id: string;
  token?: string;
}): GameSession => {
  const session = ensureSession(args.id);
  if (session.cancelled) {
    return session;
  }
  const hostToken = session.players.host.token;
  if (hostToken !== args.token) {
    throw new Error("Only the host can abort this game.");
  }
  session.cancelled = true;
  session.updatedAt = Date.now();
  return session;
};
