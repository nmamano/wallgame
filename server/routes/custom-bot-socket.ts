/**
 * Custom Bot WebSocket Route
 *
 * Handles WebSocket connections from custom bot clients using the
 * custom bot protocol defined in shared/contracts/custom-bot-protocol.ts
 *
 * Protocol: Strict REQUEST → RESPONSE model
 * - Server sends requests when it needs a decision from the bot
 * - Client is idle unless there is an outstanding request
 * - Only one request is valid at a time; new requests invalidate prior ones
 */

import type { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { nanoid } from "nanoid";

import type { PlayerId } from "../../shared/domain/game-types";
import { moveFromStandardNotation } from "../../shared/domain/standard-notation";
import {
  CUSTOM_BOT_PROTOCOL_VERSION,
  DEFAULT_BOT_LIMITS,
  type CustomBotClientMessage,
  type CustomBotServerMessage,
  type AttachMessage,
  type BotResponseMessage,
  type BotRequestKind,
  type NackCode,
  type AttachRejectedCode,
} from "../../shared/contracts/custom-bot-protocol";

import {
  getSession,
  getSessionSnapshot,
  applyPlayerMove,
  resignGame,
  acceptDraw,
  rejectDraw,
  createRematchSession,
  processRatingUpdate,
  updateConnectionState,
  serializeGameState,
  type GameSession,
} from "../games/store";

import {
  validateSeatToken,
  isSeatTokenUsed,
  markSeatTokenUsed,
  isSeatConnected,
  createConnection,
  getConnection,
  removeConnection,
  checkRateLimit,
  incrementInvalidMessageCount,
  resetInvalidMessageCount,
  checkGameCompatibility,
  setPendingRequest,
  clearPendingRequest,
  validateRequestId,
  getPendingRequestKind,
  transitionConnectionToRematch,
  type CustomBotConnection,
} from "../games/custom-bot-store";

import { persistCompletedGame } from "../games/persistence";
import {
  sendMatchStatus,
  broadcast,
  broadcastRematchStarted,
  broadcastLiveGamesRemove,
  broadcastLiveGamesUpsert,
} from "./game-socket";

const { upgradeWebSocket, websocket } = createBunWebSocket();

// ============================================================================
// Types
// ============================================================================

interface BotSocket {
  ctx: WSContext;
  seatToken: string | null; // null until attached
  attached: boolean;
}

// ============================================================================
// Socket Tracking
// ============================================================================

const contextToSocket = new WeakMap<WSContext, BotSocket>();
const rawSocketMap = new WeakMap<object, BotSocket>();

// Map from seatToken to WSContext for sending messages to bots
const seatTokenToContext = new Map<string, WSContext>();

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
  if (socket.seatToken) {
    seatTokenToContext.delete(socket.seatToken);
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
 * Send a request to the bot. This is the ONLY way to request actions from the bot.
 * Each new request invalidates any prior pending request.
 */
const sendRequest = (
  ctx: WSContext,
  seatToken: string,
  kind: BotRequestKind,
  session: GameSession,
  offeredBy?: PlayerId,
): void => {
  const requestId = `req_${nanoid(12)}`;
  setPendingRequest(seatToken, requestId, kind);

  send(ctx, {
    type: "request",
    requestId,
    serverTime: Date.now(),
    kind,
    state: serializeGameState(session),
    snapshot: getSessionSnapshot(session.id),
    offeredBy,
  });

  console.info("[custom-bot-ws] sent request", {
    gameId: session.id,
    kind,
    requestId,
  });
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

  // Validate seat token
  const tokenMapping = validateSeatToken(message.seatToken);
  if (!tokenMapping) {
    sendAttachRejected(ctx, "INVALID_TOKEN", "Seat token is invalid.");
    return false;
  }

  // Check if token already used
  if (isSeatTokenUsed(message.seatToken)) {
    sendAttachRejected(
      ctx,
      "TOKEN_ALREADY_USED",
      "Seat token has already been used for attachment.",
    );
    return false;
  }

  // Get the game session
  let session: GameSession;
  try {
    session = getSession(tokenMapping.gameId);
  } catch {
    sendAttachRejected(
      ctx,
      "INVALID_TOKEN",
      "Game session not found for this token.",
    );
    return false;
  }

  // Verify this is a custom bot seat
  const player =
    tokenMapping.role === "host"
      ? session.players.host
      : session.players.joiner;

  if (player.configType !== "custom-bot") {
    sendAttachRejected(
      ctx,
      "SEAT_NOT_CUSTOM_BOT",
      "This seat is not configured for a custom bot.",
    );
    return false;
  }

  if (player.customBotSeatToken !== message.seatToken) {
    sendAttachRejected(
      ctx,
      "INVALID_TOKEN",
      "Seat token does not match the configured seat.",
    );
    return false;
  }

  // Check if already connected
  if (isSeatConnected(tokenMapping.gameId, tokenMapping.role)) {
    sendAttachRejected(
      ctx,
      "SEAT_ALREADY_CONNECTED",
      "A bot is already connected to this seat.",
    );
    return false;
  }

  // Check game compatibility
  const compatibility = checkGameCompatibility(session, message.supportedGame);
  if (!compatibility.compatible) {
    sendAttachRejected(
      ctx,
      "UNSUPPORTED_GAME_CONFIG",
      compatibility.reason ??
        "Game configuration not supported by this client.",
    );
    return false;
  }

  // Mark token as used and create connection
  markSeatTokenUsed(message.seatToken);
  const connection = createConnection(
    message.seatToken,
    session.id,
    tokenMapping.role,
    player.playerId,
    session.seriesId,
  );

  // Update socket state
  socket.seatToken = message.seatToken;
  socket.attached = true;
  seatTokenToContext.set(message.seatToken, ctx);

  // Mark player as connected
  updateConnectionState({
    id: session.id,
    socketToken: player.socketToken,
    connected: true,
  });

  // Send attached response
  send(ctx, {
    type: "attached",
    protocolVersion: CUSTOM_BOT_PROTOCOL_VERSION,
    serverTime: Date.now(),
    server: { name: "wallgame", version: "1.0.0" },
    match: {
      matchId: session.seriesId,
      gameId: session.id,
      seat: {
        role: connection.role,
        playerId: connection.playerId,
      },
    },
    limits: DEFAULT_BOT_LIMITS,
  });

  // Broadcast connection status to other clients
  sendMatchStatus(session.id);

  // If it's the bot's turn, send a move request
  if (
    session.gameState.status === "playing" &&
    session.gameState.turn === connection.playerId
  ) {
    sendRequest(ctx, message.seatToken, "move", session);
  }

  console.info("[custom-bot-ws] bot attached", {
    gameId: session.id,
    role: connection.role,
    playerId: connection.playerId,
    clientName: message.client?.name,
    clientVersion: message.client?.version,
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
  if (!socket.attached || !socket.seatToken) {
    sendNack(
      ctx,
      message.requestId,
      "NOT_ATTACHED",
      "Not attached to a game.",
      false,
    );
    return;
  }

  const connection = getConnection(socket.seatToken);
  if (!connection) {
    sendNack(
      ctx,
      message.requestId,
      "NOT_ATTACHED",
      "Connection not found.",
      false,
    );
    return;
  }

  // Rate limiting
  if (
    !checkRateLimit(
      socket.seatToken,
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

  // Validate request ID matches the pending request
  if (!validateRequestId(socket.seatToken, message.requestId)) {
    sendNack(
      ctx,
      message.requestId,
      "STALE_REQUEST",
      "Request ID does not match the current pending request.",
      false,
    );
    return;
  }

  const pendingKind = getPendingRequestKind(socket.seatToken);
  if (!pendingKind) {
    sendNack(
      ctx,
      message.requestId,
      "STALE_REQUEST",
      "No pending request.",
      false,
    );
    return;
  }

  let session: GameSession;
  try {
    session = getSession(connection.gameId);
  } catch {
    sendNack(
      ctx,
      message.requestId,
      "INTERNAL_ERROR",
      "Game session not found.",
      false,
    );
    return;
  }

  const response = message.response;

  // Validate the action matches the request kind
  if (!isValidActionForRequest(pendingKind, response.action)) {
    sendNack(
      ctx,
      message.requestId,
      "INVALID_ACTION",
      `Action "${response.action}" is not valid for "${pendingKind}" request.`,
      true, // Can retry with correct action
    );
    incrementInvalidMessageCount(socket.seatToken);
    return;
  }

  // Handle based on the action
  switch (response.action) {
    case "move":
      await handleMoveResponse(ctx, socket, message, connection, session);
      break;
    case "resign":
      await handleResignResponse(ctx, socket, message, connection, session);
      break;
    case "accept-draw":
      await handleDrawAcceptResponse(ctx, socket, message, connection, session);
      break;
    case "decline-draw":
      handleDrawDeclineResponse(ctx, socket, message, connection, session);
      break;
    case "accept-rematch":
      handleRematchAcceptResponse(ctx, socket, message, connection, session);
      break;
    case "decline-rematch":
      handleRematchDeclineResponse(ctx, socket, message, connection, session);
      break;
  }
};

const isValidActionForRequest = (
  kind: BotRequestKind,
  action: string,
): boolean => {
  switch (kind) {
    case "move":
      return action === "move" || action === "resign";
    case "draw":
      return action === "accept-draw" || action === "decline-draw";
    case "rematch":
      return action === "accept-rematch" || action === "decline-rematch";
    default:
      return false;
  }
};

const handleMoveResponse = async (
  ctx: WSContext,
  socket: BotSocket,
  message: BotResponseMessage,
  connection: CustomBotConnection,
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
  if (session.gameState.turn !== connection.playerId) {
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
      true, // Same request remains active, can retry
    );
    incrementInvalidMessageCount(socket.seatToken!);
    return;
  }

  // Apply the move
  try {
    const newState = applyPlayerMove({
      id: session.id,
      playerId: connection.playerId,
      move,
      timestamp: Date.now(),
    });

    // Clear pending request
    clearPendingRequest(socket.seatToken!);
    resetInvalidMessageCount(socket.seatToken!);

    // Send ack with updated state
    sendAck(ctx, message.requestId);

    // Broadcast state to all players
    broadcast(session.id, {
      type: "state",
      state: serializeGameState(session),
    });

    // Handle game end
    if (newState.status === "finished") {
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
      playerId: connection.playerId,
      notation: response.moveNotation,
      moveCount: newState.moveCount,
    });
  } catch (error) {
    sendNack(
      ctx,
      message.requestId,
      "ILLEGAL_MOVE",
      (error as Error).message ?? "Move could not be applied.",
      true, // Same request remains active, can retry
    );
    incrementInvalidMessageCount(socket.seatToken!);
  }
};

const handleResignResponse = async (
  ctx: WSContext,
  socket: BotSocket,
  message: BotResponseMessage,
  connection: CustomBotConnection,
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
      playerId: connection.playerId,
      timestamp: Date.now(),
    });

    // Clear pending request
    clearPendingRequest(socket.seatToken!);
    resetInvalidMessageCount(socket.seatToken!);

    // Send ack with updated state
    sendAck(ctx, message.requestId);

    // Broadcast state to all players
    broadcast(session.id, {
      type: "state",
      state: serializeGameState(session),
    });

    // Handle game end
    if (newState.status === "finished") {
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
      playerId: connection.playerId,
    });
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
  connection: CustomBotConnection,
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
      playerId: connection.playerId,
    });

    // Clear pending request
    clearPendingRequest(socket.seatToken!);
    resetInvalidMessageCount(socket.seatToken!);

    // Send ack with updated state
    sendAck(ctx, message.requestId);

    // Broadcast state to all players
    broadcast(session.id, {
      type: "state",
      state: serializeGameState(session),
    });

    // Handle game end
    if (newState.status === "finished") {
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
      playerId: connection.playerId,
    });
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
  connection: CustomBotConnection,
  session: GameSession,
): void => {
  // Clear pending request
  clearPendingRequest(socket.seatToken!);
  resetInvalidMessageCount(socket.seatToken!);

  // Reject the draw on the server side
  rejectDraw({
    id: session.id,
    playerId: connection.playerId,
  });

  // Send ack
  sendAck(ctx, message.requestId);

  // Broadcast draw rejection to other players
  broadcast(session.id, {
    type: "draw-rejected",
    playerId: connection.playerId,
  });

  console.info("[custom-bot-ws] draw declined", {
    gameId: session.id,
    playerId: connection.playerId,
  });
};

const handleRematchAcceptResponse = (
  ctx: WSContext,
  socket: BotSocket,
  message: BotResponseMessage,
  connection: CustomBotConnection,
  session: GameSession,
): void => {
  // Validate game is finished
  if (session.gameState.status !== "finished") {
    sendNack(
      ctx,
      message.requestId,
      "INVALID_ACTION",
      "Game must be finished to respond to rematch offers.",
      false,
    );
    return;
  }

  try {
    // Create or get existing rematch session
    let newSession: GameSession;
    let seatCredentials;

    if (session.nextGameId) {
      // Rematch already exists
      newSession = getSession(session.nextGameId);
      seatCredentials = session.nextGameSeatCredentials;
    } else {
      // Create new rematch
      const result = createRematchSession(session.id);
      newSession = result.newSession;
      seatCredentials = result.seatCredentials;
    }

    // Transition the bot connection to the new game
    const newPlayerId =
      connection.role === "host"
        ? newSession.players.host.playerId
        : newSession.players.joiner.playerId;

    transitionConnectionToRematch(
      socket.seatToken!,
      newSession.id,
      newPlayerId,
    );

    // Clear pending request (was cleared by transition, but be explicit)
    clearPendingRequest(socket.seatToken!);
    resetInvalidMessageCount(socket.seatToken!);

    // Update connection reference
    const updatedConnection = getConnection(socket.seatToken!);

    // Send ack
    sendAck(ctx, message.requestId);

    // Send rematch-started to bot with new state
    send(ctx, {
      type: "rematch-started",
      serverTime: Date.now(),
      matchId: newSession.seriesId,
      newGameId: newSession.id,
      seat: {
        role: connection.role,
        playerId: newPlayerId,
      },
      state: serializeGameState(newSession),
      snapshot: getSessionSnapshot(newSession.id),
    });

    // Broadcast rematch started to other players (with per-socket seat credentials)
    if (seatCredentials) {
      broadcastRematchStarted(session.id, {
        newSession,
        seatCredentials,
      });
    }

    // If it's the bot's turn in the new game, send move request
    if (
      newSession.gameState.status === "playing" &&
      updatedConnection &&
      newSession.gameState.turn === updatedConnection.playerId
    ) {
      sendRequest(ctx, socket.seatToken!, "move", newSession);
    }

    console.info("[custom-bot-ws] rematch accepted", {
      oldGameId: session.id,
      newGameId: newSession.id,
      playerId: newPlayerId,
    });
  } catch (error) {
    sendNack(
      ctx,
      message.requestId,
      "INTERNAL_ERROR",
      (error as Error).message ?? "Rematch acceptance failed.",
      false,
    );
  }
};

const handleRematchDeclineResponse = (
  ctx: WSContext,
  socket: BotSocket,
  message: BotResponseMessage,
  connection: CustomBotConnection,
  session: GameSession,
): void => {
  // Clear pending request
  clearPendingRequest(socket.seatToken!);
  resetInvalidMessageCount(socket.seatToken!);

  // Send ack
  sendAck(ctx, message.requestId);

  // Broadcast rematch rejection to other players
  broadcast(session.id, {
    type: "rematch-rejected",
    playerId: connection.playerId,
  });

  console.info("[custom-bot-ws] rematch declined", {
    gameId: session.id,
    playerId: connection.playerId,
  });
};

// ============================================================================
// Public API for Game Socket Integration
// ============================================================================

/**
 * Send a request to a custom bot if connected.
 * This is the single entry point for all bot requests.
 */
export const sendBotRequest = (
  gameId: string,
  role: "host" | "joiner",
  kind: BotRequestKind,
  offeredBy?: PlayerId,
): void => {
  const seatTokenEntry = [...seatTokenToContext.entries()].find(([token]) => {
    const conn = getConnection(token);
    return conn?.gameId === gameId && conn.role === role;
  });

  if (!seatTokenEntry) return;

  const [seatToken, ctx] = seatTokenEntry;
  const connection = getConnection(seatToken);
  if (!connection) return;

  let session: GameSession;
  try {
    session = getSession(gameId);
  } catch {
    return;
  }

  // For move requests, verify it's the bot's turn
  if (kind === "move" && session.gameState.turn !== connection.playerId) {
    return;
  }

  // For draw requests, verify bot is NOT the active seat
  if (kind === "draw" && session.gameState.turn === connection.playerId) {
    return;
  }

  sendRequest(ctx, seatToken, kind, session, offeredBy);
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
    if (socket.seatToken) {
      incrementInvalidMessageCount(socket.seatToken);
    }
    return;
  }

  switch (message.type) {
    case "attach": {
      if (socket.attached) {
        sendAttachRejected(
          ctx,
          "INTERNAL_ERROR",
          "Already attached to a game.",
        );
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
      if (socket.seatToken) {
        incrementInvalidMessageCount(socket.seatToken);

        // Check if we should disconnect
        const connection = getConnection(socket.seatToken);
        if (
          connection &&
          connection.invalidMessageCount >=
            DEFAULT_BOT_LIMITS.maxInvalidMessages
        ) {
          console.warn(
            "[custom-bot-ws] disconnecting due to too many invalid messages",
            {
              gameId: connection.gameId,
              role: connection.role,
              invalidCount: connection.invalidMessageCount,
            },
          );
          handleBotResignOnDisconnect(socket.seatToken);
          try {
            ctx.close(1008, "Too many invalid messages");
          } catch {
            // Ignore close errors
          }
        }
      }
  }
};

// ============================================================================
// Disconnect Handling
// ============================================================================

const handleBotResignOnDisconnect = (seatToken: string): void => {
  const connection = getConnection(seatToken);
  if (!connection) return;

  try {
    const session = getSession(connection.gameId);
    if (session.gameState.status === "playing") {
      // Resign the bot
      const newState = resignGame({
        id: session.id,
        playerId: connection.playerId,
        timestamp: Date.now(),
      });

      console.info("[custom-bot-ws] bot resigned on disconnect", {
        gameId: session.id,
        playerId: connection.playerId,
      });

      // Broadcast state to all players
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
      seatToken,
    });
  }
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
            seatToken: null,
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
            seatToken: socket.seatToken,
          });

          if (socket.seatToken) {
            const connection = getConnection(socket.seatToken);
            if (connection) {
              // Update player connection state
              try {
                const session = getSession(connection.gameId);
                const player =
                  connection.role === "host"
                    ? session.players.host
                    : session.players.joiner;
                updateConnectionState({
                  id: session.id,
                  socketToken: player.socketToken,
                  connected: false,
                });
                sendMatchStatus(session.id);
              } catch {
                // Session may no longer exist
              }

              // Handle resignation on disconnect (per protocol spec)
              handleBotResignOnDisconnect(socket.seatToken);

              // Remove connection
              removeConnection(socket.seatToken);
            }
          }

          cleanupSocket(ws, socket);
        },
      };
    }),
  );

  return websocket;
};
