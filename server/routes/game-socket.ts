import type { Hono, MiddlewareHandler, Context } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import {
  applyPlayerMove,
  getSerializedState,
  getSession,
  getSessionSnapshot,
  resolveSessionForSocketToken,
  resignGame,
  updateConnectionState,
  listMatchmakingGames,
  listLiveGames,
  getLiveGameSummary,
  incrementSpectatorCount,
  decrementSpectatorCount,
  giveTime,
  acceptDraw,
  rejectDraw,
  acceptTakeback,
  rejectTakeback,
  createRematchSession,
  type RematchSessionResult,
  processRatingUpdate,
  type SessionPlayer,
  assignChatGuestIndex,
} from "../games/store";
import { moderateMessage } from "../chat/moderation";
import { canSendMessage, clearRateLimitEntry } from "../chat/rate-limiter";
import { persistCompletedGame } from "../games/persistence";
import { addLobbyConnection, removeLobbyConnection } from "./games";
import type { PlayerId } from "../../shared/domain/game-types";
import type {
  ClientMessage,
  ActionRequestMessage,
  ChatChannel,
  ChatErrorCode,
} from "../../shared/contracts/websocket-messages";
import type {
  ActionNackCode,
  RematchDecision,
} from "../../shared/contracts/controller-actions";
import { sendBotRequest } from "./custom-bot-socket";

const { upgradeWebSocket, websocket } = createBunWebSocket();

interface SessionSocket {
  ctx: WSContext;
  sessionId: string;
  socketToken: string | null; // null for spectators
  role: "host" | "joiner" | "spectator";
  id: string; // Unique identifier for this socket connection
}

let nextSocketId = 0;
const generateSocketId = (): string => {
  nextSocketId += 1;
  return `socket-${nextSocketId}-${Date.now()}`;
};

/**
 * Get the current playerId for a socket from the session.
 * This is dynamic because playerIds can swap after a rematch.
 * Returns null for spectators.
 */
const getSocketPlayerId = (socket: SessionSocket): PlayerId | null => {
  if (socket.role === "spectator") return null;
  const session = getSession(socket.sessionId);
  return socket.role === "host"
    ? session.players.host.playerId
    : session.players.joiner.playerId;
};

/**
 * Check if the current active player is a custom bot and send them a move request.
 * Called after any state change that might change whose turn it is.
 */
const notifyCustomBotIfActive = (sessionId: string): void => {
  const session = getSession(sessionId);
  if (session.gameState.status !== "playing") return;

  const activeTurn = session.gameState.turn;

  // Find which player is active
  const activePlayer =
    session.players.host.playerId === activeTurn
      ? session.players.host
      : session.players.joiner;

  // If the active player is a custom bot, send them a move request
  if (activePlayer.configType === "custom-bot") {
    sendBotRequest(sessionId, activePlayer.role, "move");
  }
};

const ensureAuthorizedPlayer = (
  socket: SessionSocket,
  action: string,
): PlayerId | null => {
  if (socket.role === "spectator" || socket.socketToken === null) {
    socket.ctx.send(
      JSON.stringify({
        type: "error",
        message: "Only active players can perform that action.",
      }),
    );
    console.warn("[ws] blocked spectator action", {
      sessionId: socket.sessionId,
      action,
    });
    return null;
  }

  const session = getSession(socket.sessionId);
  const expectedToken =
    socket.role === "host"
      ? session.players.host.socketToken
      : session.players.joiner.socketToken;

  if (expectedToken !== socket.socketToken) {
    socket.ctx.send(
      JSON.stringify({
        type: "error",
        message: "This connection is no longer authorized for the game.",
      }),
    );
    console.warn("[ws] blocked stale token action", {
      sessionId: socket.sessionId,
      action,
      socketToken: socket.socketToken,
    });
    return null;
  }

  return getSocketPlayerId(socket);
};

const sessionSockets = new Map<string, Set<SessionSocket>>();
const contextEntryMap = new WeakMap<WSContext, SessionSocket>();
const rawSocketMap = new WeakMap<object, SessionSocket>();

const mapSocketContext = (ctx: WSContext, entry: SessionSocket) => {
  contextEntryMap.set(ctx, entry);
  if (ctx.raw && typeof ctx.raw === "object") {
    rawSocketMap.set(ctx.raw, entry);
  }
};

const getEntryForContext = (ctx: WSContext): SessionSocket | undefined => {
  const direct = contextEntryMap.get(ctx);
  if (direct) return direct;
  if (ctx.raw && typeof ctx.raw === "object") {
    return rawSocketMap.get(ctx.raw);
  }
  return undefined;
};

const addSocket = (entry: SessionSocket) => {
  const sockets =
    sessionSockets.get(entry.sessionId) ?? new Set<SessionSocket>();
  sockets.add(entry);
  sessionSockets.set(entry.sessionId, sockets);
  mapSocketContext(entry.ctx, entry);
};

const removeSocket = (entry: SessionSocket) => {
  const sockets = sessionSockets.get(entry.sessionId);
  if (sockets) {
    sockets.delete(entry);
    if (sockets.size === 0) {
      sessionSockets.delete(entry.sessionId);
    }
  }
  contextEntryMap.delete(entry.ctx);
  if (entry.ctx.raw && typeof entry.ctx.raw === "object") {
    rawSocketMap.delete(entry.ctx.raw);
  }
};

export const broadcast = (sessionId: string, message: unknown) => {
  const sockets = sessionSockets.get(sessionId);
  if (!sockets) return;
  const data = JSON.stringify(message);
  sockets.forEach((entry) => {
    const rawSocket =
      entry.ctx.raw && typeof entry.ctx.raw === "object"
        ? (entry.ctx.raw as WebSocket)
        : null;
    const readyState =
      rawSocket && typeof rawSocket.readyState === "number"
        ? rawSocket.readyState
        : undefined;
    console.debug("[broadcast]", {
      sessionId,
      messageType:
        typeof message === "object" && message !== null
          ? (message as { type?: string }).type
          : undefined,
      role: entry.role,
      socketToken: entry.socketToken,
      hasWebSocket: !!rawSocket,
      readyState,
    });
    try {
      entry.ctx.send(data);
    } catch (error) {
      console.error("Failed to send websocket payload", {
        error,
        sessionId,
        socketToken: entry.socketToken,
      });
    }
  });
};

/**
 * Send a message to the opponent only (not to the sender or spectators).
 * Used for offers (draw, takeback, rematch) which should only go to the other player.
 */
const sendToOpponent = (
  sessionId: string,
  senderSocketToken: string,
  message: unknown,
) => {
  const sockets = sessionSockets.get(sessionId);
  if (!sockets) return;
  const data = JSON.stringify(message);
  sockets.forEach((entry) => {
    if (entry.socketToken === senderSocketToken) return; // Skip sender
    if (entry.role === "spectator") return; // Skip spectators
    try {
      entry.ctx.send(data);
    } catch (error) {
      console.error("Failed to send websocket payload to opponent", {
        error,
        sessionId,
        socketToken: entry.socketToken,
      });
    }
  });
};

export const sendMatchStatus = (sessionId: string) => {
  broadcast(sessionId, {
    type: "match-status",
    snapshot: getSessionSnapshot(sessionId),
  });
};

export const broadcastRematchStarted = (
  sessionId: string,
  result: RematchSessionResult,
) => {
  const sockets = sessionSockets.get(sessionId);
  if (!sockets) return;

  sockets.forEach((entry) => {
    const payloadBase = {
      type: "rematch-started" as const,
      newGameId: result.newSession.id,
    };
    if (entry.role === "spectator") {
      try {
        entry.ctx.send(JSON.stringify(payloadBase));
      } catch (error) {
        console.error("Failed to send rematch-started to spectator", {
          error,
          sessionId,
        });
      }
      return;
    }
    const seat =
      entry.role === "host"
        ? result.seatCredentials.host
        : result.seatCredentials.joiner;
    try {
      entry.ctx.send(
        JSON.stringify({
          ...payloadBase,
          seat,
        }),
      );
    } catch (error) {
      console.error("Failed to send rematch-started payload", {
        error,
        sessionId,
        socketRole: entry.role,
      });
    }
  });
};

const ensureRematchSession = (
  sessionId: string,
): {
  kind: "started" | "already-started";
  result: RematchSessionResult;
} => {
  const session = getSession(sessionId);
  if (session.nextGameId && session.nextGameSeatCredentials) {
    const existingResult: RematchSessionResult = {
      newSession: getSession(session.nextGameId),
      seatCredentials: session.nextGameSeatCredentials,
    };
    return { kind: "already-started", result: existingResult };
  }
  const result = createRematchSession(sessionId);
  return { kind: "started", result };
};

// ============================================================================
// Live Games WebSocket (for /live-games page)
// ============================================================================

const liveGamesConnections = new Set<WebSocket>();

export const addLiveGamesConnection = (ws: WebSocket) => {
  liveGamesConnections.add(ws);
};

export const removeLiveGamesConnection = (ws: WebSocket) => {
  liveGamesConnections.delete(ws);
};

/**
 * Broadcast an upsert (add or update) for a live game.
 * Called when a game becomes in-progress, on each move, and when spectator count changes.
 */
export const broadcastLiveGamesUpsert = (gameId: string) => {
  const summary = getLiveGameSummary(gameId);
  if (!summary) return;
  const message = JSON.stringify({ type: "upsert", game: summary });
  liveGamesConnections.forEach((ws) => {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    } catch (error) {
      console.error("Failed to broadcast live games upsert:", error);
    }
  });
};

/**
 * Broadcast removal of a game from the live list.
 * Called when a game ends (by win, resign, draw, or timeout).
 */
export const broadcastLiveGamesRemove = (gameId: string) => {
  const message = JSON.stringify({ type: "remove", gameId });
  liveGamesConnections.forEach((ws) => {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    } catch (error) {
      console.error("Failed to broadcast live games remove:", error);
    }
  });
};

const sendWelcome = (entry: SessionSocket) => {
  try {
    entry.ctx.send(
      JSON.stringify({
        type: "welcome",
        socketId: entry.id,
      }),
    );
  } catch (error) {
    console.error("Failed to send welcome message", {
      error,
      sessionId: entry.sessionId,
      socketToken: entry.socketToken,
    });
  }
};

const sendStateOnce = (entry: SessionSocket) => {
  try {
    entry.ctx.send(
      JSON.stringify({
        type: "state",
        state: getSerializedState(entry.sessionId),
      }),
    );
  } catch (error) {
    console.error("Failed to send initial state snapshot", {
      error,
      sessionId: entry.sessionId,
      socketToken: entry.socketToken,
    });
  }
};

const sendMatchStatusOnce = (entry: SessionSocket) => {
  try {
    entry.ctx.send(
      JSON.stringify({
        type: "match-status",
        snapshot: getSessionSnapshot(entry.sessionId),
      }),
    );
  } catch (error) {
    console.error("Failed to send match status snapshot", {
      error,
      sessionId: entry.sessionId,
      socketToken: entry.socketToken,
    });
  }
};

const parseMessage = (raw: string | ArrayBuffer) => {
  if (typeof raw !== "string") {
    throw new Error("Invalid message format");
  }
  return JSON.parse(raw) as ClientMessage;
};

const handleMove = async (socket: SessionSocket, message: ClientMessage) => {
  if (message.type !== "submit-move") return;
  const playerId = ensureAuthorizedPlayer(socket, "submit-move");
  if (playerId === null) return;

  const newState = applyPlayerMove({
    id: socket.sessionId,
    playerId,
    move: message.move,
    timestamp: Date.now(),
  });
  console.info("[ws] move processed", {
    sessionId: socket.sessionId,
    playerId,
    actionCount: message.move?.actions?.length ?? 0,
  });

  // Process rating update and send match-status if game ended
  if (newState.status === "finished") {
    await processRatingUpdate(socket.sessionId);
    try {
      await persistCompletedGame(getSession(socket.sessionId));
    } catch (error) {
      console.error("[persistence] failed after move", {
        error,
        sessionId: socket.sessionId,
      });
    }
    // Broadcast removal from live games list
    broadcastLiveGamesRemove(socket.sessionId);
  } else {
    // Broadcast upsert for live games list (game became in-progress or move count updated)
    broadcastLiveGamesUpsert(socket.sessionId);
  }

  broadcast(socket.sessionId, {
    type: "state",
    state: getSerializedState(socket.sessionId),
  });

  // Only send match-status when game ends (ratings changed)
  if (newState.status === "finished") {
    sendMatchStatus(socket.sessionId);
  } else {
    // If game is still playing, check if next player is a custom bot
    notifyCustomBotIfActive(socket.sessionId);
  }
};

const handleResign = async (socket: SessionSocket) => {
  const playerId = ensureAuthorizedPlayer(socket, "resign");
  if (playerId === null) return;

  const newState = resignGame({
    id: socket.sessionId,
    playerId,
    timestamp: Date.now(),
  });
  console.info("[ws] resign processed", {
    sessionId: socket.sessionId,
    playerId,
  });

  // Process rating update if game ended
  if (newState.status === "finished") {
    await processRatingUpdate(socket.sessionId);
    try {
      await persistCompletedGame(getSession(socket.sessionId));
    } catch (error) {
      console.error("[persistence] failed after resign", {
        error,
        sessionId: socket.sessionId,
      });
    }
    // Broadcast removal from live games list
    broadcastLiveGamesRemove(socket.sessionId);
  }

  broadcast(socket.sessionId, {
    type: "state",
    state: getSerializedState(socket.sessionId),
  });
  sendMatchStatus(socket.sessionId);
};

const handleGiveTime = (socket: SessionSocket, seconds: number) => {
  const playerId = ensureAuthorizedPlayer(socket, "give-time");
  if (playerId === null) return;

  giveTime({
    id: socket.sessionId,
    playerId,
    seconds,
  });
  console.info("[ws] give-time processed", {
    sessionId: socket.sessionId,
    playerId,
    seconds,
  });
  broadcast(socket.sessionId, {
    type: "state",
    state: getSerializedState(socket.sessionId),
  });
};

const handleTakebackOffer = (socket: SessionSocket) => {
  const playerId = ensureAuthorizedPlayer(socket, "takeback-offer");
  if (playerId === null || socket.socketToken === null) return;

  sendToOpponent(socket.sessionId, socket.socketToken, {
    type: "takeback-offer",
    playerId,
  });
  console.info("[ws] takeback-offer processed", {
    sessionId: socket.sessionId,
    playerId,
  });
};

const handleTakebackAccept = (socket: SessionSocket) => {
  const playerId = ensureAuthorizedPlayer(socket, "takeback-accept");
  if (playerId === null) return;

  acceptTakeback({
    id: socket.sessionId,
    playerId,
  });
  console.info("[ws] takeback-accept processed", {
    sessionId: socket.sessionId,
    playerId,
  });
  broadcast(socket.sessionId, {
    type: "state",
    state: getSerializedState(socket.sessionId),
  });
};

const handleTakebackReject = (socket: SessionSocket) => {
  const playerId = ensureAuthorizedPlayer(socket, "takeback-reject");
  if (playerId === null) return;

  rejectTakeback({
    id: socket.sessionId,
    playerId,
  });
  broadcast(socket.sessionId, {
    type: "takeback-rejected",
    playerId,
  });
  console.info("[ws] takeback-reject processed", {
    sessionId: socket.sessionId,
    playerId,
  });
};

const handleDrawOffer = (socket: SessionSocket) => {
  const playerId = ensureAuthorizedPlayer(socket, "draw-offer");
  if (playerId === null || socket.socketToken === null) return;

  const session = getSession(socket.sessionId);
  const opponentRole = socket.role === "host" ? "joiner" : "host";
  const opponent =
    opponentRole === "host" ? session.players.host : session.players.joiner;

  // If opponent is a custom bot, handle specially
  if (opponent.configType === "custom-bot") {
    // If it's the bot's turn, reject immediately (bot is busy thinking)
    if (session.gameState.turn === opponent.playerId) {
      socket.ctx.send(
        JSON.stringify({
          type: "draw-rejected",
          playerId: opponent.playerId,
        }),
      );
      console.info("[ws] draw-offer rejected (bot is thinking)", {
        sessionId: socket.sessionId,
        playerId,
      });
      return;
    }
    // Otherwise, send draw request to bot
    sendBotRequest(socket.sessionId, opponentRole, "draw", playerId);
  } else {
    // Regular player opponent - send via WebSocket
    sendToOpponent(socket.sessionId, socket.socketToken, {
      type: "draw-offer",
      playerId,
    });
  }

  console.info("[ws] draw-offer processed", {
    sessionId: socket.sessionId,
    playerId,
  });
};

const handleDrawAccept = async (socket: SessionSocket) => {
  const playerId = ensureAuthorizedPlayer(socket, "draw-accept");
  if (playerId === null) return;

  const newState = acceptDraw({
    id: socket.sessionId,
    playerId,
  });
  console.info("[ws] draw-accept processed", {
    sessionId: socket.sessionId,
    playerId,
  });

  // Process rating update if game ended
  if (newState.status === "finished") {
    await processRatingUpdate(socket.sessionId);
    try {
      await persistCompletedGame(getSession(socket.sessionId));
    } catch (error) {
      console.error("[persistence] failed after draw", {
        error,
        sessionId: socket.sessionId,
      });
    }
    // Broadcast removal from live games list
    broadcastLiveGamesRemove(socket.sessionId);
  }

  broadcast(socket.sessionId, {
    type: "state",
    state: getSerializedState(socket.sessionId),
  });
  sendMatchStatus(socket.sessionId);
};

const handleDrawReject = (socket: SessionSocket) => {
  const playerId = ensureAuthorizedPlayer(socket, "draw-reject");
  if (playerId === null) return;

  rejectDraw({
    id: socket.sessionId,
    playerId,
  });
  broadcast(socket.sessionId, {
    type: "draw-rejected",
    playerId,
  });
  console.info("[ws] draw-reject processed", {
    sessionId: socket.sessionId,
    playerId,
  });
};

const handleRematchOffer = (socket: SessionSocket) => {
  const playerId = ensureAuthorizedPlayer(socket, "rematch-offer");
  if (playerId === null || socket.socketToken === null) return;

  // Send to regular player opponent
  sendToOpponent(socket.sessionId, socket.socketToken, {
    type: "rematch-offer",
    playerId,
  });

  // Also notify custom bot if opponent is a custom bot
  const session = getSession(socket.sessionId);
  const opponentRole = socket.role === "host" ? "joiner" : "host";
  const opponent =
    opponentRole === "host" ? session.players.host : session.players.joiner;

  if (opponent.configType === "custom-bot") {
    sendBotRequest(socket.sessionId, opponentRole, "rematch", playerId);
  }

  console.info("[ws] rematch-offer processed", {
    sessionId: socket.sessionId,
    playerId,
  });
};

const handleRematchAccept = (socket: SessionSocket) => {
  const playerId = ensureAuthorizedPlayer(socket, "rematch-accept");
  if (playerId === null) return;

  try {
    const outcome = ensureRematchSession(socket.sessionId);
    broadcastRematchStarted(socket.sessionId, outcome.result);
    console.info("[ws] rematch-accept processed", {
      sessionId: socket.sessionId,
      playerId,
      rematchStatus: outcome.kind,
      newGameId: outcome.result.newSession.id,
    });
  } catch (error) {
    console.error("[ws] rematch-accept failed", {
      error,
      sessionId: socket.sessionId,
      playerId,
    });
    socket.ctx.send(
      JSON.stringify({
        type: "error",
        message: "Unable to start a rematch right now.",
      }),
    );
  }
};

const handleRematchReject = (socket: SessionSocket) => {
  const playerId = ensureAuthorizedPlayer(socket, "rematch-reject");
  if (playerId === null) return;

  broadcast(socket.sessionId, {
    type: "rematch-rejected",
    playerId,
  });
  console.info("[ws] rematch-reject processed", {
    sessionId: socket.sessionId,
    playerId,
  });
};

// ============================================================================
// Chat Handlers
// ============================================================================

/**
 * Get the number of players per team for a variant.
 * Used to determine if team chat should be enabled.
 */
const getPlayersPerTeam = (variant: string): number => {
  // Currently all variants are 1v1, but this is structured for future team variants
  switch (variant) {
    case "standard":
    case "classic":
    case "freestyle":
    default:
      return 1;
  }
};

interface ChatChannelValidation {
  allowed: boolean;
  reason?: string;
}

const validateChatChannelAccess = (
  socket: SessionSocket,
  channel: ChatChannel,
): ChatChannelValidation => {
  const session = getSession(socket.sessionId);
  const isSpectator = socket.role === "spectator";

  if (channel === "game") {
    if (isSpectator) {
      return {
        allowed: false,
        reason: "Game chat is disabled for spectators.",
      };
    }
    return { allowed: true };
  }

  if (channel === "team") {
    if (isSpectator) {
      return {
        allowed: false,
        reason: "Team chat is disabled for spectators.",
      };
    }
    const playersPerTeam = getPlayersPerTeam(session.config.variant);
    if (playersPerTeam <= 1) {
      return { allowed: false, reason: "Team chat is disabled in 1v1 games." };
    }
    return { allowed: true };
  }

  if (channel === "audience") {
    if (!isSpectator) {
      return {
        allowed: false,
        reason: "Audience chat is only for spectators.",
      };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: "Invalid channel." };
};

const getChatSenderName = (socket: SessionSocket): string => {
  const session = getSession(socket.sessionId);

  if (socket.role === "spectator") {
    // Spectators are always guests - use the unique socket id
    const guestIndex = assignChatGuestIndex(socket.sessionId, socket.id);
    return `Guest ${guestIndex}`;
  }

  // Get the player for this socket
  const player =
    socket.role === "host" ? session.players.host : session.players.joiner;

  // If the player has a proper display name from auth, use it
  if (player.authUserId && player.displayName) {
    return player.displayName;
  }

  // Otherwise, assign a guest index based on their socket token (or unique id as fallback)
  const socketId = socket.socketToken ?? socket.id;
  const guestIndex = assignChatGuestIndex(socket.sessionId, socketId);
  return `Guest ${guestIndex}`;
};

const sendChatError = (
  socket: SessionSocket,
  code: ChatErrorCode,
  message: string,
) => {
  socket.ctx.send(
    JSON.stringify({
      type: "chat-error",
      code,
      message,
    }),
  );
};

const broadcastChatMessage = (
  sessionId: string,
  channel: ChatChannel,
  senderId: string,
  senderName: string,
  text: string,
) => {
  const sockets = sessionSockets.get(sessionId);
  if (!sockets) return;

  const message = JSON.stringify({
    type: "chat-message",
    channel,
    senderId,
    senderName,
    text,
    timestamp: Date.now(),
  });

  sockets.forEach((entry) => {
    const isSpectator = entry.role === "spectator";

    // Filter based on channel visibility
    if (channel === "game" && isSpectator) return;
    if (channel === "audience" && !isSpectator) return;
    // For team chat, would need to filter by team - but currently all variants are 1v1

    try {
      entry.ctx.send(message);
    } catch (error) {
      console.error("Failed to send chat message", {
        error,
        sessionId,
        role: entry.role,
      });
    }
  });
};

const handleChatMessage = (
  socket: SessionSocket,
  channel: ChatChannel,
  text: string,
) => {
  // Validate channel access
  const channelValidation = validateChatChannelAccess(socket, channel);
  if (!channelValidation.allowed) {
    sendChatError(
      socket,
      "INVALID_CHANNEL",
      channelValidation.reason ?? "Invalid channel",
    );
    return;
  }

  // Rate limiting - use the unique socket id
  const socketId = socket.id;
  if (!canSendMessage(socketId)) {
    sendChatError(
      socket,
      "RATE_LIMITED",
      "Please wait before sending another message.",
    );
    return;
  }

  // Content moderation
  const modResult = moderateMessage(text);
  if (!modResult.allowed) {
    const errorMessage =
      modResult.code === "TOO_LONG"
        ? "Message too long."
        : "Message not allowed.";
    sendChatError(socket, modResult.code ?? "MODERATION", errorMessage);
    return;
  }

  // Get sender display name
  const senderName = getChatSenderName(socket);

  // Broadcast to appropriate recipients (include socket.id for echo detection)
  broadcastChatMessage(socket.sessionId, channel, socket.id, senderName, text);

  console.info("[ws] chat-message processed", {
    sessionId: socket.sessionId,
    channel,
    senderName,
    textLength: text.length,
  });
};

const sendActionAck = (
  socket: SessionSocket,
  message: ActionRequestMessage,
) => {
  socket.ctx.send(
    JSON.stringify({
      type: "actionAck",
      requestId: message.requestId,
      action: message.action,
      serverTime: Date.now(),
    }),
  );
};

const sendActionNack = (
  socket: SessionSocket,
  message: ActionRequestMessage,
  code: ActionNackCode,
  options?: { retryable?: boolean; error?: unknown },
) => {
  socket.ctx.send(
    JSON.stringify({
      type: "actionNack",
      requestId: message.requestId,
      action: message.action,
      code,
      message:
        options?.error instanceof Error ? options.error.message : undefined,
      retryable: options?.retryable ?? false,
      serverTime: Date.now(),
    }),
  );
};

const handleActionRequest = async (
  socket: SessionSocket,
  message: ActionRequestMessage,
) => {
  switch (message.action) {
    case "resign": {
      const playerId = ensureAuthorizedPlayer(socket, "resign");
      if (playerId === null) {
        sendActionNack(socket, message, "UNAUTHORIZED");
        return;
      }
      try {
        const newState = resignGame({
          id: socket.sessionId,
          playerId,
          timestamp: Date.now(),
        });
        sendActionAck(socket, message);
        console.info("[ws] action-resign processed", {
          sessionId: socket.sessionId,
          playerId,
        });
        if (newState.status === "finished") {
          await processRatingUpdate(socket.sessionId);
          try {
            await persistCompletedGame(getSession(socket.sessionId));
          } catch (error) {
            console.error("[persistence] failed after action resign", {
              error,
              sessionId: socket.sessionId,
            });
          }
          broadcastLiveGamesRemove(socket.sessionId);
        }
        broadcast(socket.sessionId, {
          type: "state",
          state: getSerializedState(socket.sessionId),
        });
        sendMatchStatus(socket.sessionId);
      } catch (error) {
        console.error("[ws] action-resign failed", {
          error,
          sessionId: socket.sessionId,
        });
        sendActionNack(socket, message, "INTERNAL_ERROR", { error });
      }
      return;
    }
    case "offerDraw": {
      const playerId = ensureAuthorizedPlayer(socket, "draw-offer");
      if (playerId === null || socket.socketToken === null) {
        sendActionNack(socket, message, "UNAUTHORIZED");
        return;
      }
      sendToOpponent(socket.sessionId, socket.socketToken, {
        type: "draw-offer",
        playerId,
      });
      sendActionAck(socket, message);
      console.info("[ws] action-offerDraw processed", {
        sessionId: socket.sessionId,
        playerId,
      });
      return;
    }
    case "requestTakeback": {
      const playerId = ensureAuthorizedPlayer(socket, "takeback-offer");
      if (playerId === null || socket.socketToken === null) {
        sendActionNack(socket, message, "UNAUTHORIZED");
        return;
      }
      sendToOpponent(socket.sessionId, socket.socketToken, {
        type: "takeback-offer",
        playerId,
      });
      sendActionAck(socket, message);
      console.info("[ws] action-requestTakeback processed", {
        sessionId: socket.sessionId,
        playerId,
      });
      return;
    }
    case "giveTime": {
      const seconds = (message.payload as { seconds?: number } | undefined)
        ?.seconds;
      if (
        typeof seconds !== "number" ||
        Number.isNaN(seconds) ||
        seconds <= 0
      ) {
        sendActionNack(socket, message, "INVALID_SECONDS");
        return;
      }
      const playerId = ensureAuthorizedPlayer(socket, "give-time");
      if (playerId === null) {
        sendActionNack(socket, message, "UNAUTHORIZED");
        return;
      }
      try {
        giveTime({
          id: socket.sessionId,
          playerId,
          seconds,
        });
        sendActionAck(socket, message);
        console.info("[ws] action-giveTime processed", {
          sessionId: socket.sessionId,
          playerId,
          seconds,
        });
        broadcast(socket.sessionId, {
          type: "state",
          state: getSerializedState(socket.sessionId),
        });
      } catch (error) {
        console.error("[ws] action-giveTime failed", {
          error,
          sessionId: socket.sessionId,
        });
        sendActionNack(socket, message, "INTERNAL_ERROR", { error });
      }
      return;
    }
    case "offerRematch": {
      const playerId = ensureAuthorizedPlayer(socket, "rematch-offer");
      if (playerId === null || socket.socketToken === null) {
        sendActionNack(socket, message, "UNAUTHORIZED");
        return;
      }
      sendToOpponent(socket.sessionId, socket.socketToken, {
        type: "rematch-offer",
        playerId,
      });
      sendActionAck(socket, message);
      console.info("[ws] action-offerRematch processed", {
        sessionId: socket.sessionId,
        playerId,
      });
      return;
    }
    case "respondRematch": {
      const decision = (
        message.payload as { decision?: RematchDecision } | undefined
      )?.decision;
      if (decision !== "accepted" && decision !== "declined") {
        sendActionNack(socket, message, "INVALID_PAYLOAD");
        return;
      }
      const playerId = ensureAuthorizedPlayer(
        socket,
        decision === "accepted" ? "rematch-accept" : "rematch-reject",
      );
      if (playerId === null) {
        sendActionNack(socket, message, "UNAUTHORIZED");
        return;
      }
      try {
        if (decision === "accepted") {
          const outcome = ensureRematchSession(socket.sessionId);
          sendActionAck(socket, message);
          broadcastRematchStarted(socket.sessionId, outcome.result);
          console.info("[ws] action-respondRematch accept processed", {
            sessionId: socket.sessionId,
            playerId,
            rematchStatus: outcome.kind,
            newGameId: outcome.result.newSession.id,
          });
        } else {
          sendActionAck(socket, message);
          broadcast(socket.sessionId, {
            type: "rematch-rejected",
            playerId,
          });
          console.info("[ws] action-respondRematch decline processed", {
            sessionId: socket.sessionId,
            playerId,
          });
        }
      } catch (error) {
        console.error("[ws] action-respondRematch failed", {
          error,
          sessionId: socket.sessionId,
          playerId,
        });
        const nackCode: ActionNackCode =
          decision === "accepted" ? "REMATCH_NOT_AVAILABLE" : "INTERNAL_ERROR";
        sendActionNack(socket, message, nackCode, { error });
      }
      return;
    }
    default: {
      sendActionNack(socket, message, "UNKNOWN_ACTION");
    }
  }
};

const handleClientMessage = async (
  socket: SessionSocket,
  raw: string | ArrayBuffer,
) => {
  let payload: ClientMessage;
  try {
    payload = parseMessage(raw);
  } catch (error) {
    socket.ctx.send(
      JSON.stringify({
        type: "error",
        message: (error as Error).message ?? "Malformed message",
      }),
    );
    return;
  }

  switch (payload.type) {
    case "submit-move":
      try {
        await handleMove(socket, payload);
      } catch (error) {
        socket.ctx.send(
          JSON.stringify({
            type: "error",
            message:
              error instanceof Error
                ? error.message
                : "Move could not be applied",
          }),
        );
      }
      break;
    case "resign":
      await handleResign(socket);
      break;
    case "give-time":
      handleGiveTime(socket, payload.seconds);
      break;
    case "takeback-offer":
      handleTakebackOffer(socket);
      break;
    case "takeback-accept":
      handleTakebackAccept(socket);
      break;
    case "takeback-reject":
      handleTakebackReject(socket);
      break;
    case "draw-offer":
      handleDrawOffer(socket);
      break;
    case "draw-accept":
      await handleDrawAccept(socket);
      break;
    case "draw-reject":
      handleDrawReject(socket);
      break;
    case "rematch-offer":
      handleRematchOffer(socket);
      break;
    case "rematch-accept":
      handleRematchAccept(socket);
      break;
    case "rematch-reject":
      handleRematchReject(socket);
      break;
    case "action-request":
      await handleActionRequest(socket, payload);
      break;
    case "chat-message":
      handleChatMessage(socket, payload.channel, payload.text);
      break;
    case "ping":
      socket.ctx.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      break;
    default:
      socket.ctx.send(
        JSON.stringify({ type: "error", message: "Unknown message type" }),
      );
  }
};

interface GameSocketMeta {
  sessionId: string;
  socketToken: string | null; // null for spectators
  player: SessionPlayer | null; // null for spectators
  isSpectator: boolean;
}

const checkOrigin = (c: Context): boolean => {
  const origin = c.req.header("origin");
  const isDev = process.env.NODE_ENV !== "production";

  const allowedOrigins = isDev
    ? ["http://localhost:5173"]
    : ["https://wallgame.fly.dev"];

  if (origin && !allowedOrigins.includes(origin)) {
    console.warn("[ws] rejected connection from unauthorized origin", {
      origin,
      allowedOrigins,
    });
    return false;
  }
  return true;
};

const originCheckMiddleware: MiddlewareHandler = async (c, next) => {
  if (!checkOrigin(c)) {
    return c.text("Unauthorized origin", 403);
  }
  await next();
};

const gameSocketAuth: MiddlewareHandler = async (c, next) => {
  if (!checkOrigin(c)) {
    return c.text("Unauthorized origin", 403);
  }

  const sessionId = c.req.param("id");
  if (!sessionId) {
    return c.text("Missing session id", 400);
  }

  const socketToken = c.req.query("token");

  // If no token provided, this is a spectator connection
  if (!socketToken) {
    // Verify game exists and is spectatable
    try {
      const session = getSession(sessionId);
      const isSpectatable =
        session.status === "ready" || session.status === "in-progress";
      if (!isSpectatable) {
        const message =
          session.status === "waiting"
            ? "Game not yet spectatable"
            : "Game not available for live spectating";
        return c.text(message, 400);
      }
      c.set("gameSocketMeta", {
        sessionId,
        socketToken: null,
        player: null,
        isSpectator: true,
      } satisfies GameSocketMeta);
      await next();
      return;
    } catch {
      return c.text("Game not found", 404);
    }
  }

  // Player connection with token
  const resolved = resolveSessionForSocketToken({
    id: sessionId,
    socketToken,
  });

  if (!resolved) {
    console.warn("[ws] rejected connection with invalid token", {
      sessionId,
      socketToken,
    });
    return c.text("Invalid socket token", 401);
  }

  c.set("gameSocketMeta", {
    sessionId,
    socketToken,
    player: resolved.player,
    isSpectator: false,
  } satisfies GameSocketMeta);

  await next();
};

export const registerGameSocketRoute = (app: Hono) => {
  app.get(
    "/ws/games/:id",
    gameSocketAuth,
    upgradeWebSocket((c) => {
      const meta = c.get("gameSocketMeta") as GameSocketMeta | undefined;
      if (!meta) {
        throw new Error("Game socket metadata missing");
      }
      const { sessionId, socketToken, player, isSpectator } = meta;

      return {
        onOpen(_event: Event, ws: WSContext) {
          if (isSpectator) {
            // Spectator connection
            const entry: SessionSocket = {
              ctx: ws,
              sessionId,
              socketToken: null,
              role: "spectator",
              id: generateSocketId(),
            };
            addSocket(entry);
            incrementSpectatorCount(sessionId);
            broadcastLiveGamesUpsert(sessionId); // Update spectator count in list
            console.info("[ws] spectator connected", { sessionId });
            sendWelcome(entry);
            sendStateOnce(entry);
            sendMatchStatusOnce(entry);
          } else {
            // Player connection
            const entry: SessionSocket = {
              ctx: ws,
              sessionId,
              socketToken: socketToken!,
              role: player!.role,
              id: generateSocketId(),
            };
            addSocket(entry);
            updateConnectionState({
              id: sessionId,
              socketToken: socketToken!,
              connected: true,
            });
            console.info("[ws] connected", {
              sessionId,
              socketToken,
              playerId: getSocketPlayerId(entry),
            });
            sendWelcome(entry);
            sendStateOnce(entry);
            sendMatchStatus(sessionId);
          }
        },
        onMessage(event: MessageEvent, ws: WSContext) {
          const entry = getEntryForContext(ws);
          if (!entry) {
            console.warn("[ws] received message for unknown socket");
            return;
          }

          const raw = event.data as string | ArrayBuffer;

          // Spectators can only send ping and chat messages
          if (entry.role === "spectator") {
            if (typeof raw === "string") {
              try {
                const msg = JSON.parse(raw) as { type?: string };
                if (msg.type === "ping") {
                  ws.send(
                    JSON.stringify({ type: "pong", timestamp: Date.now() }),
                  );
                  return;
                }
                if (msg.type === "chat-message") {
                  // Allow spectators to send chat messages (handled below)
                  void handleClientMessage(entry, raw).catch(
                    (error: unknown) => {
                      console.error("[ws] failed to handle spectator chat", {
                        error,
                        sessionId: entry.sessionId,
                      });
                      ws.send(
                        JSON.stringify({
                          type: "error",
                          message:
                            error instanceof Error
                              ? error.message
                              : "Chat message processing failed",
                        }),
                      );
                    },
                  );
                  return;
                }
              } catch {
                // Ignore parse errors
              }
            }
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Spectators cannot send game messages",
              }),
            );
            return;
          }

          void handleClientMessage(entry, raw).catch((error: unknown) => {
            console.error("[ws] failed to handle message", {
              error,
              sessionId: entry.sessionId,
              socketToken: entry.socketToken,
            });
            ws.send(
              JSON.stringify({
                type: "error",
                message:
                  error instanceof Error
                    ? error.message
                    : "Message processing failed",
              }),
            );
          });
        },
        onClose(_event: CloseEvent, ws: WSContext) {
          const entry = getEntryForContext(ws);
          if (!entry) {
            return;
          }
          removeSocket(entry);

          // Clean up chat rate limit entry
          clearRateLimitEntry(entry.id);

          if (entry.role === "spectator") {
            // Spectator disconnect
            decrementSpectatorCount(entry.sessionId);
            broadcastLiveGamesUpsert(entry.sessionId); // Update spectator count
            console.info("[ws] spectator disconnected", {
              sessionId: entry.sessionId,
            });
          } else {
            // Player disconnect
            updateConnectionState({
              id: entry.sessionId,
              socketToken: entry.socketToken!,
              connected: false,
            });
            sendMatchStatus(entry.sessionId);
            console.info("[ws] disconnected", {
              sessionId: entry.sessionId,
              socketToken: entry.socketToken,
            });
          }
        },
      };
    }),
  );

  // Lobby WebSocket for matchmaking game list
  app.get(
    "/ws/lobby",
    originCheckMiddleware,
    upgradeWebSocket(() => {
      return {
        onOpen(_event: Event, ws: WSContext) {
          // Store raw socket reference for lobby broadcasts
          if (ws.raw && typeof ws.raw === "object") {
            addLobbyConnection(ws.raw as WebSocket);
          }
          console.info("[ws-lobby] client connected");
          // Send current games immediately
          const games = listMatchmakingGames();
          ws.send(JSON.stringify({ type: "games", games }));
        },
        onMessage(event: MessageEvent, ws: WSContext) {
          // Handle ping messages to keep connection alive
          const raw = event.data as string | ArrayBuffer;
          if (typeof raw === "string") {
            try {
              const msg = JSON.parse(raw) as { type?: string };
              if (msg.type === "ping") {
                ws.send(
                  JSON.stringify({ type: "pong", timestamp: Date.now() }),
                );
              }
            } catch {
              // Ignore parse errors
            }
          }
        },
        onClose(_event: CloseEvent, ws: WSContext) {
          if (ws.raw && typeof ws.raw === "object") {
            removeLobbyConnection(ws.raw as WebSocket);
          }
          console.info("[ws-lobby] client disconnected");
        },
      };
    }),
  );

  // Live Games WebSocket for spectator list updates
  app.get(
    "/ws/live-games",
    originCheckMiddleware,
    upgradeWebSocket(() => {
      return {
        onOpen(_event: Event, ws: WSContext) {
          // Store raw socket reference for live games broadcasts
          if (ws.raw && typeof ws.raw === "object") {
            addLiveGamesConnection(ws.raw as WebSocket);
          }
          console.info("[ws-live-games] client connected");
          // Send current live games immediately
          const games = listLiveGames(100);
          const snapshotMsg = JSON.stringify({ type: "snapshot", games });
          console.info("[ws-live-games] sending snapshot", {
            gamesCount: games.length,
          });
          ws.send(snapshotMsg);
        },
        onMessage(event: MessageEvent, ws: WSContext) {
          // Handle ping messages to keep connection alive
          const raw = event.data as string | ArrayBuffer;
          if (typeof raw === "string") {
            try {
              const msg = JSON.parse(raw) as { type?: string };
              if (msg.type === "ping") {
                ws.send(
                  JSON.stringify({ type: "pong", timestamp: Date.now() }),
                );
              }
            } catch {
              // Ignore parse errors
            }
          }
        },
        onClose(_event: CloseEvent, ws: WSContext) {
          if (ws.raw && typeof ws.raw === "object") {
            removeLiveGamesConnection(ws.raw as WebSocket);
          }
          console.info("[ws-live-games] client disconnected");
        },
      };
    }),
  );

  return websocket;
};
