/**
 * Custom Bot WebSocket Route (Proactive Bot Protocol v2)
 *
 * Bot clients connect proactively and register bots for users to play against.
 *
 * Protocol: Strict REQUEST -> RESPONSE model
 * - Server sends requests when it needs a decision from the bot
 * - Client is idle unless there is an outstanding request
 * - Only one request is active at a time per client; new requests invalidate prior ones
 */

import type { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";

import type { PlayerId } from "../../shared/domain/game-types";
import { moveFromStandardNotation } from "../../shared/domain/standard-notation";
import {
  CUSTOM_BOT_PROTOCOL_VERSION,
  DEFAULT_BOT_LIMITS,
  type CustomBotClientMessage,
  type CustomBotServerMessage,
  type AttachMessage,
  type BotResponseMessage,
  type NackCode,
  type AttachRejectedCode,
  type BotConfig,
} from "../../shared/contracts/custom-bot-protocol";
import { botConfigSchema } from "../../shared/contracts/custom-bot-config-schema";

import {
  getSession,
  applyPlayerMove,
  resignGame,
  acceptDraw,
  rejectDraw,
  processRatingUpdate,
  serializeGameState,
  type GameSession,
} from "../games/store";

import {
  registerClient,
  replaceClient,
  unregisterClient,
  getClient,
  getClientForBot,
  getActiveGame,
  getActiveGamesForClient,
  removeActiveGame,
  isAtClientLimit,
  generateRequestId,
  enqueueRequest,
  tryProcessNextRequest,
  getActiveRequest,
  clearActiveRequest,
  validateRequestId,
  checkRateLimit,
  incrementInvalidMessageCount,
  resetInvalidMessageCount,
  removeRequestsForGame,
  type QueuedRequest,
} from "../games/custom-bot-store";

import { persistCompletedGame } from "../games/persistence";
import {
  sendMatchStatus,
  broadcast,
  broadcastLiveGamesRemove,
  broadcastLiveGamesUpsert,
} from "./game-socket";

const { upgradeWebSocket, websocket } = createBunWebSocket();

// Official bot token from environment
const OFFICIAL_BOT_TOKEN = process.env.OFFICIAL_BOT_TOKEN;

// ============================================================================
// Types
// ============================================================================

interface BotSocket {
  ctx: WSContext;
  clientId: string | null; // null until attached
  attached: boolean;
}

// ============================================================================
// Socket Tracking
// ============================================================================

const contextToSocket = new WeakMap<WSContext, BotSocket>();
const rawSocketMap = new WeakMap<object, BotSocket>();

// Map from clientId to WSContext for sending messages
const clientIdToContext = new Map<string, WSContext>();

const mapSocketContext = (ctx: WSContext, socket: BotSocket) => {
  contextToSocket.set(ctx, socket);
  if (ctx.raw && typeof ctx.raw === "object") {
    rawSocketMap.set(ctx.raw, socket);
  }
};

const getSocketForContext = (ctx: WSContext): BotSocket | undefined => {
  const direct = contextToSocket.get(ctx);
  if (direct) return direct;
  if (ctx.raw && typeof ctx.raw === "object") {
    return rawSocketMap.get(ctx.raw);
  }
  return undefined;
};

const cleanupSocket = (ctx: WSContext, socket: BotSocket) => {
  contextToSocket.delete(ctx);
  if (ctx.raw && typeof ctx.raw === "object") {
    rawSocketMap.delete(ctx.raw);
  }
  if (socket.clientId) {
    clientIdToContext.delete(socket.clientId);
  }
};

// ============================================================================
// Message Sending
// ============================================================================

const send = (ctx: WSContext, message: CustomBotServerMessage): void => {
  try {
    ctx.send(JSON.stringify(message));
  } catch (error) {
    console.error("[custom-bot-ws] failed to send message", {
      type: message.type,
      error,
    });
  }
};

const sendAck = (ctx: WSContext, requestId: string): void => {
  send(ctx, {
    type: "ack",
    requestId,
    serverTime: Date.now(),
  });
};

const sendNack = (
  ctx: WSContext,
  requestId: string,
  code: NackCode,
  message: string,
  retryable = false,
): void => {
  send(ctx, {
    type: "nack",
    requestId,
    code,
    message,
    retryable,
    serverTime: Date.now(),
  });
};

const sendAttachRejected = (
  ctx: WSContext,
  code: AttachRejectedCode,
  message: string,
): void => {
  send(ctx, {
    type: "attach-rejected",
    code,
    message,
  });
};

/**
 * Send the next queued request to a client if possible.
 */
const trySendNextRequest = (clientId: string): void => {
  const client = getClient(clientId);
  if (!client) return;

  const request = tryProcessNextRequest(clientId);
  if (!request) return;

  const ctx = clientIdToContext.get(clientId);
  if (!ctx) return;

  let session: GameSession;
  try {
    session = getSession(request.gameId);
  } catch {
    // Game no longer exists, clear and try next
    clearActiveRequest(clientId);
    trySendNextRequest(clientId);
    return;
  }

  // Build and send request message
  if (request.kind === "move") {
    send(ctx, {
      type: "request",
      requestId: request.requestId,
      botId: request.botId,
      gameId: request.gameId,
      serverTime: Date.now(),
      kind: "move",
      playerId: request.playerId,
      opponentName: request.opponentName,
      state: serializeGameState(session),
    });
  } else if (request.kind === "draw") {
    send(ctx, {
      type: "request",
      requestId: request.requestId,
      botId: request.botId,
      gameId: request.gameId,
      serverTime: Date.now(),
      kind: "draw",
      playerId: request.playerId,
      opponentName: request.opponentName,
      offeredBy: request.offeredBy!,
      state: serializeGameState(session),
    });
  }

  console.info("[custom-bot-ws] sent request", {
    clientId,
    botId: request.botId,
    gameId: request.gameId,
    kind: request.kind,
    requestId: request.requestId,
  });
};

// ============================================================================
// Bot Config Validation
// ============================================================================

const validateBotConfig = (
  bot: BotConfig,
): { valid: true } | { valid: false; reason: string } => {
  const parsed = botConfigSchema.safeParse(bot);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "bot";
      return `${path}: ${issue.message}`;
    });
    return {
      valid: false,
      reason: details.join("; "),
    };
  }
  return { valid: true };
};

// ============================================================================
// Attach Handling
// ============================================================================

const handleAttach = (
  ctx: WSContext,
  socket: BotSocket,
  message: AttachMessage,
): boolean => {
  // Validate protocol version
  if (message.protocolVersion !== CUSTOM_BOT_PROTOCOL_VERSION) {
    sendAttachRejected(
      ctx,
      "PROTOCOL_UNSUPPORTED",
      `Protocol version ${message.protocolVersion} not supported. Server supports version ${CUSTOM_BOT_PROTOCOL_VERSION}.`,
    );
    return false;
  }

  // Validate client info
  if (
    typeof message.client !== "object" ||
    message.client === null ||
    typeof message.client.name !== "string" ||
    message.client.name.trim() === "" ||
    typeof message.client.version !== "string" ||
    message.client.version.trim() === ""
  ) {
    sendAttachRejected(
      ctx,
      "INVALID_MESSAGE",
      "`client` is required and must include non-empty `name` and `version`.",
    );
    return false;
  }

  // Validate clientId
  if (typeof message.clientId !== "string" || message.clientId.trim() === "") {
    sendAttachRejected(
      ctx,
      "INVALID_MESSAGE",
      "`clientId` is required and must be non-empty.",
    );
    return false;
  }

  // Validate bots array
  if (!Array.isArray(message.bots) || message.bots.length === 0) {
    sendAttachRejected(ctx, "NO_BOTS", "At least one bot must be provided.");
    return false;
  }

  // Validate each bot config
  for (const bot of message.bots) {
    const validation = validateBotConfig(bot);
    if (!validation.valid) {
      sendAttachRejected(
        ctx,
        "INVALID_BOT_CONFIG",
        `Invalid bot config for "${bot.botId || "(unknown)"}": ${validation.reason}`,
      );
      return false;
    }
  }

  // Check for duplicate botIds
  const botIds = new Set<string>();
  for (const bot of message.bots) {
    if (botIds.has(bot.botId)) {
      sendAttachRejected(
        ctx,
        "DUPLICATE_BOT_ID",
        `Duplicate botId: "${bot.botId}"`,
      );
      return false;
    }
    botIds.add(bot.botId);
  }

  // Validate official tokens
  for (const bot of message.bots) {
    if (bot.officialToken !== undefined) {
      if (bot.officialToken !== OFFICIAL_BOT_TOKEN) {
        sendAttachRejected(
          ctx,
          "INVALID_OFFICIAL_TOKEN",
          `Invalid official token for bot "${bot.botId}"`,
        );
        return false;
      }
    }
  }

  // Check client limit (before checking for existing connection)
  const existingClient = getClient(message.clientId);
  if (!existingClient && isAtClientLimit()) {
    sendAttachRejected(
      ctx,
      "TOO_MANY_CLIENTS",
      "Maximum number of bot clients reached.",
    );
    return false;
  }

  // Register or replace client
  if (existingClient) {
    // Force-disconnect old connection
    const oldCtx = clientIdToContext.get(message.clientId);
    if (oldCtx) {
      console.info("[custom-bot-ws] force-disconnecting old client", {
        clientId: message.clientId,
      });
      try {
        oldCtx.close(1000, "Replaced by new connection");
      } catch {
        // Ignore close errors
      }
    }
    replaceClient(
      message.clientId,
      message.bots,
      ctx.raw as never,
      OFFICIAL_BOT_TOKEN,
    );
  } else {
    const result = registerClient(
      message.clientId,
      message.bots,
      ctx.raw as never,
      OFFICIAL_BOT_TOKEN,
    );
    if (!result.success) {
      // Shouldn't happen, but handle gracefully
      sendAttachRejected(ctx, "INTERNAL_ERROR", "Failed to register client.");
      return false;
    }
  }

  // Update socket state
  socket.clientId = message.clientId;
  socket.attached = true;
  clientIdToContext.set(message.clientId, ctx);

  // Send attached response
  send(ctx, {
    type: "attached",
    protocolVersion: CUSTOM_BOT_PROTOCOL_VERSION,
    serverTime: Date.now(),
    server: { name: "wallgame", version: "1.0.0" },
    limits: DEFAULT_BOT_LIMITS,
  });

  console.info("[custom-bot-ws] client attached", {
    clientId: message.clientId,
    botCount: message.bots.length,
    botNames: message.bots.map((b) => b.name),
    clientName: message.client.name,
    clientVersion: message.client.version,
  });

  return true;
};

// ============================================================================
// Response Handling
// ============================================================================

const handleBotResponse = async (
  ctx: WSContext,
  socket: BotSocket,
  message: BotResponseMessage,
): Promise<void> => {
  if (!socket.attached || !socket.clientId) {
    sendNack(ctx, message.requestId, "NOT_ATTACHED", "Not attached.", false);
    return;
  }

  const client = getClient(socket.clientId);
  if (!client) {
    sendNack(
      ctx,
      message.requestId,
      "NOT_ATTACHED",
      "Client not found.",
      false,
    );
    return;
  }

  // Rate limiting
  if (
    !checkRateLimit(
      socket.clientId,
      DEFAULT_BOT_LIMITS.minClientMessageIntervalMs,
    )
  ) {
    sendNack(
      ctx,
      message.requestId,
      "RATE_LIMITED",
      "Too many messages. Please wait before sending another.",
      true,
    );
    return;
  }

  // Validate request ID matches the active request
  if (!validateRequestId(socket.clientId, message.requestId)) {
    sendNack(
      ctx,
      message.requestId,
      "STALE_REQUEST",
      "Request ID does not match the current active request.",
      false,
    );
    return;
  }

  const activeRequest = getActiveRequest(socket.clientId);
  if (!activeRequest) {
    sendNack(
      ctx,
      message.requestId,
      "STALE_REQUEST",
      "No active request.",
      false,
    );
    return;
  }

  let session: GameSession;
  try {
    session = getSession(activeRequest.gameId);
  } catch {
    sendNack(
      ctx,
      message.requestId,
      "INTERNAL_ERROR",
      "Game session not found.",
      false,
    );
    clearActiveRequest(socket.clientId);
    trySendNextRequest(socket.clientId);
    return;
  }

  const response = message.response;

  // Validate the action matches the request kind
  if (!isValidActionForRequest(activeRequest.kind, response.action)) {
    sendNack(
      ctx,
      message.requestId,
      "INVALID_ACTION",
      `Action "${response.action}" is not valid for "${activeRequest.kind}" request.`,
      true,
    );
    incrementInvalidMessageCount(socket.clientId);
    return;
  }

  // Get compositeId for this bot
  const compositeId = `${socket.clientId}:${activeRequest.botId}`;
  const activeGame = getActiveGame(compositeId, activeRequest.gameId);
  if (!activeGame) {
    sendNack(
      ctx,
      message.requestId,
      "INTERNAL_ERROR",
      "Bot is not active in this game.",
      false,
    );
    clearActiveRequest(socket.clientId);
    trySendNextRequest(socket.clientId);
    return;
  }

  // Handle based on the action
  switch (response.action) {
    case "move":
      await handleMoveResponse(
        ctx,
        socket,
        message,
        activeRequest,
        activeGame.playerId,
        session,
      );
      break;
    case "resign":
      await handleResignResponse(
        ctx,
        socket,
        message,
        activeRequest,
        activeGame.playerId,
        session,
      );
      break;
    case "accept-draw":
      await handleDrawAcceptResponse(
        ctx,
        socket,
        message,
        activeRequest,
        activeGame.playerId,
        session,
      );
      break;
    case "decline-draw":
      handleDrawDeclineResponse(
        ctx,
        socket,
        message,
        activeRequest,
        activeGame.playerId,
        session,
      );
      break;
  }
};

const isValidActionForRequest = (kind: string, action: string): boolean => {
  switch (kind) {
    case "move":
      return action === "move" || action === "resign";
    case "draw":
      return action === "accept-draw" || action === "decline-draw";
    default:
      return false;
  }
};

const handleMoveResponse = async (
  ctx: WSContext,
  socket: BotSocket,
  message: BotResponseMessage,
  activeRequest: { gameId: string; botId: string; requestId: string },
  playerId: PlayerId,
  session: GameSession,
): Promise<void> => {
  const response = message.response;
  if (response.action !== "move") return;

  // Validate game is playing
  if (session.gameState.status !== "playing") {
    sendNack(
      ctx,
      message.requestId,
      "INVALID_ACTION",
      "Game is not in playing state.",
      false,
    );
    return;
  }

  // Validate it's the bot's turn
  if (session.gameState.turn !== playerId) {
    sendNack(
      ctx,
      message.requestId,
      "INVALID_ACTION",
      "It is not your turn.",
      false,
    );
    return;
  }

  // Parse the move notation
  let move;
  try {
    move = moveFromStandardNotation(
      response.moveNotation,
      session.config.boardHeight,
    );
  } catch (error) {
    sendNack(
      ctx,
      message.requestId,
      "ILLEGAL_MOVE",
      `Invalid move notation: ${(error as Error).message}`,
      true,
    );
    incrementInvalidMessageCount(socket.clientId!);
    return;
  }

  // Apply the move
  try {
    const newState = applyPlayerMove({
      id: session.id,
      playerId,
      move,
      timestamp: Date.now(),
    });

    // Clear active request and process next
    clearActiveRequest(socket.clientId!);
    resetInvalidMessageCount(socket.clientId!);

    // Send ack
    sendAck(ctx, message.requestId);

    // Broadcast state to all players
    broadcast(session.id, {
      type: "state",
      state: serializeGameState(session),
    });

    // Handle game end
    if (newState.status === "finished") {
      const compositeId = `${socket.clientId}:${activeRequest.botId}`;
      removeActiveGame(compositeId, session.id);
      removeRequestsForGame(socket.clientId!, session.id);

      await processRatingUpdate(session.id);
      try {
        await persistCompletedGame(session);
      } catch (error) {
        console.error("[custom-bot-ws] failed to persist game", {
          error,
          gameId: session.id,
        });
      }
      broadcastLiveGamesRemove(session.id);
      sendMatchStatus(session.id);
    } else {
      broadcastLiveGamesUpsert(session.id);
    }

    console.info("[custom-bot-ws] move applied", {
      gameId: session.id,
      playerId,
      notation: response.moveNotation,
      moveCount: newState.moveCount,
    });

    // Process next request
    trySendNextRequest(socket.clientId!);
  } catch (error) {
    sendNack(
      ctx,
      message.requestId,
      "ILLEGAL_MOVE",
      (error as Error).message ?? "Move could not be applied.",
      true,
    );
    incrementInvalidMessageCount(socket.clientId!);
  }
};

const handleResignResponse = async (
  ctx: WSContext,
  socket: BotSocket,
  message: BotResponseMessage,
  activeRequest: { gameId: string; botId: string; requestId: string },
  playerId: PlayerId,
  session: GameSession,
): Promise<void> => {
  // Validate game is playing
  if (session.gameState.status !== "playing") {
    sendNack(
      ctx,
      message.requestId,
      "INVALID_ACTION",
      "Game is not in playing state.",
      false,
    );
    return;
  }

  try {
    const newState = resignGame({
      id: session.id,
      playerId,
      timestamp: Date.now(),
    });

    // Clear active request
    clearActiveRequest(socket.clientId!);
    resetInvalidMessageCount(socket.clientId!);

    // Send ack
    sendAck(ctx, message.requestId);

    // Broadcast state
    broadcast(session.id, {
      type: "state",
      state: serializeGameState(session),
    });

    // Handle game end
    if (newState.status === "finished") {
      const compositeId = `${socket.clientId}:${activeRequest.botId}`;
      removeActiveGame(compositeId, session.id);
      removeRequestsForGame(socket.clientId!, session.id);

      await processRatingUpdate(session.id);
      try {
        await persistCompletedGame(session);
      } catch (error) {
        console.error("[custom-bot-ws] failed to persist game after resign", {
          error,
          gameId: session.id,
        });
      }
      broadcastLiveGamesRemove(session.id);
      sendMatchStatus(session.id);
    }

    console.info("[custom-bot-ws] resignation processed", {
      gameId: session.id,
      playerId,
    });

    // Process next request
    trySendNextRequest(socket.clientId!);
  } catch (error) {
    sendNack(
      ctx,
      message.requestId,
      "INTERNAL_ERROR",
      (error as Error).message ?? "Resignation failed.",
      false,
    );
  }
};

const handleDrawAcceptResponse = async (
  ctx: WSContext,
  socket: BotSocket,
  message: BotResponseMessage,
  activeRequest: { gameId: string; botId: string; requestId: string },
  playerId: PlayerId,
  session: GameSession,
): Promise<void> => {
  // Validate game is playing
  if (session.gameState.status !== "playing") {
    sendNack(
      ctx,
      message.requestId,
      "INVALID_ACTION",
      "Game is not in playing state.",
      false,
    );
    return;
  }

  try {
    const newState = acceptDraw({
      id: session.id,
      playerId,
    });

    // Clear active request
    clearActiveRequest(socket.clientId!);
    resetInvalidMessageCount(socket.clientId!);

    // Send ack
    sendAck(ctx, message.requestId);

    // Broadcast state
    broadcast(session.id, {
      type: "state",
      state: serializeGameState(session),
    });

    // Handle game end
    if (newState.status === "finished") {
      const compositeId = `${socket.clientId}:${activeRequest.botId}`;
      removeActiveGame(compositeId, session.id);
      removeRequestsForGame(socket.clientId!, session.id);

      await processRatingUpdate(session.id);
      try {
        await persistCompletedGame(session);
      } catch (error) {
        console.error("[custom-bot-ws] failed to persist game after draw", {
          error,
          gameId: session.id,
        });
      }
      broadcastLiveGamesRemove(session.id);
      sendMatchStatus(session.id);
    }

    console.info("[custom-bot-ws] draw accepted", {
      gameId: session.id,
      playerId,
    });

    // Process next request
    trySendNextRequest(socket.clientId!);
  } catch (error) {
    sendNack(
      ctx,
      message.requestId,
      "INTERNAL_ERROR",
      (error as Error).message ?? "Draw acceptance failed.",
      false,
    );
  }
};

const handleDrawDeclineResponse = (
  ctx: WSContext,
  socket: BotSocket,
  message: BotResponseMessage,
  _activeRequest: { gameId: string; botId: string; requestId: string },
  playerId: PlayerId,
  session: GameSession,
): void => {
  // Clear active request
  clearActiveRequest(socket.clientId!);
  resetInvalidMessageCount(socket.clientId!);

  // Reject the draw on the server side
  rejectDraw({
    id: session.id,
    playerId,
  });

  // Send ack
  sendAck(ctx, message.requestId);

  // Broadcast draw rejection
  broadcast(session.id, {
    type: "draw-rejected",
    playerId,
  });

  console.info("[custom-bot-ws] draw declined", {
    gameId: session.id,
    playerId,
  });

  // Process next request
  trySendNextRequest(socket.clientId!);
};

// ============================================================================
// Public API for Game Socket Integration
// ============================================================================

/**
 * Queue a move request for a bot.
 */
export const queueBotMoveRequest = (
  compositeId: string,
  gameId: string,
  playerId: PlayerId,
  opponentName: string,
): void => {
  const client = getClientForBot(compositeId);
  if (!client) return;

  const [clientId, botId] = compositeId.split(":");

  const request: QueuedRequest = {
    requestId: generateRequestId(),
    kind: "move",
    botId,
    gameId,
    playerId,
    opponentName,
    createdAt: Date.now(),
  };

  enqueueRequest(clientId, request);
  trySendNextRequest(clientId);
};

/**
 * Queue a draw request for a bot.
 */
export const queueBotDrawRequest = (
  compositeId: string,
  gameId: string,
  playerId: PlayerId,
  opponentName: string,
  offeredBy: PlayerId,
): void => {
  const client = getClientForBot(compositeId);
  if (!client) return;

  const [clientId, botId] = compositeId.split(":");

  const request: QueuedRequest = {
    requestId: generateRequestId(),
    kind: "draw",
    botId,
    gameId,
    playerId,
    opponentName,
    offeredBy,
    createdAt: Date.now(),
  };

  enqueueRequest(clientId, request);
  trySendNextRequest(clientId);
};

/**
 * Handle bot resignation when game ends externally (e.g., opponent wins).
 */
export const notifyBotGameEnded = (
  compositeId: string,
  gameId: string,
): void => {
  const [clientId] = compositeId.split(":");
  removeActiveGame(compositeId, gameId);
  removeRequestsForGame(clientId, gameId);
  trySendNextRequest(clientId);
};

// ============================================================================
// Message Parsing and Handling
// ============================================================================

const parseMessage = (
  raw: string | ArrayBuffer,
): CustomBotClientMessage | null => {
  if (typeof raw !== "string") {
    return null;
  }
  try {
    return JSON.parse(raw) as CustomBotClientMessage;
  } catch {
    return null;
  }
};

const handleMessage = async (
  ctx: WSContext,
  socket: BotSocket,
  raw: string | ArrayBuffer,
): Promise<void> => {
  const message = parseMessage(raw);

  if (!message) {
    if (socket.clientId) {
      incrementInvalidMessageCount(socket.clientId);
    }
    return;
  }

  switch (message.type) {
    case "attach": {
      if (socket.attached) {
        sendAttachRejected(ctx, "INVALID_MESSAGE", "Already attached.");
        return;
      }
      const attachSuccess = handleAttach(ctx, socket, message);
      if (!attachSuccess) {
        // Close connection after failed attach
        try {
          ctx.close(1008, "Attach failed");
        } catch {
          // Ignore close errors
        }
      }
      break;
    }

    case "response":
      if (!socket.attached) {
        sendNack(
          ctx,
          message.requestId,
          "NOT_ATTACHED",
          "Must attach before sending responses.",
          false,
        );
        return;
      }
      await handleBotResponse(ctx, socket, message);
      break;

    default:
      if (socket.clientId) {
        incrementInvalidMessageCount(socket.clientId);
      }
  }
};

// ============================================================================
// Disconnect Handling
// ============================================================================

const handleBotClientDisconnect = (clientId: string): void => {
  // Get all active games for this client's bots
  const activeGames = getActiveGamesForClient(clientId);

  // Resign all active games
  for (const { compositeId, game } of activeGames) {
    try {
      const session = getSession(game.gameId);
      if (session.gameState.status === "playing") {
        const newState = resignGame({
          id: session.id,
          playerId: game.playerId,
          timestamp: Date.now(),
        });

        console.info("[custom-bot-ws] bot resigned on disconnect", {
          gameId: session.id,
          playerId: game.playerId,
          compositeId,
        });

        // Broadcast state
        broadcast(session.id, {
          type: "state",
          state: serializeGameState(session),
        });

        // Handle game end
        if (newState.status === "finished") {
          processRatingUpdate(session.id)
            .then(() => persistCompletedGame(session))
            .catch((error: unknown) => {
              console.error("[custom-bot-ws] failed to process game end", {
                error,
                gameId: session.id,
              });
            });
          broadcastLiveGamesRemove(session.id);
          sendMatchStatus(session.id);
        }
      }
    } catch (error) {
      console.error("[custom-bot-ws] error handling disconnect resignation", {
        error,
        compositeId,
      });
    }
  }

  // Unregister client
  unregisterClient(clientId);
};

// ============================================================================
// Route Registration
// ============================================================================

export const registerCustomBotSocketRoute = (app: Hono): typeof websocket => {
  app.get(
    "/ws/custom-bot",
    upgradeWebSocket(() => {
      return {
        onOpen(_event: Event, ws: WSContext) {
          const socket: BotSocket = {
            ctx: ws,
            clientId: null,
            attached: false,
          };
          mapSocketContext(ws, socket);
          console.info("[custom-bot-ws] connection opened");
        },

        onMessage(event: MessageEvent, ws: WSContext) {
          const socket = getSocketForContext(ws);
          if (!socket) {
            console.warn("[custom-bot-ws] message from unknown socket");
            return;
          }

          void handleMessage(
            ws,
            socket,
            event.data as string | ArrayBuffer,
          ).catch((error: unknown) => {
            console.error("[custom-bot-ws] error handling message", { error });
          });
        },

        onClose(_event: CloseEvent, ws: WSContext) {
          const socket = getSocketForContext(ws);
          if (!socket) {
            return;
          }

          console.info("[custom-bot-ws] connection closed", {
            attached: socket.attached,
            clientId: socket.clientId,
          });

          if (socket.clientId) {
            handleBotClientDisconnect(socket.clientId);
          }

          cleanupSocket(ws, socket);
        },
      };
    }),
  );

  return websocket;
};
