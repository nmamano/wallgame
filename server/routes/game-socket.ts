import type { Hono, MiddlewareHandler, Context } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import {
  applyPlayerMove,
  getSerializedState,
  getSessionSnapshot,
  resolveSessionForSocketToken,
  resignGame,
  updateConnectionState,
  listMatchmakingGames,
  giveTime,
  acceptDraw,
  rejectDraw,
  acceptTakeback,
  rejectTakeback,
  resetSession,
  type SessionPlayer,
} from "../games/store";
import { addLobbyConnection, removeLobbyConnection } from "./games";
import type { PlayerId } from "../../shared/domain/game-types";
import type { ClientMessage } from "../../shared/contracts/websocket-messages";

const { upgradeWebSocket, websocket } = createBunWebSocket();

interface SessionSocket {
  ctx: WSContext;
  playerId: PlayerId;
  sessionId: string;
  socketToken: string;
  role: "host" | "joiner";
}

const sessionSockets = new Map<string, Set<SessionSocket>>();
const contextEntryMap = new WeakMap<WSContext, SessionSocket>();
const rawSocketMap = new WeakMap<object, SessionSocket>();

const mapSocketContext = (ctx: WSContext, entry: SessionSocket) => {
  contextEntryMap.set(ctx, entry);
  if (ctx.raw && typeof ctx.raw === "object") {
    rawSocketMap.set(ctx.raw as object, entry);
  }
};

const getEntryForContext = (ctx: WSContext): SessionSocket | undefined => {
  const direct = contextEntryMap.get(ctx);
  if (direct) return direct;
  if (ctx.raw && typeof ctx.raw === "object") {
    return rawSocketMap.get(ctx.raw as object);
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
    rawSocketMap.delete(entry.ctx.raw as object);
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

const sendMatchStatus = (sessionId: string) => {
  broadcast(sessionId, {
    type: "match-status",
    snapshot: getSessionSnapshot(sessionId),
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

const parseMessage = (raw: string | ArrayBuffer) => {
  if (typeof raw !== "string") {
    throw new Error("Invalid message format");
  }
  return JSON.parse(raw) as ClientMessage;
};

const handleMove = (socket: SessionSocket, message: ClientMessage) => {
  if (message.type !== "submit-move") return;
  applyPlayerMove({
    id: socket.sessionId,
    playerId: socket.playerId,
    move: message.move,
    timestamp: Date.now(),
  });
  console.info("[ws] move processed", {
    sessionId: socket.sessionId,
    playerId: socket.playerId,
    actionCount: message.move?.actions?.length ?? 0,
  });
  broadcast(socket.sessionId, {
    type: "state",
    state: getSerializedState(socket.sessionId),
  });
  sendMatchStatus(socket.sessionId);
};

const handleResign = (socket: SessionSocket) => {
  resignGame({
    id: socket.sessionId,
    playerId: socket.playerId,
    timestamp: Date.now(),
  });
  console.info("[ws] resign processed", {
    sessionId: socket.sessionId,
    playerId: socket.playerId,
  });
  broadcast(socket.sessionId, {
    type: "state",
    state: getSerializedState(socket.sessionId),
  });
  sendMatchStatus(socket.sessionId);
};

const handleGiveTime = (socket: SessionSocket, seconds: number) => {
  giveTime({
    id: socket.sessionId,
    playerId: socket.playerId,
    seconds,
  });
  console.info("[ws] give-time processed", {
    sessionId: socket.sessionId,
    playerId: socket.playerId,
    seconds,
  });
  broadcast(socket.sessionId, {
    type: "state",
    state: getSerializedState(socket.sessionId),
  });
  sendMatchStatus(socket.sessionId);
};

const handleTakebackOffer = (socket: SessionSocket) => {
  broadcast(socket.sessionId, {
    type: "takeback-offer",
    playerId: socket.playerId,
  });
  console.info("[ws] takeback-offer processed", {
    sessionId: socket.sessionId,
    playerId: socket.playerId,
  });
};

const handleTakebackAccept = (socket: SessionSocket) => {
  acceptTakeback({
    id: socket.sessionId,
    playerId: socket.playerId,
  });
  console.info("[ws] takeback-accept processed", {
    sessionId: socket.sessionId,
    playerId: socket.playerId,
  });
  broadcast(socket.sessionId, {
    type: "state",
    state: getSerializedState(socket.sessionId),
  });
  sendMatchStatus(socket.sessionId);
};

const handleTakebackReject = (socket: SessionSocket) => {
  rejectTakeback({
    id: socket.sessionId,
    playerId: socket.playerId,
  });
  broadcast(socket.sessionId, {
    type: "takeback-rejected",
    playerId: socket.playerId,
  });
  console.info("[ws] takeback-reject processed", {
    sessionId: socket.sessionId,
    playerId: socket.playerId,
  });
};

const handleDrawOffer = (socket: SessionSocket) => {
  broadcast(socket.sessionId, {
    type: "draw-offer",
    playerId: socket.playerId,
  });
  console.info("[ws] draw-offer processed", {
    sessionId: socket.sessionId,
    playerId: socket.playerId,
  });
};

const handleDrawAccept = (socket: SessionSocket) => {
  acceptDraw({
    id: socket.sessionId,
    playerId: socket.playerId,
  });
  console.info("[ws] draw-accept processed", {
    sessionId: socket.sessionId,
    playerId: socket.playerId,
  });
  broadcast(socket.sessionId, {
    type: "state",
    state: getSerializedState(socket.sessionId),
  });
  sendMatchStatus(socket.sessionId);
};

const handleDrawReject = (socket: SessionSocket) => {
  rejectDraw({
    id: socket.sessionId,
    playerId: socket.playerId,
  });
  broadcast(socket.sessionId, {
    type: "draw-rejected",
    playerId: socket.playerId,
  });
  console.info("[ws] draw-reject processed", {
    sessionId: socket.sessionId,
    playerId: socket.playerId,
  });
};

const handleRematchOffer = (socket: SessionSocket) => {
  broadcast(socket.sessionId, {
    type: "rematch-offer",
    playerId: socket.playerId,
  });
  console.info("[ws] rematch-offer processed", {
    sessionId: socket.sessionId,
    playerId: socket.playerId,
  });
};

const handleRematchAccept = (socket: SessionSocket) => {
  resetSession(socket.sessionId);
  console.info("[ws] rematch-accept processed", {
    sessionId: socket.sessionId,
    playerId: socket.playerId,
  });
  broadcast(socket.sessionId, {
    type: "state",
    state: getSerializedState(socket.sessionId),
  });
  sendMatchStatus(socket.sessionId);
};

const handleRematchReject = (socket: SessionSocket) => {
  broadcast(socket.sessionId, {
    type: "rematch-rejected",
    playerId: socket.playerId,
  });
  console.info("[ws] rematch-reject processed", {
    sessionId: socket.sessionId,
    playerId: socket.playerId,
  });
};

const handleClientMessage = (
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
        handleMove(socket, payload);
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
      handleResign(socket);
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
      handleDrawAccept(socket);
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
  socketToken: string;
  player: SessionPlayer;
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
  // Check origin for security
  if (!checkOrigin(c)) {
    return c.text("Unauthorized origin", 403);
  }
  // Check origin for security
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
    return c.text("Unauthorized origin", 403);
  }

  const sessionId = c.req.param("id");
  if (!sessionId) {
    return c.text("Missing session id", 400);
  }
  const socketToken = c.req.query("token");
  if (!socketToken) {
    return c.text("Missing token", 400);
  }
  const confirmedToken = socketToken as string;
  const resolved = resolveSessionForSocketToken({
    id: sessionId,
    socketToken: confirmedToken,
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
    socketToken: confirmedToken,
    player: resolved.player,
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
      const { sessionId, socketToken, player } = meta;

      return {
        onOpen(_event: Event, ws: WSContext) {
          const entry: SessionSocket = {
            ctx: ws,
            playerId: player.playerId,
            sessionId,
            socketToken,
            role: player.role,
          };
          addSocket(entry);
          updateConnectionState({
            id: sessionId,
            socketToken,
            connected: true,
          });
          console.info("[ws] connected", {
            sessionId,
            socketToken,
            playerId: entry.playerId,
          });
          sendMatchStatus(sessionId);
          sendStateOnce(entry);
        },
        onMessage(event: MessageEvent, ws: WSContext) {
          const entry = getEntryForContext(ws);
          if (!entry) {
            console.warn("[ws] received message for unknown socket");
            return;
          }
          const payload = event.data as string | ArrayBuffer;
          try {
            handleClientMessage(entry, payload);
          } catch (error) {
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
          }
        },
        onClose(_event: CloseEvent, ws: WSContext) {
          const entry = getEntryForContext(ws);
          if (!entry) {
            return;
          }
          removeSocket(entry);
          updateConnectionState({
            id: entry.sessionId,
            socketToken: entry.socketToken,
            connected: false,
          });
          sendMatchStatus(entry.sessionId);
          console.info("[ws] disconnected", {
            sessionId: entry.sessionId,
            socketToken: entry.socketToken,
          });
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
          const raw = event.data;
          if (typeof raw === "string") {
            try {
              const msg = JSON.parse(raw);
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

  return websocket;
};
