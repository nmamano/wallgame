/**
 * Evaluation Bar WebSocket Route (V3 BGS-based)
 *
 * V3 Connection flow:
 * 1. Client connects to /ws/eval/:gameId
 * 2. Client sends handshake request with variant info
 * 3. Server validates access and creates/reuses a BGS for evaluation
 * 4. Server initializes BGS by replaying all moves (may take time for long games)
 * 5. Server sends eval-pending while initialization is in progress
 * 6. Server sends eval-history with full evaluation history
 * 7. Server streams eval-update messages as new moves are made
 * 8. BGS is closed when:
 *    - Live games (bot or human vs human): When the game ends
 *    - Replays: Immediately after sending the full history
 *
 * BGS ID conventions:
 * - Bot games: gameId (reuses the existing bot game BGS)
 * - Human vs human (live): gameId (shared across all viewers)
 * - Past game replays: gameId_eval (ephemeral, per-replay)
 *
 * Shared BGS for human vs human games:
 * - First viewer triggers BGS initialization
 * - Subsequent viewers during initialization wait (see pending state)
 * - Subsequent viewers after initialization receive cached history
 * - BGS is closed when the game ends (not when viewers leave)
 */

import type { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { nanoid } from "nanoid";

import type {
  EvalClientMessage,
  EvalServerMessage,
  EvalHandshakeRequest,
  EvalHistoryEntry,
} from "../../shared/contracts/eval-protocol";
import type { BgsConfig } from "../../shared/contracts/custom-bot-protocol";
import { moveToStandardNotation } from "../../shared/domain/standard-notation";

import { getSession } from "../games/store";
import { findEvalBot } from "../games/custom-bot-store";
import {
  getBgs,
  endBgs,
  addHistoryEntry,
  getBgsHistory,
} from "../games/bgs-store";
import {
  startBgsSession,
  endBgsSession,
  requestEvaluation,
  applyBgsMove,
} from "./custom-bot-socket";

const { upgradeWebSocket, websocket } = createBunWebSocket();

// ============================================================================
// Types
// ============================================================================

interface EvalSocket {
  ctx: WSContext;
  id: string;
  gameId: string;
  bgsId: string | null; // Set after BGS is initialized
  botCompositeId: string | null; // Set after eval bot is found
}

/**
 * Shared BGS state for human vs human games.
 * Multiple eval sockets can share the same BGS.
 */
interface SharedEvalBgs {
  bgsId: string;
  botCompositeId: string;
  status: "initializing" | "ready" | "error";
  /** Sockets waiting for initialization to complete */
  pendingSocketIds: Set<string>;
  /** Number of active viewers using this BGS */
  viewerCount: number;
  /** Cached history entries for quick access */
  cachedHistory: EvalHistoryEntry[];
  /** Error message if initialization failed */
  errorMessage?: string;
}

// ============================================================================
// Storage
// ============================================================================

/** Map from socketId -> EvalSocket */
const evalSockets = new Map<string, EvalSocket>();

/** Map from gameId -> SharedEvalBgs for human vs human games */
const sharedEvalBgs = new Map<string, SharedEvalBgs>();

/** Track WebSocket context to socket ID mapping */
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

const sendToSocket = (socketId: string, message: EvalServerMessage): void => {
  const socket = evalSockets.get(socketId);
  if (socket) {
    send(socket.ctx, message);
  }
};

// ============================================================================
// BGS Initialization
// ============================================================================

/**
 * Build BgsConfig from game session info.
 */
const buildBgsConfigFromSession = (
  session: ReturnType<typeof getSession>,
): BgsConfig => {
  return {
    variant: session.config.variant,
    boardWidth: session.config.boardWidth,
    boardHeight: session.config.boardHeight,
    initialState: session.config.variantConfig,
  };
};

/**
 * Initialize BGS history by replaying all moves.
 * This is the core V3 flow: create BGS, evaluate initial position, then replay moves.
 */
const initializeBgsHistory = async (
  botCompositeId: string,
  bgsId: string,
  gameId: string,
  config: BgsConfig,
  moves: { notation: string }[],
): Promise<
  | { success: true; history: EvalHistoryEntry[] }
  | { success: false; error: string }
> => {
  // Create and start the BGS
  try {
    await startBgsSession(botCompositeId, bgsId, gameId, config);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to start BGS";
    console.error("[eval-ws] failed to start eval BGS", {
      error,
      bgsId,
      botCompositeId,
    });
    return { success: false, error: msg };
  }

  const history: EvalHistoryEntry[] = [];

  // Get initial position evaluation (ply 0)
  try {
    const response = await requestEvaluation(botCompositeId, bgsId, 0);
    const entry: EvalHistoryEntry = {
      ply: response.ply,
      evaluation: response.evaluation,
      bestMove: response.bestMove,
    };
    history.push(entry);
    addHistoryEntry(bgsId, entry);
  } catch (error) {
    const msg =
      error instanceof Error
        ? error.message
        : "Failed to get initial evaluation";
    console.error("[eval-ws] failed to get initial evaluation", {
      error,
      bgsId,
      botCompositeId,
    });
    // Clean up the BGS on failure
    try {
      await endBgsSession(botCompositeId, bgsId);
    } catch {
      // Ignore cleanup errors
    }
    return { success: false, error: msg };
  }

  // Replay each move
  for (let i = 0; i < moves.length; i++) {
    const moveNotation = moves[i].notation;
    const expectedPly = i; // Current ply before applying move

    try {
      // Apply the move
      await applyBgsMove(botCompositeId, bgsId, expectedPly, moveNotation);

      // Get evaluation for the new position
      const newPly = expectedPly + 1;
      const response = await requestEvaluation(botCompositeId, bgsId, newPly);

      // Validate ply matches expected
      if (response.ply !== newPly) {
        console.warn("[eval-ws] ply mismatch during replay", {
          bgsId,
          expectedPly: newPly,
          receivedPly: response.ply,
          moveIndex: i,
        });
        // Continue anyway - the response is still valid
      }

      const entry: EvalHistoryEntry = {
        ply: response.ply,
        evaluation: response.evaluation,
        bestMove: response.bestMove,
      };
      history.push(entry);
      addHistoryEntry(bgsId, entry);
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : `Failed at move ${i + 1}`;
      console.error("[eval-ws] failed during move replay", {
        error,
        bgsId,
        moveIndex: i,
        moveNotation,
      });
      // Clean up the BGS on failure
      try {
        await endBgsSession(botCompositeId, bgsId);
      } catch {
        // Ignore cleanup errors
      }
      return { success: false, error: msg };
    }
  }

  console.info("[eval-ws] BGS history initialized", {
    bgsId,
    movesReplayed: moves.length,
    historyLength: history.length,
  });

  return { success: true, history };
};

// ============================================================================
// Handshake Handling
// ============================================================================

/**
 * Handle eval handshake request.
 * This is the main entry point for eval bar connections.
 */
const handleHandshake = async (
  ctx: WSContext,
  socket: EvalSocket,
  message: EvalHandshakeRequest,
): Promise<void> => {
  const { gameId, variant, boardWidth, boardHeight } = message;

  // Validate game ID matches socket's game
  if (gameId !== socket.gameId) {
    send(ctx, {
      type: "eval-handshake-rejected",
      code: "GAME_NOT_FOUND",
      message: "Game ID mismatch",
    });
    return;
  }

  // Try to get the game session
  let session: ReturnType<typeof getSession>;
  try {
    session = getSession(gameId);
  } catch {
    send(ctx, {
      type: "eval-handshake-rejected",
      code: "GAME_NOT_FOUND",
      message: "Game not found",
    });
    return;
  }

  // Find an official eval bot
  const evalBotResult = findEvalBot(variant, boardWidth, boardHeight);
  if (!evalBotResult) {
    send(ctx, {
      type: "eval-handshake-rejected",
      code: "NO_BOT",
      message: "No evaluation bot available for this variant and board size",
    });
    return;
  }

  const { compositeId: botCompositeId } = evalBotResult;
  socket.botCompositeId = botCompositeId;

  // Check if this is a bot game (reuse existing BGS) or human vs human
  const { host, joiner } = session.players;
  const isBotGame = !!host.botCompositeId || !!joiner.botCompositeId;
  const isLiveGame = session.gameState.status === "playing";

  if (isBotGame && isLiveGame) {
    // Bot game: Reuse the existing bot game BGS
    const existingBgs = getBgs(gameId);
    if (existingBgs?.status === "ready") {
      socket.bgsId = gameId;

      // Send handshake accepted
      send(ctx, { type: "eval-handshake-accepted" });

      // Send existing history immediately
      const history = getBgsHistory(gameId);
      const entries: EvalHistoryEntry[] = history.map((h) => ({
        ply: h.ply,
        evaluation: h.evaluation,
        bestMove: h.bestMove,
      }));
      send(ctx, { type: "eval-history", entries });

      console.info("[eval-ws] bot game eval bar connected (reusing BGS)", {
        socketId: socket.id,
        gameId,
        historyLength: entries.length,
      });
      return;
    }

    // BGS not ready yet - send pending then wait
    if (existingBgs?.status === "initializing") {
      send(ctx, { type: "eval-handshake-accepted" });
      send(ctx, {
        type: "eval-pending",
        totalMoves: session.gameState.history.length,
      });

      // Wait for BGS to be ready (poll with exponential backoff)
      const checkBgsReady = async (retries = 10): Promise<void> => {
        const bgs = getBgs(gameId);
        if (bgs?.status === "ready") {
          socket.bgsId = gameId;
          const history = getBgsHistory(gameId);
          const entries: EvalHistoryEntry[] = history.map((h) => ({
            ply: h.ply,
            evaluation: h.evaluation,
            bestMove: h.bestMove,
          }));
          send(ctx, { type: "eval-history", entries });
          return;
        }
        if (retries > 0) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return checkBgsReady(retries - 1);
        }
        // Timeout - send error
        send(ctx, {
          type: "eval-error",
          code: "TIMEOUT",
          message: "Eval bar initialization timed out",
        });
      };

      void checkBgsReady();
      return;
    }

    // No existing BGS for bot game - this shouldn't happen, but handle gracefully
    send(ctx, {
      type: "eval-handshake-rejected",
      code: "INTERNAL_ERROR",
      message: "Bot game BGS not available",
    });
    return;
  }

  // Human vs human or past game replay
  // Per spec: Replay uses unique ID per viewer (ephemeral), live human vs human uses gameId (shared)
  const isReplay = session.gameState.status === "finished";
  const bgsId = isReplay ? `${gameId}_${nanoid()}` : gameId;

  // Check for shared BGS (human vs human live games)
  const existingShared = sharedEvalBgs.get(gameId);
  if (existingShared && isLiveGame) {
    if (existingShared.status === "ready") {
      // Already initialized - send cached history
      socket.bgsId = existingShared.bgsId;
      socket.botCompositeId = existingShared.botCompositeId;
      existingShared.viewerCount++;

      send(ctx, { type: "eval-handshake-accepted" });
      send(ctx, {
        type: "eval-history",
        entries: existingShared.cachedHistory,
      });

      console.info("[eval-ws] eval bar connected (using shared BGS)", {
        socketId: socket.id,
        gameId,
        viewerCount: existingShared.viewerCount,
      });
      return;
    }

    if (existingShared.status === "initializing") {
      // Initialization in progress - wait for it
      existingShared.pendingSocketIds.add(socket.id);
      existingShared.viewerCount++;

      send(ctx, { type: "eval-handshake-accepted" });
      send(ctx, {
        type: "eval-pending",
        totalMoves: session.gameState.history.length,
      });

      console.info("[eval-ws] eval bar waiting for shared BGS", {
        socketId: socket.id,
        gameId,
      });
      return;
    }

    if (existingShared.status === "error") {
      // Previous initialization failed - try again
      sharedEvalBgs.delete(gameId);
    }
  }

  // Start new BGS initialization
  send(ctx, { type: "eval-handshake-accepted" });
  send(ctx, {
    type: "eval-pending",
    totalMoves: session.gameState.history.length,
  });

  // Track shared BGS state for live human vs human games
  if (isLiveGame && !isBotGame) {
    const shared: SharedEvalBgs = {
      bgsId,
      botCompositeId,
      status: "initializing",
      pendingSocketIds: new Set([socket.id]),
      viewerCount: 1,
      cachedHistory: [],
    };
    sharedEvalBgs.set(gameId, shared);
  }

  // Build BGS config
  const config = buildBgsConfigFromSession(session);

  // Convert game history to move notations
  const totalRows = session.config.boardHeight;
  const moves = session.gameState.history.map((entry) => ({
    notation: moveToStandardNotation(entry.move, totalRows),
  }));

  // Initialize BGS asynchronously
  const initResult = await initializeBgsHistory(
    botCompositeId,
    bgsId,
    gameId,
    config,
    moves,
  );

  if (!initResult.success) {
    // Initialization failed
    const shared = sharedEvalBgs.get(gameId);
    if (shared) {
      shared.status = "error";
      shared.errorMessage = initResult.error;

      // Notify all waiting sockets
      for (const waitingSocketId of shared.pendingSocketIds) {
        sendToSocket(waitingSocketId, {
          type: "eval-error",
          code: "INTERNAL_ERROR",
          message: initResult.error,
        });
      }
      sharedEvalBgs.delete(gameId);
    } else {
      send(ctx, {
        type: "eval-error",
        code: "INTERNAL_ERROR",
        message: initResult.error,
      });
    }
    return;
  }

  // Success - update state and send history
  socket.bgsId = bgsId;

  const shared = sharedEvalBgs.get(gameId);
  if (shared) {
    shared.status = "ready";
    shared.cachedHistory = initResult.history;

    // Notify all waiting sockets
    for (const waitingSocketId of shared.pendingSocketIds) {
      const waitingSocket = evalSockets.get(waitingSocketId);
      if (waitingSocket) {
        waitingSocket.bgsId = bgsId;
        sendToSocket(waitingSocketId, {
          type: "eval-history",
          entries: initResult.history,
        });
      }
    }
    shared.pendingSocketIds.clear();
  } else {
    send(ctx, { type: "eval-history", entries: initResult.history });
  }

  console.info("[eval-ws] eval bar initialized", {
    socketId: socket.id,
    gameId,
    bgsId,
    historyLength: initResult.history.length,
    isReplay,
    isLiveGame,
  });

  // For replays, close BGS immediately after sending history
  if (isReplay) {
    try {
      await endBgsSession(botCompositeId, bgsId);
      endBgs(bgsId);
      socket.bgsId = null;
      console.info("[eval-ws] replay BGS closed", { bgsId, gameId });
    } catch (error) {
      console.error("[eval-ws] failed to close replay BGS", { error, bgsId });
    }
  }
};

// ============================================================================
// Move Event Handling (for streaming updates)
// ============================================================================

/**
 * Notify eval bar clients of a new move in a game.
 * Called from game-socket.ts when a move is made.
 */
export const notifyEvalBarMove = async (
  gameId: string,
  moveNotation: string,
): Promise<void> => {
  // Check for shared eval BGS
  const shared = sharedEvalBgs.get(gameId);
  if (shared?.status !== "ready") {
    return;
  }

  const { bgsId, botCompositeId } = shared;
  const bgs = getBgs(bgsId);
  if (!bgs) {
    return;
  }

  // Apply move and get evaluation
  const currentPly = bgs.currentPly;

  try {
    await applyBgsMove(botCompositeId, bgsId, currentPly, moveNotation);

    const newPly = currentPly + 1;
    const response = await requestEvaluation(botCompositeId, bgsId, newPly);

    const entry: EvalHistoryEntry = {
      ply: response.ply,
      evaluation: response.evaluation,
      bestMove: response.bestMove,
    };
    addHistoryEntry(bgsId, entry);
    shared.cachedHistory.push(entry);

    // Broadcast update to all connected eval sockets for this game
    for (const [, socket] of evalSockets) {
      if (socket.gameId === gameId && socket.bgsId === bgsId) {
        send(socket.ctx, {
          type: "eval-update",
          ply: entry.ply,
          evaluation: entry.evaluation,
          bestMove: entry.bestMove,
        });
      }
    }

    console.debug("[eval-ws] eval update broadcast", {
      gameId,
      ply: entry.ply,
      evaluation: entry.evaluation,
    });
  } catch (error) {
    console.error("[eval-ws] failed to update eval bar", {
      error,
      gameId,
      bgsId,
    });

    // Notify clients of error and clean up
    for (const [, socket] of evalSockets) {
      if (socket.gameId === gameId && socket.bgsId === bgsId) {
        send(socket.ctx, {
          type: "eval-error",
          code: "INTERNAL_ERROR",
          message: "Evaluation update failed",
        });
      }
    }

    sharedEvalBgs.delete(gameId);
    try {
      await endBgsSession(botCompositeId, bgsId);
      endBgs(bgsId);
    } catch {
      // Ignore cleanup errors
    }
  }
};

/**
 * Handle game end event - close shared eval BGS.
 * Called from game-socket.ts when a game ends.
 */
export const handleEvalBarGameEnd = async (gameId: string): Promise<void> => {
  const shared = sharedEvalBgs.get(gameId);
  if (!shared) {
    return;
  }

  const { bgsId, botCompositeId } = shared;

  // Clients retain history client-side, so just clean up server state
  sharedEvalBgs.delete(gameId);

  // Close the BGS
  try {
    await endBgsSession(botCompositeId, bgsId);
    endBgs(bgsId);
    console.info("[eval-ws] game ended, shared BGS closed", { gameId, bgsId });
  } catch (error) {
    console.error("[eval-ws] failed to close eval BGS on game end", {
      error,
      gameId,
      bgsId,
    });
  }
};

// ============================================================================
// Message Handling
// ============================================================================

const handleMessage = async (
  ctx: WSContext,
  socket: EvalSocket,
  data: string | ArrayBuffer,
): Promise<void> => {
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
      await handleHandshake(ctx, socket, message);
      break;

    case "eval-request":
      // V3: Ad-hoc eval requests are deprecated.
      // History-based eval bar doesn't need per-position requests.
      send(ctx, {
        type: "eval-error",
        requestId: message.requestId,
        code: "INTERNAL_ERROR",
        message:
          "Ad-hoc eval requests are not supported in V3. Use the eval-history message instead.",
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
// Socket Cleanup
// ============================================================================

const handleSocketClose = (ctx: WSContext, socketId: string): void => {
  const socket = evalSockets.get(socketId);
  if (!socket) return;

  const { gameId, bgsId } = socket;

  // Decrement viewer count for shared BGS
  const shared = sharedEvalBgs.get(gameId);
  if (shared) {
    shared.viewerCount--;
    shared.pendingSocketIds.delete(socketId);

    // Note: We don't close the BGS when viewer count hits 0
    // The BGS stays open until the game ends (per V3 spec)
  }

  cleanupSocket(ctx, socketId);
  console.info("[eval-ws] connection closed", { socketId, gameId, bgsId });
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
            bgsId: null,
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

          void handleMessage(ws, socket, event.data as string | ArrayBuffer);
        },

        onClose(_event: CloseEvent, ws: WSContext) {
          const socketId = getSocketIdForContext(ws);
          if (!socketId) return;

          handleSocketClose(ws, socketId);
        },
      };
    }),
  );

  return websocket;
};
