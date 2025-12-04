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
  resetSession,
  processRatingUpdate,
  type SessionPlayer,
} from "../games/store";
import { addLobbyConnection, removeLobbyConnection } from "./games";
import type { PlayerId } from "../../shared/domain/game-types";
import type { ClientMessage } from "../../shared/contracts/websocket-messages";

const { upgradeWebSocket, websocket } = createBunWebSocket();

interface SessionSocket {
  ctx: WSContext;
  sessionId: string;
  socketToken: string | null; // null for spectators
  role: "host" | "joiner" | "spectator";
}

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

const broadcast = (sessionId: string, message: unknown) => {
  const sockets = sessionSockets.get(sessionId);
  if (!sockets) return;
  const data = JSON.stringify(message);
  sockets.forEach((entry) => {
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

const sendMatchStatus = (sessionId: string) => {
  broadcast(sessionId, {
    type: "match-status",
    snapshot: getSessionSnapshot(sessionId),
  });
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
  const playerId = getSocketPlayerId(socket);
  if (playerId === null) return; // Spectators can't move

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
  }
};

const handleResign = async (socket: SessionSocket) => {
  const playerId = getSocketPlayerId(socket);
  if (playerId === null) return; // Spectators can't resign

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
  const playerId = getSocketPlayerId(socket);
  if (playerId === null) return; // Spectators can't give time

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
  const playerId = getSocketPlayerId(socket);
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
  const playerId = getSocketPlayerId(socket);
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
  const playerId = getSocketPlayerId(socket);
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
  const playerId = getSocketPlayerId(socket);
  if (playerId === null || socket.socketToken === null) return;

  sendToOpponent(socket.sessionId, socket.socketToken, {
    type: "draw-offer",
    playerId,
  });
  console.info("[ws] draw-offer processed", {
    sessionId: socket.sessionId,
    playerId,
  });
};

const handleDrawAccept = async (socket: SessionSocket) => {
  const playerId = getSocketPlayerId(socket);
  if (playerId === null) return; // Spectators can't accept draws

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
  const playerId = getSocketPlayerId(socket);
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
  const playerId = getSocketPlayerId(socket);
  if (playerId === null || socket.socketToken === null) return;

  sendToOpponent(socket.sessionId, socket.socketToken, {
    type: "rematch-offer",
    playerId,
  });
  console.info("[ws] rematch-offer processed", {
    sessionId: socket.sessionId,
    playerId,
  });
};

const handleRematchAccept = (socket: SessionSocket) => {
  const playerId = getSocketPlayerId(socket);
  if (playerId === null) return; // Spectators can't accept rematches

  resetSession(socket.sessionId);
  console.info("[ws] rematch-accept processed", {
    sessionId: socket.sessionId,
    playerId,
  });
  broadcast(socket.sessionId, {
    type: "state",
    state: getSerializedState(socket.sessionId),
  });
  sendMatchStatus(socket.sessionId);
  // Note: Game will become in-progress again when first move is made,
  // which will trigger broadcastLiveGamesUpsert
};

const handleRematchReject = (socket: SessionSocket) => {
  const playerId = getSocketPlayerId(socket);
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
      if (session.status === "waiting" || session.status === "ready") {
        return c.text("Game not yet in progress", 400);
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
            };
            addSocket(entry);
            incrementSpectatorCount(sessionId);
            broadcastLiveGamesUpsert(sessionId); // Update spectator count in list
            console.info("[ws] spectator connected", { sessionId });
            sendStateOnce(entry);
            sendMatchStatusOnce(entry);
          } else {
            // Player connection
            const entry: SessionSocket = {
              ctx: ws,
              sessionId,
              socketToken: socketToken!,
              role: player!.role,
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

          // Spectators can only send ping messages
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
