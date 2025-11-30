import { nanoid } from "nanoid";
import { GameState } from "../../shared/domain/game-state";
import type { GameAction } from "../../shared/domain/game-types";
import { moveToStandardNotation } from "../../shared/domain/standard-notation";
import type {
  GameConfiguration,
  GameSnapshot,
  PlayerId,
  SessionStatus,
  GameActionPayload,
  SerializedGameState,
  GamePlayerSummary,
  PlayerAppearance,
  Move,
  Action,
} from "../../shared/domain/game-types";

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
}

export interface GameSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  config: GameConfiguration;
  status: SessionStatus;
  matchType: MatchType;
  players: {
    host: SessionPlayer;
    joiner: SessionPlayer;
  };
  gameState: GameState;
}

export interface GameCreationResult {
  session: GameSession;
  hostToken: string;
  hostSocketToken: string;
}

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
  return new GameState(config, Date.now());
};

export const createGameSession = (args: {
  config: GameConfiguration;
  matchType: MatchType;
  hostDisplayName?: string;
  hostAppearance?: PlayerAppearance;
}): GameCreationResult => {
  const id = nanoid(8); // Short, shareable game ID (62^8 = 218 trillion combinations)
  // No invite code needed - the game ID itself is secure enough
  const hostToken = nanoid(); // 21 chars by default for security
  const hostSocketToken = nanoid();
  const guestToken = nanoid();
  const guestSocketToken = nanoid();
  const now = Date.now();

  const session: GameSession = {
    id,
    createdAt: now,
    updatedAt: now,
    config: args.config,
    status: "waiting",
    matchType: args.matchType,
    players: {
      host: {
        role: "host",
        playerId: 1,
        token: hostToken,
        socketToken: hostSocketToken,
        displayName: args.hostDisplayName ?? "Player 1",
        connected: false,
        ready: false,
        lastSeenAt: now,
        appearance: args.hostAppearance ?? {},
      },
      joiner: {
        role: "joiner",
        playerId: 2,
        token: guestToken,
        socketToken: guestSocketToken,
        displayName: args.matchType === "friend" ? "Friend" : "Player 2",
        connected: false,
        ready: false,
        lastSeenAt: now,
        appearance: {},
      },
    },
    gameState: createGameState(args.config),
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
}): {
  session: GameSession;
  guestToken: string;
  guestSocketToken: string;
} => {
  const session = ensureSession(args.id);

  // For matchmaking games, check if still accepting joiners
  if (session.matchType === "matchmaking" && session.status !== "waiting") {
    throw new Error("Game is no longer accepting players");
  }

  const joiner = session.players.joiner;
  if (joiner.ready) {
    return {
      session,
      guestToken: joiner.token,
      guestSocketToken: joiner.socketToken,
    };
  }
  joiner.ready = true;
  joiner.displayName =
    args.displayName?.trim() ||
    (session.matchType === "friend" ? "Friend" : "Player 2");
  joiner.appearance = {
    ...joiner.appearance,
    ...args.appearance,
  };
  joiner.lastSeenAt = Date.now();
  session.updatedAt = Date.now();
  session.status = session.players.host.ready ? "ready" : "waiting";
  return {
    session,
    guestToken: joiner.token,
    guestSocketToken: joiner.socketToken,
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
      }),
    ),
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
      }),
    ),
  }));
};

// List only matchmaking games that are waiting for players
export const listMatchmakingGames = (): GameSnapshot[] => {
  return [...sessions.values()]
    .filter(
      (session) =>
        session.matchType === "matchmaking" && session.status === "waiting",
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
        }),
      ),
    }));
};

const toAction = (payload: GameActionPayload): Action => {
  if (payload.type === "wall") {
    if (!payload.orientation) {
      throw new Error("Wall orientation required");
    }
    return {
      type: payload.type,
      target: payload.cell,
      wallOrientation: payload.orientation,
    };
  }
  return {
    type: payload.type,
    target: payload.cell,
  };
};

const applyActionToSession = (
  session: GameSession,
  action: GameAction,
): GameState => {
  const next = session.gameState.applyGameAction(action);
  session.gameState = next;
  session.updatedAt = Date.now();
  session.status = next.status === "finished" ? "completed" : "in-progress";
  return next;
};

export const applyPlayerMove = (args: {
  id: string;
  playerId: PlayerId;
  actions: GameActionPayload[];
  timestamp: number;
}): GameState => {
  const session = ensureSession(args.id);
  if (session.gameState.status !== "playing") {
    throw new Error("Game has already finished");
  }
  const move: Move = { actions: args.actions.map(toAction) };
  return applyActionToSession(session, {
    kind: "move",
    move,
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

export const resetSession = (id: string): GameState => {
  const session = ensureSession(id);
  session.gameState = createGameState(session.config);
  session.status = "waiting";
  session.updatedAt = Date.now();
  session.players.host.ready = false;
  session.players.joiner.ready = false;
  return session.gameState;
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
    throw new Error("Invalid socket token for session");
  }
  player.connected = args.connected;
  player.lastSeenAt = Date.now();
  session.updatedAt = Date.now();
};
