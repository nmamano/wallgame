/**
 * Evaluation Bar WebSocket Route
 *
 * Provides position evaluations from official bots for spectators,
 * replay viewers, and players in unrated games.
 *
 * Protocol:
 * 1. Client connects to /ws/eval/:gameId
 * 2. Client sends handshake with variant info
 * 3. Server validates access and finds an official eval bot
 * 4. Client can then request evaluations for positions
 * 5. Server routes eval requests to the bot and forwards responses
 */

import type { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { nanoid } from "nanoid";

import type { SerializedGameState } from "../../shared/domain/game-types";
import type {
  EvalClientMessage,
  EvalServerMessage,
} from "../../shared/contracts/eval-protocol";

import { getSession, resolveSessionForSocketToken } from "../games/store";

import {
  findEvalBot,
  getClient,
  enqueueRequest,
  tryProcessNextRequest,
  generateRequestId,
  type QueuedRequest,
} from "../games/custom-bot-store";

import { getClientContext } from "./custom-bot-socket";

const { upgradeWebSocket, websocket } = createBunWebSocket();

// ============================================================================
// Types
// ============================================================================

interface EvalSocket {
  ctx: WSContext;
  id: string; // Unique socket ID
  gameId: string;
  attached: boolean; // Handshake completed
  botCompositeId: string | null; // Bot assigned for evals
}

interface PendingEvalRequest {
  evalSocketId: string;
  requestId: string;
  createdAt: number;
  state: SerializedGameState; // Store state so we can send it when processing queued requests
}

// ============================================================================
// Storage
// ============================================================================

/** Map from socket ID to EvalSocket */
const evalSockets = new Map<string, EvalSocket>();

/** Map from WSContext to socket ID for lookups */
const contextToSocketId = new WeakMap<WSContext, string>();
const rawSocketMap = new WeakMap<object, string>();

/** Map from eval request ID to pending request info */
const pendingEvalRequests = new Map<string, PendingEvalRequest>();

// ============================================================================
// Socket Tracking
// ============================================================================

const mapSocketContext = (ctx: WSContext, socketId: string): void => {
  contextToSocketId.set(ctx, socketId);
  if (ctx.raw && typeof ctx.raw === "object") {
    rawSocketMap.set(ctx.raw, socketId);
  }
};

const getSocketIdForContext = (ctx: WSContext): string | undefined => {
  const direct = contextToSocketId.get(ctx);
  if (direct) return direct;
  if (ctx.raw && typeof ctx.raw === "object") {
    return rawSocketMap.get(ctx.raw);
  }
  return undefined;
};

const cleanupSocket = (ctx: WSContext, socketId: string): void => {
  contextToSocketId.delete(ctx);
  if (ctx.raw && typeof ctx.raw === "object") {
    rawSocketMap.delete(ctx.raw);
  }
  evalSockets.delete(socketId);
};

// ============================================================================
// Message Sending
// ============================================================================

const send = (ctx: WSContext, message: EvalServerMessage): void => {
  try {
    ctx.send(JSON.stringify(message));
  } catch (error) {
    console.error("[eval-ws] failed to send message", {
      type: message.type,
      error,
    });
  }
};

const sendToSocket = (socketId: string, message: EvalServerMessage): void => {
  const socket = evalSockets.get(socketId);
  if (!socket) return;
  send(socket.ctx, message);
};

// ============================================================================
// Handshake Handling
// ============================================================================

const handleHandshake = (
  ctx: WSContext,
  socket: EvalSocket,
  message: EvalClientMessage & { type: "eval-handshake" },
  socketToken: string | null,
): void => {
  const { gameId, variant, boardWidth, boardHeight } = message;

  // Update socket with game info
  socket.gameId = gameId;

  // Try to look up the game session to check access
  let isRatedPlayer = false;
  try {
    const session = getSession(gameId);

    // Check if this is a rated in-progress game and if the requester is a player
    if (
      session.config.rated &&
      session.gameState.status === "playing" &&
      socketToken
    ) {
      // Check if the socket token belongs to a player
      const resolved = resolveSessionForSocketToken({
        id: gameId,
        socketToken,
      });
      if (resolved) {
        // This is a player in a rated in-progress game - deny eval access
        isRatedPlayer = true;
      }
    }
  } catch {
    // Game not found in memory - could be a replay or local game
    // Allow eval access since we can't verify it's rated/in-progress
  }

  if (isRatedPlayer) {
    send(ctx, {
      type: "eval-handshake-rejected",
      code: "RATED_PLAYER",
      message: "Evaluations are not available for players in rated games.",
    });
    return;
  }

  // Find an official bot that can provide evaluations
  const evalBot = findEvalBot(variant, boardWidth, boardHeight);
  if (!evalBot) {
    send(ctx, {
      type: "eval-handshake-rejected",
      code: "NO_BOT",
      message: "No evaluation bot available for this game configuration.",
    });
    return;
  }

  // Store the bot assignment
  socket.botCompositeId = evalBot.compositeId;
  socket.attached = true;

  // Send success
  send(ctx, { type: "eval-handshake-accepted" });

  console.info("[eval-ws] handshake accepted", {
    socketId: socket.id,
    gameId,
    variant,
    botCompositeId: evalBot.compositeId,
  });
};

// ============================================================================
// Eval Request Handling
// ============================================================================

const handleEvalRequest = (
  ctx: WSContext,
  socket: EvalSocket,
  message: EvalClientMessage & { type: "eval-request" },
): void => {
  if (!socket.attached || !socket.botCompositeId) {
    send(ctx, {
      type: "eval-error",
      requestId: message.requestId,
      code: "NOT_CONNECTED",
      message: "Handshake not completed.",
    });
    return;
  }

  const [clientId, botId] = socket.botCompositeId.split(":");
  const client = getClient(clientId);
  if (!client) {
    send(ctx, {
      type: "eval-error",
      requestId: message.requestId,
      code: "BOT_DISCONNECTED",
      message: "Evaluation bot is not available.",
    });
    return;
  }

  // Generate a server-side request ID for the bot
  const serverRequestId = generateRequestId();

  // Track this pending request (including state so we can send it when processed)
  pendingEvalRequests.set(serverRequestId, {
    evalSocketId: socket.id,
    requestId: message.requestId, // Client's request ID
    createdAt: Date.now(),
    state: message.state,
  });

  // Create the eval request for the bot
  const request: QueuedRequest = {
    requestId: serverRequestId,
    kind: "eval",
    botId,
    gameId: socket.gameId,
    playerId: 1, // Eval from P1's perspective
    opponentName: "Eval Request",
    createdAt: Date.now(),
  };

  // Enqueue the request
  enqueueRequest(clientId, request);

  // Try to process immediately
  trySendNextEvalRequest(clientId);

  console.debug("[eval-ws] eval request queued", {
    socketId: socket.id,
    clientRequestId: message.requestId,
    serverRequestId,
    botCompositeId: socket.botCompositeId,
  });
};

/**
 * Try to send the next eval request to the bot.
 * This is called after enqueuing a request or after a response is processed.
 */
export const trySendNextEvalRequest = (clientId: string): void => {
  const client = getClient(clientId);
  if (!client) return;

  // Only process eval requests - move/draw are handled by custom-bot-socket
  const request = tryProcessNextRequest(clientId, ["eval"]);
  if (!request) return;

  // Get the pending request info (which includes the state)
  const pendingRequest = pendingEvalRequests.get(request.requestId);
  if (!pendingRequest) {
    console.error("[eval-ws] pending request not found", {
      requestId: request.requestId,
    });
    return;
  }

  // Get the bot's WebSocket context
  const ctx = getClientContext(clientId);
  if (!ctx) {
    console.error("[eval-ws] no context for bot client", { clientId });
    return;
  }

  // Send the eval request to the bot
  ctx.send(
    JSON.stringify({
      type: "request",
      requestId: request.requestId,
      botId: request.botId,
      gameId: request.gameId,
      serverTime: Date.now(),
      kind: "eval",
      playerId: 1,
      opponentName: "Eval Request",
      state: pendingRequest.state,
      evalSocketId: pendingRequest.evalSocketId,
    }),
  );

  console.info("[eval-ws] sent eval request to bot", {
    clientId,
    botId: request.botId,
    requestId: request.requestId,
  });
};

// ============================================================================
// Bot Response Handling (called from custom-bot-socket.ts)
// ============================================================================

/**
 * Handle an eval response from a bot.
 * This is called from custom-bot-socket.ts when a bot sends an eval response.
 */
export const handleBotEvalResponse = (
  serverRequestId: string,
  evaluation: number,
  bestMove?: string,
): void => {
  const pending = pendingEvalRequests.get(serverRequestId);
  if (!pending) {
    console.warn("[eval-ws] received eval response for unknown request", {
      serverRequestId,
    });
    return;
  }

  // Send the response to the eval client
  sendToSocket(pending.evalSocketId, {
    type: "eval-response",
    requestId: pending.requestId, // Client's original request ID
    evaluation,
    bestMove,
  });

  // Clean up
  pendingEvalRequests.delete(serverRequestId);

  console.debug("[eval-ws] forwarded eval response", {
    serverRequestId,
    clientRequestId: pending.requestId,
    evalSocketId: pending.evalSocketId,
    evaluation,
  });
};

/**
 * Handle an eval error from a bot.
 */
export const handleBotEvalError = (
  serverRequestId: string,
  message: string,
): void => {
  const pending = pendingEvalRequests.get(serverRequestId);
  if (!pending) return;

  sendToSocket(pending.evalSocketId, {
    type: "eval-error",
    requestId: pending.requestId,
    code: "INTERNAL_ERROR",
    message,
  });

  pendingEvalRequests.delete(serverRequestId);
};

/**
 * Clean up pending requests for a bot client that disconnected.
 */
export const handleBotClientDisconnectForEval = (): void => {
  // Find all pending requests from this client's bots and notify eval clients
  for (const [requestId, pending] of pendingEvalRequests) {
    sendToSocket(pending.evalSocketId, {
      type: "eval-error",
      requestId: pending.requestId,
      code: "BOT_DISCONNECTED",
      message: "Evaluation bot disconnected.",
    });
    pendingEvalRequests.delete(requestId);
  }
};

// ============================================================================
// Message Handling
// ============================================================================

const handleMessage = (
  ctx: WSContext,
  socket: EvalSocket,
  data: string | ArrayBuffer,
  socketToken: string | null,
): void => {
  if (typeof data !== "string") {
    console.warn("[eval-ws] received non-string message");
    return;
  }

  let message: EvalClientMessage;
  try {
    message = JSON.parse(data) as EvalClientMessage;
  } catch {
    console.warn("[eval-ws] failed to parse message", { data });
    return;
  }

  switch (message.type) {
    case "eval-handshake":
      handleHandshake(ctx, socket, message, socketToken);
      break;
    case "eval-request":
      handleEvalRequest(ctx, socket, message);
      break;
    case "ping":
      send(ctx, { type: "pong" });
      break;
    default:
      console.warn("[eval-ws] unknown message type", { message });
  }
};

// ============================================================================
// Route Registration
// ============================================================================

export const registerEvalSocketRoute = (app: Hono): typeof websocket => {
  app.get(
    "/ws/eval/:gameId",
    upgradeWebSocket((c) => {
      const gameId = c.req.param("gameId");
      const socketToken = c.req.query("token") ?? null;

      return {
        onOpen(_event: Event, ws: WSContext) {
          const socketId = `eval_${nanoid(12)}`;
          const socket: EvalSocket = {
            ctx: ws,
            id: socketId,
            gameId,
            attached: false,
            botCompositeId: null,
          };

          mapSocketContext(ws, socketId);
          evalSockets.set(socketId, socket);

          console.info("[eval-ws] connection opened", { socketId, gameId });
        },

        onMessage(event: MessageEvent, ws: WSContext) {
          const socketId = getSocketIdForContext(ws);
          if (!socketId) {
            console.warn("[eval-ws] message from unknown socket");
            return;
          }

          const socket = evalSockets.get(socketId);
          if (!socket) {
            console.warn("[eval-ws] socket not found", { socketId });
            return;
          }

          handleMessage(
            ws,
            socket,
            event.data as string | ArrayBuffer,
            socketToken,
          );
        },

        onClose(_event: CloseEvent, ws: WSContext) {
          const socketId = getSocketIdForContext(ws);
          if (!socketId) return;

          console.info("[eval-ws] connection closed", { socketId });

          // Clean up any pending requests for this socket
          for (const [requestId, pending] of pendingEvalRequests) {
            if (pending.evalSocketId === socketId) {
              pendingEvalRequests.delete(requestId);
            }
          }

          cleanupSocket(ws, socketId);
        },
      };
    }),
  );

  return websocket;
};
