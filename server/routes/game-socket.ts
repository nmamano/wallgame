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
  type GameSession,
  assignChatGuestIndex,
  registerTimeoutCallback,
} from "../games/store";
import { moderateMessage } from "../chat/moderation";
import { canSendMessage, clearRateLimitEntry } from "../chat/rate-limiter";
import { persistCompletedGame } from "../games/persistence";
import { persistThenBroadcastFinish } from "../games/finish-sequence";
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
import {
  startBgsSession,
  endBgsSession,
  requestEvaluation,
  applyBgsMove,
  notifyBotGameEnded,
} from "./custom-bot-socket";
import { notifyEvalBarMove, handleEvalBarGameEnd } from "./eval-socket";
import { addActiveGame, isBotClientInGrace } from "../games/custom-bot-store";
import {
  getBgs,
  getLatestHistoryEntry,
  markBgsResetting,
  clearBgsResetting,
  getResetPromise,
  getResetGeneration,
  type BgsHistoryEntry,
} from "../games/bgs-store";
import type { BgsConfig } from "../../shared/contracts/custom-bot-protocol";
import {
  moveToStandardNotation,
  moveFromStandardNotation,
} from "../../shared/domain/standard-notation";

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
 * Notify any bot players that the game has ended.
 * Called when game finishes by any means (move, resign, draw, timeout).
 */
const notifyBotsGameEnded = (sessionId: string): void => {
  const session = getSession(sessionId);
  const { host, joiner } = session.players;

  if (host.botCompositeId) {
    void notifyBotGameEnded(host.botCompositeId, sessionId);
  }
  if (joiner.botCompositeId) {
    void notifyBotGameEnded(joiner.botCompositeId, sessionId);
  }
};

// ============================================================================
// V3 Bot Game Session (BGS) Management
// ============================================================================

/**
 * Build BgsConfig from a game session.
 * Extracts variant, board dimensions, and initial state.
 */
const buildBgsConfig = (session: GameSession): BgsConfig => {
  return {
    variant: session.config.variant,
    boardWidth: session.config.boardWidth,
    boardHeight: session.config.boardHeight,
    initialState: session.config.variantConfig,
  };
};

/**
 * Start a Bot Game Session for a bot player.
 * Called when a game is created with a bot participant.
 */
const startBotGameSession = async (
  botCompositeId: string,
  session: GameSession,
): Promise<boolean> => {
  const bgsId = session.id; // Use gameId as bgsId
  const config = buildBgsConfig(session);

  try {
    await startBgsSession(botCompositeId, bgsId, session.id, config);
    console.info("[ws] BGS started for bot game", {
      gameId: session.id,
      bgsId,
      botCompositeId,
    });
    return true;
  } catch (error) {
    console.error("[ws] failed to start BGS", {
      error,
      gameId: session.id,
      botCompositeId,
    });
    return false;
  }
};

/**
 * Get the initial evaluation for a bot game session.
 * Called after BGS is started to get the first position evaluation.
 */
const getInitialEvaluation = async (
  botCompositeId: string,
  bgsId: string,
): Promise<BgsHistoryEntry | null> => {
  try {
    const response = await requestEvaluation(botCompositeId, bgsId, 0);
    return {
      ply: response.ply,
      evaluation: response.evaluation,
      bestMove: response.bestMove,
    };
  } catch (error) {
    console.error("[ws] failed to get initial evaluation", {
      error: error instanceof Error ? error.message : error,
      bgsId,
      botCompositeId,
      bgsStatus: getBgs(bgsId)?.status,
    });
    return null;
  }
};

/**
 * Apply a move to the BGS and get the new evaluation.
 * This is the core V3 flow: apply_move + evaluate_position.
 */
const applyMoveAndEvaluate = async (
  botCompositeId: string,
  bgsId: string,
  currentPly: number,
  moveNotation: string,
): Promise<BgsHistoryEntry | null> => {
  try {
    // Apply the move
    await applyBgsMove(botCompositeId, bgsId, currentPly, moveNotation);

    // Get evaluation for the new position
    const newPly = currentPly + 1;
    const response = await requestEvaluation(botCompositeId, bgsId, newPly);
    return {
      ply: response.ply,
      evaluation: response.evaluation,
      bestMove: response.bestMove,
    };
  } catch (error) {
    console.error("[ws] failed to apply move and evaluate", {
      error,
      bgsId,
      botCompositeId,
      currentPly,
      moveNotation,
    });
    return null;
  }
};

/**
 * Handle bot resignation on BGS failure.
 * Called when BGS operations fail - server resigns on behalf of bot.
 */
const resignBotOnFailure = async (
  session: GameSession,
  botPlayerId: PlayerId,
): Promise<void> => {
  if (session.gameState.status !== "playing") return;

  // Quiet-bail during the disconnect grace period: BGS operations are
  // expected to fail while the bot client's websocket is down. The reattach
  // resync heals the game; if grace expires, the expiry teardown resigns it.
  const botPlayer =
    session.players.host.playerId === botPlayerId
      ? session.players.host
      : session.players.joiner;
  if (
    botPlayer.botCompositeId &&
    isBotClientInGrace(botPlayer.botCompositeId)
  ) {
    console.info("[ws] skipping bot resignation — client in disconnect grace", {
      gameId: session.id,
      botPlayerId,
      botCompositeId: botPlayer.botCompositeId,
    });
    return;
  }

  const newState = resignGame({
    id: session.id,
    playerId: botPlayerId,
    timestamp: Date.now(),
  });

  console.info("[ws] bot resigned due to BGS failure", {
    gameId: session.id,
    botPlayerId,
  });

  // Process rating update if game ended
  if (newState.status === "finished") {
    await processRatingUpdate(session.id);
    try {
      await persistCompletedGame(getSession(session.id));
    } catch (error) {
      console.error("[persistence] failed after bot resignation", {
        error,
        sessionId: session.id,
      });
    }
    broadcastLiveGamesRemove(session.id);
    // Release the engine session, exactly like every other finish path. A
    // forced resignation used to skip this, so each one leaked a session on
    // the engine (capped at 256 per process) — the production bot log shows
    // them as a "Starting game session" with no matching end.
    notifyBotsGameEnded(session.id);
  }

  broadcast(session.id, {
    type: "state",
    state: getSerializedState(session.id),
  });
  sendMatchStatus(session.id);
};

/**
 * Initialize BGS for a bot game and get initial evaluation.
 * Called when a game with a bot starts.
 */
const initializeBotGameSession = async (
  session: GameSession,
  botPlayer: SessionPlayer,
): Promise<boolean> => {
  if (!botPlayer.botCompositeId) return false;

  // Start BGS
  const success = await startBotGameSession(botPlayer.botCompositeId, session);
  if (!success) {
    return false;
  }

  // Get initial evaluation (ply 0)
  const initialEval = await getInitialEvaluation(
    botPlayer.botCompositeId,
    session.id,
  );

  if (!initialEval) {
    // Clean up and fail
    try {
      await endBgsSession(botPlayer.botCompositeId, session.id);
    } catch {
      // Ignore cleanup errors
    }
    return false;
  }

  console.info("[ws] BGS initialized with evaluation", {
    gameId: session.id,
    initialEval,
  });

  return true;
};

/**
 * V3: Execute bot's turn using BGS history.
 * The best move is already computed in the BGS history from the previous evaluation.
 * This function: 1) Gets best move from history, 2) Applies it to game, 3) Updates BGS.
 */
const executeBotTurnV3 = async (sessionId: string): Promise<void> => {
  const session = getSession(sessionId);
  if (session.gameState.status !== "playing") return;

  const activeTurn = session.gameState.turn;

  // Find which player is active
  const isHostActive = session.players.host.playerId === activeTurn;
  const activePlayer = isHostActive
    ? session.players.host
    : session.players.joiner;

  // Only proceed if active player is a bot
  if (!activePlayer.botCompositeId) return;

  const bgsId = sessionId;
  const bgs = getBgs(bgsId);

  if (!bgs) {
    console.error("[ws] BGS not found for bot turn", {
      sessionId,
      botCompositeId: activePlayer.botCompositeId,
    });
    await resignBotOnFailure(session, activePlayer.playerId);
    return;
  }

  // Sync guard: only play when the BGS has seen every move in the game
  // history. A turn-based check alone races: a human move can be applied to
  // the game state while the BGS is still initializing (or catching up), and
  // playing the stale "best move" here would desync the engine from the game.
  // Whoever drives the catch-up (the human-move handler, the takeback replay)
  // re-triggers the bot turn once the BGS is in sync, so returning is safe.
  if (bgs.currentPly !== session.gameState.history.length) {
    console.info("[ws] bot turn skipped — BGS not in sync with game history", {
      sessionId,
      bgsPly: bgs.currentPly,
      gameHistoryLength: session.gameState.history.length,
    });
    return;
  }

  // Get the best move from BGS history (already computed from previous evaluation)
  const latestEntry = getLatestHistoryEntry(bgsId);
  if (!latestEntry) {
    console.error("[ws] No history entry for bot turn", {
      sessionId,
      bgsId,
      currentPly: bgs.currentPly,
    });
    await resignBotOnFailure(session, activePlayer.playerId);
    return;
  }

  const bestMoveNotation = latestEntry.bestMove;
  const totalRows = session.config.boardHeight;

  // Parse the move and apply to game state
  const move = moveFromStandardNotation(bestMoveNotation, totalRows);
  const newState = applyPlayerMove({
    id: sessionId,
    playerId: activePlayer.playerId,
    move,
    timestamp: Date.now(),
  });

  console.info("[ws] bot move applied", {
    sessionId,
    playerId: activePlayer.playerId,
    move: bestMoveNotation,
    ply: bgs.currentPly,
  });

  // Handle game end. The finished state is broadcast only AFTER the game has
  // been persisted, matching every other finish path: puzzle completion is
  // derived from the stored game, so a client must not be able to ask what it
  // has solved before the row exists (S-G3).
  if (newState.status === "finished") {
    await processRatingUpdate(sessionId);
    await persistThenBroadcastFinish({
      persist: () => persistCompletedGame(getSession(sessionId)),
      broadcast: () =>
        broadcast(sessionId, {
          type: "state",
          state: getSerializedState(sessionId),
        }),
      onPersistError: (error) =>
        console.error("[persistence] failed after bot move", {
          error,
          sessionId,
        }),
    });
    broadcastLiveGamesRemove(sessionId);
    notifyBotsGameEnded(sessionId);
    sendMatchStatus(sessionId);
    return;
  }

  // Game continues - update BGS BEFORE broadcasting to human
  // This ensures the BGS is synchronized before human can make their next move
  broadcastLiveGamesUpsert(sessionId);

  // Apply move to BGS and get new evaluation
  const evalResult = await applyMoveAndEvaluate(
    activePlayer.botCompositeId,
    bgsId,
    bgs.currentPly,
    bestMoveNotation,
  );

  if (!evalResult) {
    // If the BGS was deleted or replaced (e.g., a takeback arrived mid-turn),
    // the failure is expected — the takeback handler owns the BGS now.
    const currentBgs = getBgs(bgsId);
    if (
      !currentBgs ||
      currentBgs.status === "initializing" ||
      getResetPromise(bgsId)
    ) {
      console.info(
        "[ws] BGS operation failed but BGS is resetting/gone (takeback?)",
        { sessionId, bgsExists: !!currentBgs },
      );
      return;
    }
    console.error("[ws] failed to update BGS after bot move", {
      sessionId,
      botCompositeId: activePlayer.botCompositeId,
    });
    await resignBotOnFailure(session, activePlayer.playerId);
    return;
  }

  // Now broadcast state update to human - BGS is fully synchronized
  broadcast(sessionId, {
    type: "state",
    state: getSerializedState(sessionId),
  });

  // If it's still the bot's turn (shouldn't happen in normal flow), recurse
  // This handles edge cases like "pass" moves
  const updatedSession = getSession(sessionId);
  if (
    updatedSession.gameState.status === "playing" &&
    updatedSession.gameState.turn === activePlayer.playerId
  ) {
    // Schedule next bot move asynchronously to avoid stack overflow
    setImmediate(() => {
      void executeBotTurnV3(sessionId);
    });
  }
};

/**
 * V3: Rebuild a bot game session to match the game's current history: end the
 * BGS, start a fresh one from the authored config, replay the history, and
 * play the bot's turn if it is due. Generation-token guarded, so concurrent
 * resyncs supersede each other safely.
 *
 * Used when a takeback is accepted in a bot game, and by the bot-client
 * reattach path to heal every active game after a connection drop (the
 * rebuild is idempotent against whatever state the client lost or kept).
 */
export const resyncBgsFromHistory = async (
  sessionId: string,
  botCompositeId: string,
): Promise<void> => {
  const bgsId = sessionId;

  // Snapshot the history BEFORE any async operations. The human's move handler
  // can apply moves to game state concurrently (it only blocks the BGS update
  // on the reset promise, not the game state update). We must replay from a
  // frozen snapshot, not the live history — otherwise moves played during the
  // reset get replayed AND re-applied by the move handler (double-apply bug).
  const sessionAtTakeback = getSession(sessionId);
  const replaySnapshot = [...sessionAtTakeback.gameState.history];
  const historyLengthAtTakeback = replaySnapshot.length;
  const totalRows = sessionAtTakeback.config.boardHeight;

  // Mark as resetting ONCE, before anything else. This promise lives outside
  // the BGS object (in a standalone map) so it survives the BGS delete+recreate
  // cycle. It is resolved only in the finally block below.
  // The generation token ensures that if a second takeback fires, the first
  // takeback's finally block won't destroy the second's promise.
  const resetGeneration = markBgsResetting(bgsId);

  // A newer resync takes ownership of the BGS by ending the current session,
  // which cancels whatever request this one has in flight. Every await below
  // can therefore fail for a reason that is not an engine failure, and the
  // failure branches must ask this before resigning the bot: the newer owner
  // is already rebuilding the session, so there is nothing to heal here.
  const superseded = (): boolean =>
    getResetGeneration(bgsId) !== resetGeneration;

  try {
    // End the current BGS
    try {
      await endBgsSession(botCompositeId, bgsId);
    } catch (error) {
      console.error("[ws] failed to end BGS for takeback", {
        error,
        sessionId,
      });
      // Continue anyway - we need to start fresh
    }

    // Bail if a newer reset has superseded this one
    if (superseded()) {
      console.info("[ws] takeback reset superseded by newer reset", {
        sessionId,
        resetGeneration,
      });
      return;
    }

    // Get the current session state (for bot player info and config)
    const session = getSession(sessionId);

    // Find the bot player
    const botPlayer = session.players.host.botCompositeId
      ? session.players.host
      : session.players.joiner;

    if (!botPlayer.botCompositeId) return;

    // Start a new BGS with the same ID
    const config = buildBgsConfig(session);
    try {
      await startBgsSession(botCompositeId, bgsId, sessionId, config);
    } catch (error) {
      if (superseded()) {
        console.info("[ws] takeback BGS start cancelled by newer reset", {
          sessionId,
          resetGeneration,
        });
        return;
      }
      console.error("[ws] failed to restart BGS after takeback", {
        error,
        sessionId,
      });
      await resignBotOnFailure(session, botPlayer.playerId);
      return;
    }

    // Bail if a newer reset has superseded this one
    if (superseded()) {
      console.info("[ws] takeback reset superseded after BGS start", {
        sessionId,
        resetGeneration,
      });
      return;
    }

    // Get initial evaluation
    const initialEval = await getInitialEvaluation(botCompositeId, bgsId);
    if (!initialEval) {
      if (superseded()) {
        console.info("[ws] takeback initial eval cancelled by newer reset", {
          sessionId,
          resetGeneration,
        });
        return;
      }
      console.error("[ws] failed to get initial eval after takeback", {
        sessionId,
      });
      await resignBotOnFailure(session, botPlayer.playerId);
      return;
    }

    // Replay moves from the SNAPSHOT (not the live history).
    // This prevents moves played during the reset from being included in
    // the replay — those will be handled by their own move handlers.
    for (let i = 0; i < replaySnapshot.length; i++) {
      // Check for superseding reset before each expensive async operation
      if (superseded()) {
        console.info("[ws] takeback reset superseded during replay", {
          sessionId,
          resetGeneration,
          replayedSoFar: i,
        });
        return;
      }

      const historyEntry = replaySnapshot[i];
      const moveNotation = moveToStandardNotation(historyEntry.move, totalRows);
      const evalResult = await applyMoveAndEvaluate(
        botCompositeId,
        bgsId,
        i,
        moveNotation,
      );
      if (!evalResult) {
        // The supersede check at the top of the loop cannot catch this: a
        // newer reset cancels the request while we are parked on the await
        // above, so control never reaches it. Production game Cb4nYTIS
        // (2026-07-30) resigned a bot mid-game exactly this way, after three
        // takebacks in twelve seconds.
        if (superseded()) {
          console.info("[ws] takeback replay cancelled by newer reset", {
            sessionId,
            resetGeneration,
            moveIndex: i,
          });
          return;
        }
        console.error("[ws] failed to replay move during takeback", {
          sessionId,
          moveIndex: i,
        });
        await resignBotOnFailure(session, botPlayer.playerId);
        return;
      }
    }

    console.info("[ws] BGS takeback reset complete", {
      sessionId,
      movesReplayed: replaySnapshot.length,
    });

    // Check if the human played a move while the reset was in progress.
    // Compare against the snapshot taken BEFORE async operations — this
    // correctly detects moves played at any point during the reset.
    const currentSession = getSession(sessionId);
    const gameAdvancedDuringReset =
      currentSession.gameState.history.length > historyLengthAtTakeback;

    if (
      !gameAdvancedDuringReset &&
      currentSession.gameState.status === "playing" &&
      currentSession.gameState.turn === botPlayer.playerId
    ) {
      // No new moves during reset, and it's the bot's turn — play it.
      // Await so the reset promise stays pending until the bot's turn
      // completes, preventing the move handler from racing with BGS updates.
      await executeBotTurnV3(sessionId);
    }
  } finally {
    clearBgsResetting(bgsId, resetGeneration);
  }
};

/**
 * V3: Register bot games for rematch and initialize BGS.
 * This replaces the V2 registerRematchBotGames function.
 */
const registerRematchBotGamesV3 = async (
  session: RematchSessionResult["newSession"],
  startBotTurn: boolean,
): Promise<void> => {
  if (session.gameState.status !== "playing") return;

  const { host, joiner } = session.players;

  // Find which player is the bot (if any)
  const botPlayer = host.botCompositeId
    ? host
    : joiner.botCompositeId
      ? joiner
      : null;

  if (!botPlayer?.botCompositeId) return;

  // Skip if BGS already exists (e.g., "already-started" rematch path called us redundantly)
  if (getBgs(session.id)) return;

  const opponent = botPlayer === host ? joiner : host;

  // Track active bot game
  addActiveGame(
    botPlayer.botCompositeId,
    session.id,
    botPlayer.playerId,
    opponent.displayName,
  );

  // Initialize BGS for the new game
  const success = await initializeBotGameSession(session, botPlayer);
  if (!success) {
    console.error("[ws] failed to initialize BGS for rematch", {
      gameId: session.id,
      botCompositeId: botPlayer.botCompositeId,
    });
    await resignBotOnFailure(session, botPlayer.playerId);
    return;
  }

  // If it's the bot's turn and we should start, execute the turn
  if (startBotTurn && session.gameState.turn === botPlayer.playerId) {
    void executeBotTurnV3(session.id);
  }
};

/**
 * V3: Initialize BGS when a player connects to a bot game.
 * This is called on WebSocket connection to ensure BGS is ready.
 */
const initializeBotGameOnStart = async (sessionId: string): Promise<void> => {
  const session = getSession(sessionId);

  // Only initialize for games that are ready or just started
  if (session.status !== "ready" && session.status !== "in-progress") {
    return;
  }

  const { host, joiner } = session.players;

  // Find the bot player (if any)
  const botPlayer = host.botCompositeId
    ? host
    : joiner.botCompositeId
      ? joiner
      : null;

  if (!botPlayer?.botCompositeId) {
    return; // Not a bot game
  }

  // Check if BGS already exists (e.g., rematch flow already created it, or reconnect)
  const existingBgs = getBgs(sessionId);
  if (existingBgs) {
    // Only trigger bot turn if BGS is fully idle — no pending request (e.g., initial
    // evaluation still in-flight from registerRematchBotGamesV3) and no reset in progress.
    if (
      session.gameState.status === "playing" &&
      session.gameState.turn === botPlayer.playerId &&
      existingBgs.status === "ready" &&
      !existingBgs.pendingRequest &&
      !getResetPromise(sessionId)
    ) {
      void executeBotTurnV3(sessionId);
    }
    return;
  }

  // S-P1: a puzzle game with a scripted lead-in already has real history
  // BEFORE any BGS exists. The fresh-init path below assumes ply 0, which
  // desyncs the engine from the game forever (the sync guard then correctly
  // refuses every bot turn). Build the session through the history rebuild
  // instead — it starts the BGS from the authored (pre-position) config,
  // replays the recorded moves, and resigns the bot on any failure.
  if (session.gameState.history.length > 0) {
    console.info("[ws] initializing BGS via history rebuild (lead-in game)", {
      sessionId,
      historyLength: session.gameState.history.length,
      botCompositeId: botPlayer.botCompositeId,
    });
    await resyncBgsFromHistory(sessionId, botPlayer.botCompositeId);
    return;
  }

  // Initialize BGS for this bot game
  console.info("[ws] initializing BGS on player connect", {
    sessionId,
    botCompositeId: botPlayer.botCompositeId,
  });

  const success = await initializeBotGameSession(session, botPlayer);
  if (!success) {
    console.error("[ws] failed to initialize BGS on connect", {
      sessionId,
      botCompositeId: botPlayer.botCompositeId,
    });
    await resignBotOnFailure(session, botPlayer.playerId);
    return;
  }

  // If it's the bot's turn, execute the first move
  if (session.gameState.turn === botPlayer.playerId) {
    void executeBotTurnV3(sessionId);
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

/**
 * Whether another still-open socket holds the same seat as `entry`.
 *
 * A seat is a single `connected` boolean but can have several sockets at once:
 * the player opened a second tab, or a reconnect's new socket opened before the
 * old one's close was delivered. Treating the first close as "the player left"
 * is wrong in both cases, and it is not merely cosmetic - an unlimited game
 * arms its abandonment timer off that boolean, so a seat wrongly marked gone is
 * eventually resigned while its player is still sitting there playing.
 *
 * Exported for tests: the two-sockets-one-seat case cannot be reached through
 * the store's own API.
 */
export const seatHasOtherSocket = (
  sockets: Iterable<SessionSocket> | undefined,
  entry: SessionSocket,
): boolean => {
  if (!sockets || !entry.socketToken) return false;
  for (const other of sockets) {
    if (other !== entry && other.socketToken === entry.socketToken) {
      return true;
    }
  }
  return false;
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
    // V3: Register bot games asynchronously
    void registerRematchBotGamesV3(existingResult.newSession, false);
    return { kind: "already-started", result: existingResult };
  }
  const result = createRematchSession(sessionId);
  // V3: Initialize BGS and execute first bot turn if needed
  void registerRematchBotGamesV3(result.newSession, true);
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

/**
 * Handle timeout when the server-side timer fires.
 * Registered as a callback with the store module.
 */
const handleTimeoutFromTimer = async (sessionId: string): Promise<void> => {
  // Process rating update
  await processRatingUpdate(sessionId);
  try {
    await persistCompletedGame(getSession(sessionId));
  } catch (error) {
    console.error("[persistence] failed after timeout", {
      error,
      sessionId,
    });
  }

  // Broadcast removal from live games list
  broadcastLiveGamesRemove(sessionId);

  // Notify any bot players that the game ended
  notifyBotsGameEnded(sessionId);

  // Broadcast final state and match status to all connected clients
  broadcast(sessionId, {
    type: "state",
    state: getSerializedState(sessionId),
  });
  sendMatchStatus(sessionId);
};

// Register the timeout callback so timers can trigger broadcasts
registerTimeoutCallback(handleTimeoutFromTimer);

const handleMove = async (socket: SessionSocket, message: ClientMessage) => {
  if (message.type !== "submit-move") return;
  const playerId = ensureAuthorizedPlayer(socket, "submit-move");
  if (playerId === null) return;

  const session = getSession(socket.sessionId);
  const totalRows = session.config.boardHeight;

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
    // Notify any bot players that the game ended
    notifyBotsGameEnded(socket.sessionId);
    // Clean up eval bar state for human vs human games
    void handleEvalBarGameEnd(socket.sessionId);
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
    // V3: If game has a bot opponent, update BGS and trigger bot's turn
    const updatedSession = getSession(socket.sessionId);
    const { host, joiner } = updatedSession.players;

    // Find the bot player (if any)
    const botPlayer = host.botCompositeId
      ? host
      : joiner.botCompositeId
        ? joiner
        : null;

    if (botPlayer?.botCompositeId) {
      const bgsId = socket.sessionId;

      // The target ply after this move is applied to the BGS. Used below
      // to detect if the takeback replay already handled this move.
      const targetHistoryLength = updatedSession.gameState.history.length;

      // Wait for BGS to be available if it's resetting (takeback replay),
      // still initializing (game just started), or has an in-flight request
      // (e.g., initial evaluation still pending from getInitialEvaluation).
      const resetPromise = getResetPromise(bgsId);
      let bgs = getBgs(bgsId);

      if (
        resetPromise ||
        bgs?.status === "initializing" ||
        bgs?.pendingRequest
      ) {
        if (resetPromise) {
          // Takeback reset in progress — await the promise with a safety timeout.
          // The promise resolves when clearBgsResetting is called in the finally
          // block of resyncBgsFromHistory. The 60s timeout is a safety net only;
          // the promise should always resolve in normal operation.
          console.debug("[ws] move handler awaiting BGS reset", {
            sessionId: socket.sessionId,
          });
          let timeoutId: ReturnType<typeof setTimeout>;
          const timeout = new Promise<"timeout">((r) => {
            timeoutId = setTimeout(() => r("timeout"), 60_000);
          });
          const result = await Promise.race([
            resetPromise.then(() => "done" as const),
            timeout,
          ]);
          clearTimeout(timeoutId!);
          if (result === "timeout") {
            console.error("[ws] BGS reset timed out after 60s", {
              sessionId: socket.sessionId,
            });
            await resignBotOnFailure(updatedSession, botPlayer.playerId);
            return;
          }
        } else {
          // BGS is initializing or has a pending request (e.g., initial eval) — brief poll.
          const maxWaitMs = 10_000;
          const pollIntervalMs = 50;
          const startTime = Date.now();
          while (Date.now() - startTime < maxWaitMs) {
            await new Promise((r) => setTimeout(r, pollIntervalMs));
            bgs = getBgs(bgsId);
            if (!bgs || (bgs.status === "ready" && !bgs.pendingRequest)) break;
          }
        }
        bgs = getBgs(bgsId);
      }

      if (
        bgs?.status === "ready" &&
        !getResetPromise(bgsId) &&
        !bgs.pendingRequest
      ) {
        // Idempotency guard: if the BGS ply is already at or past where this
        // move would land, the takeback replay already applied it. Skip to
        // avoid double-applying the same move (which causes engine rejection).
        if (bgs.currentPly >= targetHistoryLength) {
          console.info(
            "[ws] BGS already up-to-date — move was replayed during reset",
            {
              sessionId: socket.sessionId,
              bgsPly: bgs.currentPly,
              targetHistoryLength,
            },
          );
          // Still trigger bot turn if needed — the replay may not have done it
          // (e.g., game advanced during reset so the reset handler skipped it).
          if (updatedSession.gameState.turn === botPlayer.playerId) {
            void executeBotTurnV3(socket.sessionId);
          }
        } else {
          // Apply human's move to BGS
          const moveNotation = moveToStandardNotation(message.move, totalRows);
          const evalResult = await applyMoveAndEvaluate(
            botPlayer.botCompositeId,
            bgsId,
            bgs.currentPly,
            moveNotation,
          );

          if (evalResult) {
            // If it's now the bot's turn, execute it
            if (updatedSession.gameState.turn === botPlayer.playerId) {
              void executeBotTurnV3(socket.sessionId);
            }
          } else {
            // BGS update failed — check if a takeback started mid-operation.
            // If so, the failure is expected (the takeback handler cancelled our
            // pending request). Same graceful bail as executeBotTurnV3.
            const currentBgs = getBgs(bgsId);
            if (
              !currentBgs ||
              currentBgs.status === "initializing" ||
              getResetPromise(bgsId)
            ) {
              console.info(
                "[ws] BGS update failed after human move — takeback in progress",
                { sessionId: socket.sessionId, bgsExists: !!currentBgs },
              );
            } else {
              console.error("[ws] BGS update failed after human move", {
                sessionId: socket.sessionId,
                botCompositeId: botPlayer.botCompositeId,
              });
              await resignBotOnFailure(updatedSession, botPlayer.playerId);
            }
          }
        }
      } else if (!getResetPromise(bgsId)) {
        // BGS is missing or not ready, and no reset is in progress.
        // This can happen if the BGS was deleted by a disconnect, timeout,
        // or end-session race. Resign rather than silently desyncing.
        console.error("[ws] BGS unavailable after wait — resigning bot", {
          sessionId: socket.sessionId,
          bgsExists: !!bgs,
          bgsStatus: bgs?.status,
          hasPendingRequest: !!bgs?.pendingRequest,
        });
        await resignBotOnFailure(updatedSession, botPlayer.playerId);
      }
    } else {
      // Human vs human game: notify eval bar if active
      const moveNotation = moveToStandardNotation(message.move, totalRows);
      void notifyEvalBarMove(socket.sessionId, moveNotation);
    }
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
    // Notify any bot players that the game ended
    notifyBotsGameEnded(socket.sessionId);
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

  const session = getSession(socket.sessionId);
  const opponentRole = socket.role === "host" ? "joiner" : "host";
  const opponent =
    opponentRole === "host" ? session.players.host : session.players.joiner;

  // V3: Takeback auto-accepted by bot
  if (opponent.botCompositeId) {
    acceptTakeback({
      id: socket.sessionId,
      playerId: opponent.playerId,
    });
    // V3: Handle takeback by ending BGS and starting new one
    void resyncBgsFromHistory(socket.sessionId, opponent.botCompositeId);
    console.info("[ws] takeback-offer auto-accepted (bot opponent)", {
      sessionId: socket.sessionId,
      playerId,
      botCompositeId: opponent.botCompositeId,
    });
    broadcast(socket.sessionId, {
      type: "state",
      state: getSerializedState(socket.sessionId),
    });
    return;
  }

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

  // V3: If game has a bot, handle BGS reset
  const session = getSession(socket.sessionId);
  const botPlayer = session.players.host.botCompositeId
    ? session.players.host
    : session.players.joiner.botCompositeId
      ? session.players.joiner
      : null;
  if (botPlayer?.botCompositeId) {
    void resyncBgsFromHistory(socket.sessionId, botPlayer.botCompositeId);
  }

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

  // V3: Server auto-rejects draw offers in bot games (no message to bot)
  if (opponent.botCompositeId) {
    socket.ctx.send(
      JSON.stringify({
        type: "draw-rejected",
        playerId: opponent.playerId,
      }),
    );
    console.info("[ws] draw-offer auto-rejected (bot game, V3 policy)", {
      sessionId: socket.sessionId,
      playerId,
      botCompositeId: opponent.botCompositeId,
    });
    return;
  }

  // Regular player opponent - send via WebSocket
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
    // Notify any bot players that the game ended
    notifyBotsGameEnded(socket.sessionId);
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

  const session = getSession(socket.sessionId);
  const opponentRole = socket.role === "host" ? "joiner" : "host";
  const opponent =
    opponentRole === "host" ? session.players.host : session.players.joiner;

  // V3: server auto-accepts rematches for bots
  if (opponent.botCompositeId) {
    try {
      const outcome = ensureRematchSession(socket.sessionId);
      broadcastRematchStarted(socket.sessionId, outcome.result);
      console.info("[ws] rematch-offer auto-accepted (bot opponent)", {
        sessionId: socket.sessionId,
        playerId,
        botCompositeId: opponent.botCompositeId,
        newGameId: outcome.result.newSession.id,
      });
    } catch (error) {
      console.error("[ws] rematch auto-accept failed", {
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
    return;
  }

  // Regular player opponent - send rematch offer via WebSocket
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
    case "survival":
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
          // Notify any bot players that the game ended
          notifyBotsGameEnded(socket.sessionId);
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
      const session = getSession(socket.sessionId);
      const opponentRole = socket.role === "host" ? "joiner" : "host";
      const opponent =
        opponentRole === "host" ? session.players.host : session.players.joiner;

      // V3: Server auto-rejects draw offers in bot games (no message to bot)
      if (opponent.botCompositeId) {
        socket.ctx.send(
          JSON.stringify({
            type: "draw-rejected",
            playerId: opponent.playerId,
          }),
        );
        sendActionAck(socket, message);
        console.info(
          "[ws] action-offerDraw auto-rejected (bot game, V3 policy)",
          {
            sessionId: socket.sessionId,
            playerId,
            botCompositeId: opponent.botCompositeId,
          },
        );
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
      const session = getSession(socket.sessionId);
      const opponentRole = socket.role === "host" ? "joiner" : "host";
      const opponent =
        opponentRole === "host" ? session.players.host : session.players.joiner;
      // V3: Takeback auto-accepted by bot, need to handle BGS
      if (opponent.botCompositeId) {
        acceptTakeback({
          id: socket.sessionId,
          playerId: opponent.playerId,
        });
        // V3: Handle takeback by ending BGS and starting new one
        void resyncBgsFromHistory(socket.sessionId, opponent.botCompositeId);
        sendActionAck(socket, message);
        console.info(
          "[ws] action-requestTakeback auto-accepted (bot opponent)",
          {
            sessionId: socket.sessionId,
            playerId,
            botCompositeId: opponent.botCompositeId,
          },
        );
        broadcast(socket.sessionId, {
          type: "state",
          state: getSerializedState(socket.sessionId),
        });
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
      const session = getSession(socket.sessionId);
      const opponentRole = socket.role === "host" ? "joiner" : "host";
      const opponent =
        opponentRole === "host" ? session.players.host : session.players.joiner;

      // V3: server auto-accepts rematches for bots
      if (opponent.botCompositeId) {
        try {
          const outcome = ensureRematchSession(socket.sessionId);
          sendActionAck(socket, message);
          broadcastRematchStarted(socket.sessionId, outcome.result);
          console.info(
            "[ws] action-offerRematch auto-accepted (bot opponent)",
            {
              sessionId: socket.sessionId,
              playerId,
              botCompositeId: opponent.botCompositeId,
              newGameId: outcome.result.newSession.id,
            },
          );
        } catch (error) {
          console.error("[ws] action-offerRematch auto-accept failed", {
            error,
            sessionId: socket.sessionId,
            playerId,
          });
          sendActionNack(socket, message, "REMATCH_NOT_AVAILABLE", { error });
        }
        return;
      }

      // Regular player opponent - send rematch offer via WebSocket
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
    : ["https://wallgame.fly.dev", "https://wallgame.io"];

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

            // V3: Initialize BGS for bot games on first player connection
            void initializeBotGameOnStart(sessionId);
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
          } else if (
            seatHasOtherSocket(sessionSockets.get(entry.sessionId), entry)
          ) {
            // The seat is still held by another tab, or by the socket that
            // replaced this one, so the player has not gone anywhere.
            console.info("[ws] socket closed, seat still held elsewhere", {
              sessionId: entry.sessionId,
              socketToken: entry.socketToken,
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
