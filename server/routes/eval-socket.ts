/**
 * Evaluation Bar WebSocket Route (V3 Stub)
 *
 * This is a temporary stub for Phase 3 of the V3 migration.
 * The full V3 BGS-based eval bar will be implemented in Phase 5.
 *
 * For now, this module provides minimal functionality:
 * - WebSocket endpoint that accepts connections
 * - Returns "not available" for all eval requests
 * - No actual evaluation functionality until Phase 5
 */

import type { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { nanoid } from "nanoid";

import type {
  EvalClientMessage,
  EvalServerMessage,
} from "../../shared/contracts/eval-protocol";

const { upgradeWebSocket, websocket } = createBunWebSocket();

// ============================================================================
// Types
// ============================================================================

interface EvalSocket {
  ctx: WSContext;
  id: string;
  gameId: string;
}

// ============================================================================
// Storage
// ============================================================================

const evalSockets = new Map<string, EvalSocket>();
const contextToSocketId = new WeakMap<WSContext, string>();
const rawSocketMap = new WeakMap<object, string>();

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

// ============================================================================
// Message Handling (V3 Stub)
// ============================================================================

const handleMessage = (
  ctx: WSContext,
  _socket: EvalSocket,
  data: string | ArrayBuffer,
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
      // V3 Stub: Eval bar is not available until Phase 5
      send(ctx, {
        type: "eval-handshake-rejected",
        code: "NO_BOT",
        message:
          "Evaluation bar is temporarily unavailable during V3 migration.",
      });
      break;

    case "eval-request":
      // V3 Stub: Reject all eval requests
      send(ctx, {
        type: "eval-error",
        requestId: message.requestId,
        code: "INTERNAL_ERROR",
        message:
          "Evaluation bar is temporarily unavailable during V3 migration.",
      });
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

      return {
        onOpen(_event: Event, ws: WSContext) {
          const socketId = `eval_${nanoid(12)}`;
          const socket: EvalSocket = {
            ctx: ws,
            id: socketId,
            gameId,
          };

          mapSocketContext(ws, socketId);
          evalSockets.set(socketId, socket);

          console.info("[eval-ws] connection opened (V3 stub)", {
            socketId,
            gameId,
          });
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

          handleMessage(ws, socket, event.data as string | ArrayBuffer);
        },

        onClose(_event: CloseEvent, ws: WSContext) {
          const socketId = getSocketIdForContext(ws);
          if (!socketId) return;

          console.info("[eval-ws] connection closed", { socketId });
          cleanupSocket(ws, socketId);
        },
      };
    }),
  );

  return websocket;
};
