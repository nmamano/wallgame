/**
 * Custom Bot WebSocket Route (Bot Game Session Protocol v3)
 *
 * Bot clients connect proactively and register bots for users to play against.
 *
 * V3 Protocol: Bot Game Sessions (BGS)
 * - Server creates BGS when game starts: start_game_session
 * - Server requests evaluations: evaluate_position
 * - Server applies moves: apply_move
 * - Server ends session: end_game_session
 *
 * All BGS messages follow request/response pattern with expectedPly for ordering.
 * The engine maintains game state internally - no state sent per request.
 */

import type { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";

import {
  CUSTOM_BOT_PROTOCOL_VERSION,
  DEFAULT_BOT_LIMITS,
  type CustomBotClientMessage,
  type CustomBotServerMessage,
  type AttachMessage,
  type AttachRejectedCode,
  type BotConfig,
  type BgsConfig,
  type GameSessionStartedMessage,
  type GameSessionEndedMessage,
  type EvaluateResponseMessage,
  type MoveAppliedMessage,
} from "../../shared/contracts/custom-bot-protocol";
import { botConfigSchema } from "../../shared/contracts/custom-bot-config-schema";

import {
  resignGame,
  serializeGameState,
  type GameSession,
  getSession,
} from "../games/store";

import {
  registerClient,
  replaceClient,
  unregisterClient,
  getClient,
  getClientForBot,
  getActiveGamesForClient,
  removeActiveGame,
  isAtClientLimit,
  incrementInvalidMessageCount,
  resetInvalidMessageCount,
  addClientBgsSession,
  removeClientBgsSession,
} from "../games/custom-bot-store";

import {
  createBgs,
  getBgs,
  endBgs,
  markBgsReady,
  addHistoryEntry,
  updateCurrentPly,
  setPendingRequest,
  clearPendingRequest,
  endAllBgsForBot,
  type BgsHistoryEntry,
} from "../games/bgs-store";

import { persistCompletedGame } from "../games/persistence";
import {
  sendMatchStatus,
  broadcast,
  broadcastLiveGamesRemove,
} from "./game-socket";

const { upgradeWebSocket, websocket } = createBunWebSocket();

// Official bot token from environment
const OFFICIAL_BOT_TOKEN = process.env.OFFICIAL_BOT_TOKEN;

// ============================================================================
// Constants
// ============================================================================

/** Timeout for BGS requests (10 seconds as per V3 spec) */
const BGS_REQUEST_TIMEOUT_MS = 10_000;

/** Maximum unexpected messages before disconnect */
const MAX_UNEXPECTED_MESSAGES = 100;

// ============================================================================
// Types
// ============================================================================

interface BotSocket {
  ctx: WSContext;
  clientId: string | null; // null until attached
  attached: boolean;
  unexpectedMessageCount: number;
}

/** Resolver for pending BGS requests */
interface BgsRequestResolver<T> {
  resolve: (result: T) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/** Pending request resolvers by bgsId */
const pendingResolvers = new Map<string, BgsRequestResolver<unknown>>();

// ============================================================================
// Socket Tracking
// ============================================================================

const contextToSocket = new WeakMap<WSContext, BotSocket>();
const rawSocketMap = new WeakMap<object, BotSocket>();

// Map from clientId to WSContext for sending messages
const clientIdToContext = new Map<string, WSContext>();

/**
 * Get the WSContext for a client by clientId.
 * Used by external modules to send messages to bots.
 */
export const getClientContext = (clientId: string): WSContext | undefined => {
  return clientIdToContext.get(clientId);
};

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
    const msgStr = JSON.stringify(message);
    // Check message size limit (64KB)
    if (msgStr.length > DEFAULT_BOT_LIMITS.maxMessageBytes) {
      console.error("[custom-bot-ws] message too large to send", {
        type: message.type,
        size: msgStr.length,
        limit: DEFAULT_BOT_LIMITS.maxMessageBytes,
      });
      return;
    }
    ctx.send(msgStr);
  } catch (error) {
    console.error("[custom-bot-ws] failed to send message", {
      type: message.type,
      error,
    });
  }
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
// Attach Handling (V3: Require protocol version 3)
// ============================================================================

const handleAttach = (
  ctx: WSContext,
  socket: BotSocket,
  message: AttachMessage,
): boolean => {
  // V3: Require exactly protocol version 3
  if (message.protocolVersion !== CUSTOM_BOT_PROTOCOL_VERSION) {
    sendAttachRejected(
      ctx,
      "PROTOCOL_UNSUPPORTED",
      `Protocol version ${message.protocolVersion} not supported. Server requires version ${CUSTOM_BOT_PROTOCOL_VERSION}.`,
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
    protocolVersion: message.protocolVersion,
  });

  return true;
};

// ============================================================================
// V3 BGS Message Handlers
// ============================================================================

/**
 * Handle game_session_started response from bot.
 */
const handleGameSessionStarted = (
  socket: BotSocket,
  message: GameSessionStartedMessage,
): void => {
  const { bgsId, success, error } = message;

  // Validate BGS exists
  const bgs = getBgs(bgsId);
  if (!bgs) {
    console.warn("[custom-bot-ws] game_session_started for unknown BGS", {
      bgsId,
      clientId: socket.clientId,
    });
    incrementUnexpectedMessage(socket);
    return;
  }

  // Validate the bot matches
  if (!socket.clientId || !bgs.botCompositeId.startsWith(socket.clientId)) {
    console.warn("[custom-bot-ws] game_session_started from wrong client", {
      bgsId,
      expectedBot: bgs.botCompositeId,
      clientId: socket.clientId,
    });
    incrementUnexpectedMessage(socket);
    return;
  }

  // Resolve the pending request
  const resolver = pendingResolvers.get(bgsId);
  if (resolver) {
    clearTimeout(resolver.timeoutId);
    pendingResolvers.delete(bgsId);
    clearPendingRequest(bgsId);

    if (success) {
      markBgsReady(bgsId);
      resolver.resolve({ success: true });
    } else {
      resolver.reject(new Error(error || "Session start failed"));
    }
  } else {
    // Late response after timeout - silently discard
    console.debug("[custom-bot-ws] late game_session_started response", {
      bgsId,
    });
  }

  console.info("[custom-bot-ws] game_session_started handled", {
    bgsId,
    success,
    error: error || undefined,
  });
};

/**
 * Handle game_session_ended response from bot.
 */
const handleGameSessionEnded = (
  socket: BotSocket,
  message: GameSessionEndedMessage,
): void => {
  const { bgsId, success, error } = message;

  // Resolve the pending request (if any)
  const resolver = pendingResolvers.get(bgsId);
  if (resolver) {
    clearTimeout(resolver.timeoutId);
    pendingResolvers.delete(bgsId);
    clearPendingRequest(bgsId);

    if (success) {
      resolver.resolve({ success: true });
    } else {
      // Even on error, session is considered ended
      resolver.resolve({ success: false, error });
    }
  }

  // Clean up BGS tracking on client
  if (socket.clientId) {
    removeClientBgsSession(socket.clientId, bgsId);
  }

  console.info("[custom-bot-ws] game_session_ended handled", {
    bgsId,
    success,
    error: error || undefined,
  });
};

/**
 * Handle evaluate_response from bot.
 * Validates ply and stores result in BGS history.
 */
const handleEvaluateResponse = (
  socket: BotSocket,
  message: EvaluateResponseMessage,
): void => {
  const { bgsId, ply, bestMove, evaluation, success, error } = message;

  // Validate BGS exists
  const bgs = getBgs(bgsId);
  if (!bgs) {
    console.warn("[custom-bot-ws] evaluate_response for unknown BGS", {
      bgsId,
      clientId: socket.clientId,
    });
    incrementUnexpectedMessage(socket);
    return;
  }

  // Validate the bot matches
  if (!socket.clientId || !bgs.botCompositeId.startsWith(socket.clientId)) {
    console.warn("[custom-bot-ws] evaluate_response from wrong client", {
      bgsId,
      expectedBot: bgs.botCompositeId,
      clientId: socket.clientId,
    });
    incrementUnexpectedMessage(socket);
    return;
  }

  // Resolve the pending request
  const resolver = pendingResolvers.get(bgsId) as
    | BgsRequestResolver<EvaluateResponseMessage>
    | undefined;
  if (resolver) {
    clearTimeout(resolver.timeoutId);
    pendingResolvers.delete(bgsId);
    clearPendingRequest(bgsId);

    if (success) {
      // Validate ply matches expected
      const pending = bgs.pendingRequest;
      if (pending && pending.expectedPly !== ply) {
        console.warn("[custom-bot-ws] evaluate_response ply mismatch", {
          bgsId,
          expectedPly: pending.expectedPly,
          receivedPly: ply,
        });
        // Still process it, but log the warning
      }

      // Add to history
      const historyEntry: BgsHistoryEntry = {
        ply,
        evaluation,
        bestMove,
      };
      addHistoryEntry(bgsId, historyEntry);

      resolver.resolve(message);
    } else {
      resolver.reject(new Error(error || "Evaluation failed"));
    }
  } else {
    // Late response after timeout - silently discard
    console.debug("[custom-bot-ws] late evaluate_response", { bgsId, ply });
  }

  console.info("[custom-bot-ws] evaluate_response handled", {
    bgsId,
    ply,
    evaluation,
    bestMove,
    success,
  });
};

/**
 * Handle move_applied response from bot.
 * Updates BGS ply tracking.
 */
const handleMoveApplied = (
  socket: BotSocket,
  message: MoveAppliedMessage,
): void => {
  const { bgsId, ply, success, error } = message;

  // Validate BGS exists
  const bgs = getBgs(bgsId);
  if (!bgs) {
    console.warn("[custom-bot-ws] move_applied for unknown BGS", {
      bgsId,
      clientId: socket.clientId,
    });
    incrementUnexpectedMessage(socket);
    return;
  }

  // Validate the bot matches
  if (!socket.clientId || !bgs.botCompositeId.startsWith(socket.clientId)) {
    console.warn("[custom-bot-ws] move_applied from wrong client", {
      bgsId,
      expectedBot: bgs.botCompositeId,
      clientId: socket.clientId,
    });
    incrementUnexpectedMessage(socket);
    return;
  }

  // Resolve the pending request
  const resolver = pendingResolvers.get(bgsId) as
    | BgsRequestResolver<MoveAppliedMessage>
    | undefined;
  if (resolver) {
    clearTimeout(resolver.timeoutId);
    pendingResolvers.delete(bgsId);
    clearPendingRequest(bgsId);

    if (success) {
      // Update current ply in BGS
      updateCurrentPly(bgsId, ply);
      resolver.resolve(message);
    } else {
      resolver.reject(new Error(error || "Move application failed"));
    }
  } else {
    // Late response after timeout - silently discard
    console.debug("[custom-bot-ws] late move_applied", { bgsId, ply });
  }

  console.info("[custom-bot-ws] move_applied handled", {
    bgsId,
    ply,
    success,
    error: error || undefined,
  });
};

// ============================================================================
// Unexpected Message Tracking
// ============================================================================

const incrementUnexpectedMessage = (socket: BotSocket): void => {
  socket.unexpectedMessageCount += 1;
  if (socket.unexpectedMessageCount >= MAX_UNEXPECTED_MESSAGES) {
    console.warn(
      "[custom-bot-ws] disconnecting client due to too many unexpected messages",
      {
        clientId: socket.clientId,
        count: socket.unexpectedMessageCount,
      },
    );
    try {
      socket.ctx.close(1008, "Too many unexpected messages");
    } catch {
      // Ignore close errors
    }
  }
};

// ============================================================================
// Public API for Game Socket Integration
// ============================================================================

/**
 * Start a new Bot Game Session.
 * Returns a promise that resolves when the bot confirms session started.
 */
export const startBgsSession = async (
  compositeId: string,
  bgsId: string,
  gameId: string,
  config: BgsConfig,
): Promise<{ success: boolean }> => {
  const client = getClientForBot(compositeId);
  if (!client) {
    throw new Error(`Bot client not found: ${compositeId}`);
  }

  const [clientId, botId] = compositeId.split(":");
  const ctx = clientIdToContext.get(clientId);
  if (!ctx) {
    throw new Error(`No connection for client: ${clientId}`);
  }

  // Create BGS
  const bgs = createBgs(bgsId, compositeId, gameId, config);
  if (!bgs) {
    throw new Error("Failed to create BGS - at capacity or duplicate ID");
  }

  // Track BGS on client
  addClientBgsSession(clientId, bgsId);

  // Send start_game_session message
  send(ctx, {
    type: "start_game_session",
    bgsId,
    botId,
    config,
  });

  // Wait for response with timeout
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingResolvers.delete(bgsId);
      clearPendingRequest(bgsId);
      endBgs(bgsId);
      removeClientBgsSession(clientId, bgsId);
      reject(new Error("start_game_session timeout"));
    }, BGS_REQUEST_TIMEOUT_MS);

    pendingResolvers.set(bgsId, {
      resolve: resolve as (result: unknown) => void,
      reject,
      timeoutId,
    });

    // Track pending request in BGS
    setPendingRequest(bgsId, {
      type: "start_game_session",
      bgsId,
      expectedPly: 0,
      createdAt: Date.now(),
      resolve: (success: boolean, error?: string) => {
        if (!success) {
          reject(new Error(error ?? "Session start failed"));
        }
      },
    });
  });
};

/**
 * End a Bot Game Session.
 * Returns a promise that resolves when the bot confirms session ended.
 */
export const endBgsSession = async (
  compositeId: string,
  bgsId: string,
): Promise<void> => {
  const bgs = getBgs(bgsId);
  if (!bgs) {
    // Already ended - that's fine
    return;
  }

  const [clientId] = compositeId.split(":");
  const ctx = clientIdToContext.get(clientId);
  if (!ctx) {
    // Client disconnected - just clean up locally
    endBgs(bgsId);
    removeClientBgsSession(clientId, bgsId);
    return;
  }

  // Send end_game_session message
  send(ctx, {
    type: "end_game_session",
    bgsId,
  });

  // Wait for response with timeout
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingResolvers.delete(bgsId);
      clearPendingRequest(bgsId);
      // Clean up even on timeout
      endBgs(bgsId);
      removeClientBgsSession(clientId, bgsId);
      resolve(); // Don't reject - session is ended regardless
    }, BGS_REQUEST_TIMEOUT_MS);

    pendingResolvers.set(bgsId, {
      resolve: () => {
        endBgs(bgsId);
        removeClientBgsSession(clientId, bgsId);
        resolve();
      },
      reject,
      timeoutId,
    });

    setPendingRequest(bgsId, {
      type: "end_game_session",
      bgsId,
      expectedPly: bgs.currentPly,
      createdAt: Date.now(),
      resolve: () => resolve(),
    });
  });
};

/**
 * Request position evaluation from the bot.
 * Returns a promise with the evaluation result.
 */
export const requestEvaluation = async (
  compositeId: string,
  bgsId: string,
  expectedPly: number,
): Promise<EvaluateResponseMessage> => {
  const bgs = getBgs(bgsId);
  if (!bgs) {
    throw new Error(`BGS not found: ${bgsId}`);
  }

  if (bgs.status !== "ready") {
    throw new Error(`BGS not ready: ${bgsId}, status: ${bgs.status}`);
  }

  const [clientId] = compositeId.split(":");
  const ctx = clientIdToContext.get(clientId);
  if (!ctx) {
    throw new Error(`No connection for client: ${clientId}`);
  }

  // Send evaluate_position message
  send(ctx, {
    type: "evaluate_position",
    bgsId,
    expectedPly,
  });

  // Wait for response with timeout
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingResolvers.delete(bgsId);
      clearPendingRequest(bgsId);
      reject(new Error("evaluate_position timeout"));
    }, BGS_REQUEST_TIMEOUT_MS);

    pendingResolvers.set(bgsId, {
      resolve: resolve as (result: unknown) => void,
      reject,
      timeoutId,
    });

    setPendingRequest(bgsId, {
      type: "evaluate_position",
      bgsId,
      expectedPly,
      createdAt: Date.now(),
      resolve: (success: boolean, error?: string) => {
        if (!success) {
          reject(new Error(error ?? "Evaluation failed"));
        }
      },
    });
  });
};

/**
 * Apply a move to the BGS.
 * Returns a promise that resolves when the bot confirms the move.
 */
export const applyBgsMove = async (
  compositeId: string,
  bgsId: string,
  expectedPly: number,
  move: string,
): Promise<MoveAppliedMessage> => {
  const bgs = getBgs(bgsId);
  if (!bgs) {
    throw new Error(`BGS not found: ${bgsId}`);
  }

  if (bgs.status !== "ready") {
    throw new Error(`BGS not ready: ${bgsId}, status: ${bgs.status}`);
  }

  const [clientId] = compositeId.split(":");
  const ctx = clientIdToContext.get(clientId);
  if (!ctx) {
    throw new Error(`No connection for client: ${clientId}`);
  }

  // Send apply_move message
  send(ctx, {
    type: "apply_move",
    bgsId,
    expectedPly,
    move,
  });

  // Wait for response with timeout
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingResolvers.delete(bgsId);
      clearPendingRequest(bgsId);
      reject(new Error("apply_move timeout"));
    }, BGS_REQUEST_TIMEOUT_MS);

    pendingResolvers.set(bgsId, {
      resolve: resolve as (result: unknown) => void,
      reject,
      timeoutId,
    });

    setPendingRequest(bgsId, {
      type: "apply_move",
      bgsId,
      expectedPly,
      createdAt: Date.now(),
      resolve: (success: boolean, error?: string) => {
        if (!success) {
          reject(new Error(error ?? "Move application failed"));
        }
      },
    });
  });
};

/**
 * Handle bot resignation when game ends externally (e.g., opponent wins).
 * Called by game-socket when the game ends for any reason.
 */
export const notifyBotGameEnded = async (
  compositeId: string,
  gameId: string,
): Promise<void> => {
  // Remove active game tracking
  removeActiveGame(compositeId, gameId);

  // End any BGS for this game
  const bgs = getBgs(gameId);
  if (bgs?.botCompositeId === compositeId) {
    try {
      await endBgsSession(compositeId, gameId);
    } catch (error) {
      console.error("[custom-bot-ws] failed to end BGS on game end", {
        error,
        compositeId,
        gameId,
      });
      // Clean up locally anyway
      endBgs(gameId);
      const [clientId] = compositeId.split(":");
      removeClientBgsSession(clientId, gameId);
    }
  }
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

  // Check message size limit (64KB)
  if (raw.length > DEFAULT_BOT_LIMITS.maxMessageBytes) {
    console.warn("[custom-bot-ws] message too large", {
      size: raw.length,
      limit: DEFAULT_BOT_LIMITS.maxMessageBytes,
    });
    return null;
  }

  try {
    return JSON.parse(raw) as CustomBotClientMessage;
  } catch {
    return null;
  }
};

const handleMessage = (
  ctx: WSContext,
  socket: BotSocket,
  raw: string | ArrayBuffer,
): void => {
  const message = parseMessage(raw);

  if (!message) {
    if (socket.clientId) {
      incrementInvalidMessageCount(socket.clientId);
    }
    incrementUnexpectedMessage(socket);
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

    case "game_session_started":
      if (!socket.attached) {
        incrementUnexpectedMessage(socket);
        return;
      }
      handleGameSessionStarted(socket, message);
      break;

    case "game_session_ended":
      if (!socket.attached) {
        incrementUnexpectedMessage(socket);
        return;
      }
      handleGameSessionEnded(socket, message);
      break;

    case "evaluate_response":
      if (!socket.attached) {
        incrementUnexpectedMessage(socket);
        return;
      }
      handleEvaluateResponse(socket, message);
      break;

    case "move_applied":
      if (!socket.attached) {
        incrementUnexpectedMessage(socket);
        return;
      }
      handleMoveApplied(socket, message);
      break;

    default:
      // Unknown message type
      if (socket.clientId) {
        incrementInvalidMessageCount(socket.clientId);
      }
      incrementUnexpectedMessage(socket);
  }

  // Reset invalid message count on valid response
  if (socket.clientId && message.type !== "attach") {
    resetInvalidMessageCount(socket.clientId);
  }
};

// ============================================================================
// Disconnect Handling
// ============================================================================

const handleBotClientDisconnect = async (clientId: string): Promise<void> => {
  // Get all active games for this client's bots
  const activeGames = getActiveGamesForClient(clientId);

  // Resign all active games
  for (const { compositeId, game } of activeGames) {
    try {
      let session: GameSession;
      try {
        session = getSession(game.gameId);
      } catch {
        // Game not found - skip
        continue;
      }

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
        }
      }
    } catch (error) {
      console.error("[custom-bot-ws] error handling disconnect resignation", {
        error,
        compositeId,
      });
    }
  }

  // End all BGS for this client's bots
  // Get all composite IDs for this client
  const client = getClient(clientId);
  if (client) {
    for (const [botId] of client.bots) {
      const compositeId = `${clientId}:${botId}`;
      const endedSessions = endAllBgsForBot(compositeId);

      // Cancel any pending resolvers for ended sessions
      for (const session of endedSessions) {
        const resolver = pendingResolvers.get(session.bgsId);
        if (resolver) {
          clearTimeout(resolver.timeoutId);
          pendingResolvers.delete(session.bgsId);
          resolver.reject(new Error("Bot client disconnected"));
        }
      }
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
            unexpectedMessageCount: 0,
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

          handleMessage(ws, socket, event.data as string | ArrayBuffer);
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
            void handleBotClientDisconnect(socket.clientId).catch(
              (error: unknown) => {
                console.error(
                  "[custom-bot-ws] error handling disconnect",
                  error,
                );
              },
            );
          }

          cleanupSocket(ws, socket);
        },
      };
    }),
  );

  return websocket;
};
