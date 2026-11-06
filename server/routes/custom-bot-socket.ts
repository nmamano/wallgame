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

import { createHash, timingSafeEqual } from "node:crypto";
import { logLine } from "../log-line";
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
  type BgsConfig,
  type GameSessionStartedMessage,
  type GameSessionEndedMessage,
  type EvaluateResponseMessage,
  type MoveAppliedMessage,
} from "../../shared/contracts/custom-bot-protocol";
import type { BotGameSession } from "../games/bgs-store";
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
  markClientDisconnected,
  type ActiveBotGame,
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
  resyncBgsFromHistory,
} from "./game-socket";

const { upgradeWebSocket, websocket } = createBunWebSocket();

// Official bot token from environment
const OFFICIAL_BOT_TOKEN = process.env.OFFICIAL_BOT_TOKEN;

/**
 * Whether `token` is the official bot token, compared in constant time. Both
 * sides are hashed first, so the compare does not depend on the length either.
 * False when the server has no token configured.
 */
const isOfficialToken = (token: string): boolean => {
  if (!OFFICIAL_BOT_TOKEN) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(token), digest(OFFICIAL_BOT_TOKEN));
};

/**
 * Every clientId that has attached with the official token since the server
 * started. Such an id stays reserved for the token after its registration is
 * gone (the grace ended, e.g. the bot client was down for a restart), so
 * nobody can take its bot ids while it is away.
 */
const officialClientIds = new Set<string>();

// ============================================================================
// Constants
// ============================================================================

/**
 * Timeout for BGS requests (10 seconds as per V3 spec). Overridable via
 * BGS_REQUEST_TIMEOUT_MS, only for tests.
 */
export const BGS_REQUEST_TIMEOUT_MS = (() => {
  const raw = process.env.BGS_REQUEST_TIMEOUT_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 10_000;
})();

/** Maximum unexpected messages before disconnect */
const MAX_UNEXPECTED_MESSAGES = 100;

/**
 * Grace period after a bot client's websocket drops before its games are
 * resigned and the client unregistered. Reattaching within the window keeps
 * registration and games alive (each game's BGS is rebuilt via resync).
 *
 * 60 s, not 30 s (task 43d8c5ae): the official client finds a dead socket
 * only on its next 30 s ping, so it can reattach up to about 60 s after a
 * stall starts. Overridable via BOT_DISCONNECT_GRACE_MS, mainly for tests.
 */
export const DEFAULT_BOT_DISCONNECT_GRACE_MS = 60_000;
const BOT_DISCONNECT_GRACE_MS = (() => {
  const raw = process.env.BOT_DISCONNECT_GRACE_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_BOT_DISCONNECT_GRACE_MS;
})();

// ============================================================================
// Types
// ============================================================================

interface BotSocket {
  ctx: WSContext;
  clientId: string | null; // null until attached
  attached: boolean;
  unexpectedMessageCount: number;
  /**
   * Set when a newer connection attached with the same clientId. This
   * socket's close event must not tear anything down — the clientId now
   * belongs to the newer connection.
   */
  superseded: boolean;
  /**
   * How many frames of any kind (responses, the client's 30 s ping) arrived
   * on this socket. A request that times out with this count unchanged since
   * it was sent means the connection is gone, not the engine. A counter, not
   * a time: the previous response and the next request can share a
   * millisecond.
   */
  inboundFrames: number;
}

/** Response types the bot can send */
type BotResponseType =
  | "game_session_started"
  | "game_session_ended"
  | "evaluate_response"
  | "move_applied";

/** Resolver for pending BGS requests */
interface BgsRequestResolver<T> {
  resolve: (result: T) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  /** Expected response type — used to detect stale responses after resolver overwrite */
  expectedResponseType: BotResponseType;
  /**
   * True for a drain: a slot that only waits for the reply to a request that
   * was already cancelled. Nothing waits on its answer, so it is never
   * cancelled itself - the reply it waits for must arrive before End.
   */
  drain: boolean;
}

/** Milliseconds since a cleared request was sent, or undefined if none was. */
const elapsedSince = (
  pending: { createdAt: number } | null,
): number | undefined => (pending ? Date.now() - pending.createdAt : undefined);

/**
 * The one line per bot reply. A reply that the bot failed, or that the server
 * refused (`refused` names why), is a warning with every field the bot sent,
 * because that is the record a forfeit investigation starts from.
 */
const logBotReply = (
  kind: BotResponseType,
  fields: {
    bgsId: string;
    success: boolean;
    error?: string;
    refused?: string;
  } & Record<string, unknown>,
): void => {
  const tag = `[custom-bot-ws] ${kind} handled`;
  if (fields.success && fields.refused === undefined) {
    logLine(tag, { ...fields, error: undefined });
  } else {
    console.warn(tag, fields);
  }
};

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

/**
 * Whether this connection is still the one the clientId maps to. Identity is
 * compared on the context and on its raw socket, because the raw object is
 * stable per connection while the context object's identity may not be.
 */
const ownsClientIdMapping = (ctx: WSContext, clientId: string): boolean => {
  const currentCtx = clientIdToContext.get(clientId);
  return (
    !!currentCtx &&
    (currentCtx === ctx ||
      (!!currentCtx.raw &&
        typeof currentCtx.raw === "object" &&
        currentCtx.raw === ctx.raw))
  );
};

/** When disconnectIfSilent last fired, per clientId. */
const lastSilentDisconnectAt = new Map<string, number>();

/**
 * A request sent on `ctx` timed out (`framesAtSend`: the socket's
 * inboundFrames when it was sent). If nothing at all has arrived on that
 * socket since then (not even the client's 30 s ping), the
 * connection is gone and the server has not seen it close yet: during a
 * network stall the close can come a minute late, or never. Treat it as a
 * close now, so the client's games wait in the disconnect grace for its
 * reattach (which rebuilds them) instead of being forfeited as an engine
 * failure. Returns true when it did. Fires at most once per client per grace
 * window (see below), so a hung engine forfeits after one reconnect cycle.
 *
 * A frame since the request means the connection works and the engine did not
 * answer: that stays an engine failure. Game E56U_8Ds (2026-10-25) was
 * forfeited 10 s into a stall; its client reattached 13 s later.
 */
const disconnectIfSilent = (
  ctx: WSContext,
  framesAtSend: number,
  requestType: string,
  bgsId: string,
): boolean => {
  const socket = getSocketForContext(ctx);
  if (!socket?.clientId || socket.superseded) return false;
  if (socket.inboundFrames !== framesAtSend) return false;
  if (!ownsClientIdMapping(ctx, socket.clientId)) return false;

  // At most once per client per grace window. A hung engine on a quiet socket
  // would otherwise loop: disconnect, reattach, the resync's request times
  // out on the new socket before its first ping (the client starts its 30 s
  // ping loop at attach), disconnect again - and each cycle rebuilds every
  // game of the client. The second silent timeout inside the window is an
  // engine failure, as before. The expiry is a fixed time, the grace length,
  // not "until the new socket's first frame": the first ping comes at 30 s,
  // inside the 60 s window, and a fixed time needs no state on the socket.
  // The record lives outside the socket and pendingGrace, which a reattach
  // replaces and deletes.
  const now = Date.now();
  const previous = lastSilentDisconnectAt.get(socket.clientId);
  if (previous !== undefined && now - previous < BOT_DISCONNECT_GRACE_MS) {
    console.info(
      "[custom-bot-ws] second silent timeout inside the grace window — an engine failure",
      { clientId: socket.clientId, requestType, bgsId },
    );
    return false;
  }
  lastSilentDisconnectAt.set(socket.clientId, now);

  console.info(
    "[custom-bot-ws] request timed out on a silent connection — treating it as a disconnect",
    { clientId: socket.clientId, requestType, bgsId },
  );
  // What onClose does, done now. Superseded makes the real close event (and
  // any late frame from this socket) a no-op.
  socket.superseded = true;
  clientIdToContext.delete(socket.clientId);
  beginDisconnectGrace(socket.clientId);
  try {
    ctx.close(4000, "No response");
  } catch {
    // Ignore close errors: the socket is already dead
  }
  return true;
};

/**
 * Why this socket cannot honestly be ponged, or null if it can.
 *
 * A pong is a claim, not an acknowledgement. ws-client.ts pings every 30s and
 * closes the connection when a pong does not come back, so the pong is the
 * client's ONLY evidence that it is still serving bots. Answering one for a
 * client we no longer have registered tells it a lie it cannot check: its bots
 * are gone from /api/bots, it believes it is attached, and nothing short of a
 * human restarting it ends the outage. Closing instead costs at most one ping
 * interval, because the client's existing reconnect path reattaches.
 *
 * BOTH registries have to agree, and this is the part that reading the close
 * handler does not give you. They live in different modules and are written by
 * different code paths: unregisterClient() drops the bot store's entry and
 * never touches clientIdToContext. So the mapping-identity test alone - the one
 * the close handler uses, which is the right test for "may I tear down?" -
 * answers TRUE for a client that has been deregistered out from under an open
 * socket, which is exactly the state this exists to catch. Measured: with only
 * that test in place, the zombie in bot-11-pong-honesty.test.ts still gets its
 * pong.
 *
 * A socket that has not attached has claimed nothing yet and is left alone; the
 * official client does not ping before attaching in any case, because
 * startPingLoop() runs from the attached handler.
 *
 * THE MAPPING ARM IS UNREACHABLE TODAY and is kept only as depth, which is
 * worth saying plainly rather than letting a reader assume it carries weight.
 * The one route to it is a newer attach taking the clientId, and that marks the
 * old socket superseded, whose frames are dropped before this function is
 * called, so its ping is answered with silence and it heals on the client's own
 * no-pong timeout instead. Measured in bot-11-pong-honesty.test.ts, which also
 * records that deleting this arm reddens nothing. It mirrors the close
 * handler's layered test for the same reason that one gives: identity still
 * holds if flag-marking ever fails.
 */
const unpongableReason = (ctx: WSContext, socket: BotSocket): string | null => {
  if (!socket.clientId) {
    return null;
  }
  if (!getClient(socket.clientId)) {
    return "this client is no longer registered";
  }
  if (!ownsClientIdMapping(ctx, socket.clientId)) {
    return "another connection now owns this client id";
  }
  return null;
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
  bot: unknown,
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

  // Validate clientId. No ":": every bot is addressed as "clientId:botId" and
  // the server reads the clientId back as the part before the first ":".
  if (
    typeof message.clientId !== "string" ||
    message.clientId.trim() === "" ||
    message.clientId.includes(":")
  ) {
    sendAttachRejected(
      ctx,
      "INVALID_MESSAGE",
      "`clientId` is required, must be non-empty and must not contain `:`.",
    );
    return false;
  }

  // Validate bots array
  if (!Array.isArray(message.bots) || message.bots.length === 0) {
    sendAttachRejected(ctx, "NO_BOTS", "At least one bot must be provided.");
    return false;
  }

  // Validate each bot config. An entry is untrusted JSON until the schema
  // accepts it: it can be null or not an object at all.
  for (const bot of message.bots as unknown[]) {
    const validation = validateBotConfig(bot);
    if (!validation.valid) {
      const botId =
        typeof bot === "object" &&
        bot !== null &&
        "botId" in bot &&
        typeof bot.botId === "string" &&
        bot.botId !== ""
          ? bot.botId
          : "(unknown)";
      sendAttachRejected(
        ctx,
        "INVALID_BOT_CONFIG",
        `Invalid bot config for "${botId}": ${validation.reason}`,
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
      if (!isOfficialToken(bot.officialToken)) {
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

  // An attach with an existing clientId takes over the client's registration
  // and its live games, so it must prove it is the same client. The tokens
  // were all checked above, so a bot that carries one carries the valid
  // official token.
  const carriesOfficialToken = message.bots.some(
    (bot) => bot.officialToken !== undefined,
  );
  if (carriesOfficialToken) {
    officialClientIds.add(message.clientId);
  } else if (officialClientIds.has(message.clientId)) {
    // An official client attaches with its token, every time, also after its
    // registration is gone.
    sendAttachRejected(
      ctx,
      "INVALID_OFFICIAL_TOKEN",
      "This clientId serves official bots; an attach needs the official token.",
    );
    return false;
  }
  if (existingClient) {
    if (!carriesOfficialToken && clientIdToContext.has(message.clientId)) {
      // Any other client has no credential, so it can only take over a
      // registration whose connection is already gone (the disconnect grace).
      sendAttachRejected(
        ctx,
        "CLIENT_ID_IN_USE",
        "This clientId is attached on another connection.",
      );
      return false;
    }
  }

  // Register or replace client
  let isReattach = false;
  if (existingClient) {
    isReattach = true;

    // This attach supersedes any pending grace teardown.
    const graceCancelled = cancelDisconnectGrace(message.clientId);

    // Force-disconnect the old connection if one is still live, and mark its
    // socket superseded so its close event cannot tear down this attach.
    const oldCtx = clientIdToContext.get(message.clientId);
    if (oldCtx) {
      const oldSocket = getSocketForContext(oldCtx);
      if (oldSocket) {
        oldSocket.superseded = true;
      }
      console.info("[custom-bot-ws] force-disconnecting old client", {
        clientId: message.clientId,
      });
      try {
        oldCtx.close(1000, "Replaced by new connection");
      } catch {
        // Ignore close errors
      }
    }

    const { orphanedBotCompositeIds, orphanedGames } = replaceClient(
      message.clientId,
      message.bots,
      ctx.raw as never,
      OFFICIAL_BOT_TOKEN,
    );

    // Bots the new attach no longer declares: end their BGS, reject their
    // resolvers, and resign their games — they must not outlive their bot.
    for (const compositeId of orphanedBotCompositeIds) {
      endBgsAndRejectResolvers(compositeId);
    }
    if (orphanedGames.length > 0) {
      console.info("[custom-bot-ws] resigning games of dropped bots", {
        clientId: message.clientId,
        gameCount: orphanedGames.length,
      });
      void resignBotGames(orphanedGames).catch((error: unknown) => {
        console.error("[custom-bot-ws] error resigning orphaned games", {
          error,
          clientId: message.clientId,
        });
      });
    }

    if (graceCancelled) {
      console.info("[custom-bot-ws] reattached within disconnect grace", {
        clientId: message.clientId,
      });
    }
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

  // Reattach: rebuild every carried game's BGS on the new connection. The
  // full rebuild (resync) is idempotent against whatever the client process
  // kept or lost, and plays the bot's turn if one is due.
  if (isReattach) {
    const carriedGames = getActiveGamesForClient(message.clientId);
    for (const { compositeId, game } of carriedGames) {
      let session: GameSession;
      try {
        session = getSession(game.gameId);
      } catch {
        continue; // game gone from the store
      }
      if (session.gameState.status !== "playing") continue;
      console.info("[custom-bot-ws] resyncing game after reattach", {
        clientId: message.clientId,
        gameId: game.gameId,
        compositeId,
      });
      void resyncBgsFromHistory(game.gameId, compositeId, "reattach").catch(
        (error: unknown) => {
          console.error("[custom-bot-ws] resync after reattach failed", {
            error,
            gameId: game.gameId,
            compositeId,
          });
        },
      );
    }
  }

  return true;
};

// ============================================================================
// V3 BGS Message Handlers
// ============================================================================

/**
 * Whether this socket's client serves the BGS. An exact match on the clientId
 * part of the bot's composite id ("clientId:botId"), never a prefix, so one
 * client cannot answer for another.
 */
const isBgsOfSocket = (bgs: BotGameSession, socket: BotSocket): boolean =>
  socket.clientId !== null &&
  bgs.botCompositeId.split(":")[0] === socket.clientId;

/**
 * Handle game_session_started response from bot.
 */
const handleGameSessionStarted = (
  socket: BotSocket,
  message: GameSessionStartedMessage,
): void => {
  const { bgsId, success, error } = message;
  let requestMs: number | undefined;

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
  if (!isBgsOfSocket(bgs, socket)) {
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
    // Verify this response matches the expected type — a mismatch means
    // the resolver was overwritten (e.g., endBgsSession sent while start was pending)
    if (resolver.expectedResponseType !== "game_session_started") {
      console.info("[custom-bot-ws] discarding stale game_session_started", {
        bgsId,
        resolverExpects: resolver.expectedResponseType,
      });
      // Don't consume the resolver — the correct response will arrive later
      return;
    }

    clearTimeout(resolver.timeoutId);
    pendingResolvers.delete(bgsId);
    requestMs = elapsedSince(clearPendingRequest(bgsId));

    if (success) {
      markBgsReady(bgsId);
      resolver.resolve({ success: true });
    } else {
      resolver.reject(
        new BgsStartFailure("engine-refused", error || "Session start failed"),
      );
    }
  } else {
    // Late response after timeout - silently discard
    console.debug("[custom-bot-ws] late game_session_started response", {
      bgsId,
    });
  }

  logBotReply("game_session_started", { bgsId, success, error, requestMs });
};

/**
 * Handle game_session_ended response from bot.
 */
const handleGameSessionEnded = (
  socket: BotSocket,
  message: GameSessionEndedMessage,
): void => {
  const { bgsId, success, error } = message;
  let requestMs: number | undefined;

  // The BGS lives until its end is confirmed, so while a resolver waits for
  // this reply the BGS is there to say whose it is.
  const bgs = getBgs(bgsId);
  if (bgs && !isBgsOfSocket(bgs, socket)) {
    console.warn("[custom-bot-ws] game_session_ended from wrong client", {
      bgsId,
      expectedBot: bgs.botCompositeId,
      clientId: socket.clientId,
    });
    incrementUnexpectedMessage(socket);
    return;
  }

  // Resolve the pending request (if any)
  const resolver = pendingResolvers.get(bgsId);
  if (resolver) {
    // Verify this response matches the expected type
    if (resolver.expectedResponseType !== "game_session_ended") {
      console.info("[custom-bot-ws] discarding stale game_session_ended", {
        bgsId,
        resolverExpects: resolver.expectedResponseType,
      });
      return;
    }

    clearTimeout(resolver.timeoutId);
    pendingResolvers.delete(bgsId);
    requestMs = elapsedSince(clearPendingRequest(bgsId));

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

  logBotReply("game_session_ended", { bgsId, success, error, requestMs });
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
  let requestMs: number | undefined;
  let refusedExpectedPly: number | undefined;

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
  if (!isBgsOfSocket(bgs, socket)) {
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
    // Verify this response matches the expected type
    if (resolver.expectedResponseType !== "evaluate_response") {
      console.info("[custom-bot-ws] discarding stale evaluate_response", {
        bgsId,
        resolverExpects: resolver.expectedResponseType,
      });
      return;
    }

    clearTimeout(resolver.timeoutId);
    pendingResolvers.delete(bgsId);
    const pending = clearPendingRequest(bgsId);
    requestMs = elapsedSince(pending);

    if (success && pending && pending.expectedPly !== ply) {
      // The bot evaluated another position than the one asked about. Its best
      // move would be played on the wrong board, so the reply is refused like
      // a failed one and kept out of the history.
      refusedExpectedPly = pending.expectedPly;
      resolver.reject(
        new Error(`Ply mismatch: expected ${pending.expectedPly}, got ${ply}`),
      );
    } else if (success) {
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

  logBotReply("evaluate_response", {
    bgsId,
    ply,
    evaluation,
    bestMove,
    success,
    error,
    requestMs,
    refused: refusedExpectedPly === undefined ? undefined : "ply mismatch",
    expectedPly: refusedExpectedPly,
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
  let requestMs: number | undefined;

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
  if (!isBgsOfSocket(bgs, socket)) {
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
    // Verify this response matches the expected type
    if (resolver.expectedResponseType !== "move_applied") {
      console.info("[custom-bot-ws] discarding stale move_applied", {
        bgsId,
        resolverExpects: resolver.expectedResponseType,
      });
      return;
    }

    clearTimeout(resolver.timeoutId);
    pendingResolvers.delete(bgsId);
    requestMs = elapsedSince(clearPendingRequest(bgsId));

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

  logBotReply("move_applied", { bgsId, ply, success, error, requestMs });
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
 * Why a session start failed, as a value rather than a message.
 *
 * Six ways to fail used to arrive as six English strings, and the caller that
 * forfeits a bot over them recorded ONE cause for all of them. Board task
 * e6c86b8b measured the result: seven production forfeits whose failing branch
 * is known and whose actual reason is unrecoverable, because Fly keeps no
 * historical logs. Matching on message text would be the same mistake one layer
 * up, so the reason is carried as data.
 *
 * `duplicate-id` and `at-capacity` are split deliberately even though one call
 * produces both: they mean opposite things. A duplicate id is self-inflicted -
 * the caller's own end step left the session behind - and retrying it is futile.
 * At capacity is load, and retrying may work. That distinction is exactly what
 * the follow-up fix is gated on.
 */
export type BgsStartFailureReason =
  | "client-not-found"
  | "no-connection"
  | "duplicate-id"
  | "at-capacity"
  | "timeout"
  | "engine-refused"
  | "client-disconnected";

export class BgsStartFailure extends Error {
  constructor(
    readonly reason: BgsStartFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "BgsStartFailure";
  }
}

/** The reason of a BgsStartFailure, or "unknown" for anything else. */
export const startFailureReason = (
  error: unknown,
): BgsStartFailureReason | "unknown" =>
  error instanceof BgsStartFailure ? error.reason : "unknown";

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
    throw new BgsStartFailure(
      "client-not-found",
      `Bot client not found: ${compositeId}`,
    );
  }

  const [clientId, botId] = compositeId.split(":");
  const ctx = clientIdToContext.get(clientId);
  if (!ctx) {
    throw new BgsStartFailure(
      "no-connection",
      `No connection for client: ${clientId}`,
    );
  }

  // Create BGS. Ask which of the two failures it was BEFORE calling, because
  // createBgs returns the same null for both and the answer stops existing the
  // moment it succeeds.
  const idAlreadyTaken = getBgs(bgsId) !== undefined;
  const bgs = createBgs(bgsId, compositeId, gameId, config);
  if (!bgs) {
    throw idAlreadyTaken
      ? new BgsStartFailure(
          "duplicate-id",
          `Failed to create BGS - duplicate ID: ${bgsId}`,
        )
      : new BgsStartFailure(
          "at-capacity",
          "Failed to create BGS - at capacity",
        );
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

      // TELL THE ENGINE BEFORE FORGETTING, or nothing ever will.
      //
      // The request that timed out here can still complete on the engine, which
      // then holds a session the server has stopped tracking. Deep Wallwars caps
      // at 256 sessions per process and refuses every new game after that.
      //
      // This handler must send explicitly because endBgs below removes the
      // record that every later ORDINARY cleanup path uses to DISCOVER the
      // remote session: notifyBotGameEnded (this file) looks it up with
      // getBgs(gameId), so once endBgs has run, the game ending later finds
      // nothing and sends nothing.
      //
      // Note what that does and does not say. It is not that nothing else
      // COULD send - the ctx captured here is still perfectly able to, after
      // the delete or at any later time. What is lost is discovery: no code
      // that starts from the store can find the session to send for it.
      //
      // The placement before endBgs preserves the natural cleanup order and
      // supports a future store-aware routing helper, but the direct send()
      // does not depend on that order today - it takes the socket context and
      // never reads the store, so these two lines could be swapped with no
      // change in behaviour.
      //
      // Sent directly rather than through endBgsSession(), for two reasons:
      // that function awaits a confirmation, which would put a second wait on a
      // path that is already a timeout, and it early-returns when getBgs is
      // undefined - so after the delete it is a no-op anyway.
      //
      // Best-effort by construction: send() catches its own socket errors, so
      // nothing can throw out of this callback, and no reply is awaited. A
      // client that never created the session answers game_session_ended with
      // success false, which handleGameSessionEnded already tolerates.
      //
      // This does NOT make a bgsId safe to REUSE. Proving that a later start
      // cannot collide with this session needs attempt identity, which the
      // protocol cannot carry today (game_session_started has no request id) -
      // see board 38f836ca, where the retry that needs it is designed. Nothing
      // retries a start today, which is why the archive to 2026-08-16 shows
      // zero of these across 7,378 games.
      send(ctx, { type: "end_game_session", bgsId });

      endBgs(bgsId);
      removeClientBgsSession(clientId, bgsId);
      console.info("[custom-bot-ws] start timed out; asked engine to end BGS", {
        bgsId,
        clientId,
      });
      reject(new BgsStartFailure("timeout", "start_game_session timeout"));
    }, BGS_REQUEST_TIMEOUT_MS);

    // NOT wrapped to relabel whatever arrives. A first draft mapped every
    // rejection here to "engine-refused", which would have branded a client
    // DISCONNECT (endBgsAndRejectResolvers) as the engine refusing the session -
    // inventing a diagnosis in the very code meant to stop guessing at one.
    // Each real failure site constructs its own reason instead.
    pendingResolvers.set(bgsId, {
      resolve: resolve as (result: unknown) => void,
      reject,
      timeoutId,
      expectedResponseType: "game_session_started",
      drain: false,
    });

    // Track pending request in BGS
    setPendingRequest(bgsId, {
      type: "start_game_session",
      bgsId,
      expectedPly: 0,
      createdAt: Date.now(),
      resolve: (success: boolean, error?: string) => {
        if (!success) {
          reject(
            new BgsStartFailure(
              "engine-refused",
              error ?? "Session start failed",
            ),
          );
        }
      },
    });
  });
};

/**
 * Cancel the request in flight for a BGS, if there is one. Its caller gets a
 * rejection at once (e.g., executeBotTurnV3 sees it and checks getResetPromise
 * for a graceful return), and a drain resolver with the same response type
 * takes its slot, so the bot's natural reply is consumed rather than read as
 * the answer to a later request. Returns a promise that settles when that
 * reply arrives (or at the request timeout), or null if nothing was in flight.
 */
const cancelInFlightRequest = (bgsId: string): Promise<void> | null => {
  const existingResolver = pendingResolvers.get(bgsId);
  if (!existingResolver) return null;

  clearTimeout(existingResolver.timeoutId);
  existingResolver.reject(new Error("Request cancelled - session ending"));

  return new Promise<void>((drainResolve) => {
    const drainResolver: BgsRequestResolver<unknown> = {
      resolve: () => {
        clearTimeout(drainResolver.timeoutId);
        drainResolve();
      },
      reject: () => {
        clearTimeout(drainResolver.timeoutId);
        drainResolve(); // Drain completes even on error response
      },
      timeoutId: setTimeout(() => {
        // Only our own slot. A drain that outlives its use must not take a
        // later request's resolver with it.
        if (pendingResolvers.get(bgsId) === drainResolver) {
          pendingResolvers.delete(bgsId);
          clearPendingRequest(bgsId);
        }
        drainResolve();
      }, BGS_REQUEST_TIMEOUT_MS),
      expectedResponseType: existingResolver.expectedResponseType,
      drain: true,
    };
    pendingResolvers.set(bgsId, drainResolver);
  });
};

/**
 * Cancel the bot's search for this BGS (an evaluation, or the move applied
 * just before one), so a rebuild that has been superseded stops waiting for
 * it and sends nothing more. Session start and end are left to finish: they involve no
 * search, and cancelling them would orphan the session record they create or
 * delete. The drain is not awaited: the next endBgsSession takes it over.
 */
export const cancelBgsSearch = (bgsId: string): void => {
  const resolver = pendingResolvers.get(bgsId);
  if (!resolver || resolver.drain) return;
  const type = resolver.expectedResponseType;
  if (type !== "evaluate_response" && type !== "move_applied") return;
  void cancelInFlightRequest(bgsId);
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

  // If there's an in-flight request, wait for the bot's natural response before
  // sending end_game_session. The bot client enforces one-request-at-a-time:
  // sending end_game_session while another request is pending is a protocol violation.
  const drainedType = pendingResolvers.get(bgsId)?.expectedResponseType;
  const drain = cancelInFlightRequest(bgsId);
  if (drain) {
    await drain;
    console.info(
      "[custom-bot-ws] drained in-flight request before ending BGS",
      { bgsId, drainedType },
    );
  }

  // Now safe to send end_game_session — no in-flight request at the bot
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
      expectedResponseType: "game_session_ended",
      drain: false,
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

  // Fail loudly if there's already an in-flight request for this BGS.
  // This enforces the protocol invariant at the server level rather than
  // silently overwriting the resolver (which would cause the bot client
  // to reject with "Already have pending request").
  if (pendingResolvers.has(bgsId)) {
    throw new Error(
      `BGS ${bgsId} already has an in-flight request (trying to send evaluate_position)`,
    );
  }

  // Send evaluate_position message
  const framesAtSend = getSocketForContext(ctx)?.inboundFrames ?? 0;
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
      const silent = disconnectIfSilent(
        ctx,
        framesAtSend,
        "evaluate_position",
        bgsId,
      );
      reject(
        new Error(
          silent
            ? "evaluate_position timeout on a silent connection"
            : "evaluate_position timeout",
        ),
      );
    }, BGS_REQUEST_TIMEOUT_MS);

    pendingResolvers.set(bgsId, {
      resolve: resolve as (result: unknown) => void,
      reject,
      timeoutId,
      expectedResponseType: "evaluate_response",
      drain: false,
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

  // Fail loudly if there's already an in-flight request for this BGS.
  if (pendingResolvers.has(bgsId)) {
    throw new Error(
      `BGS ${bgsId} already has an in-flight request (trying to send apply_move)`,
    );
  }

  // Send apply_move message
  const framesAtSend = getSocketForContext(ctx)?.inboundFrames ?? 0;
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
      const silent = disconnectIfSilent(ctx, framesAtSend, "apply_move", bgsId);
      reject(
        new Error(
          silent
            ? "apply_move timeout on a silent connection"
            : "apply_move timeout",
        ),
      );
    }, BGS_REQUEST_TIMEOUT_MS);

    pendingResolvers.set(bgsId, {
      resolve: resolve as (result: unknown) => void,
      reject,
      timeoutId,
      expectedResponseType: "move_applied",
      drain: false,
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
  // Handle keepalive ping before typed parse (ping is outside the typed protocol)
  if (typeof raw === "string" && raw === '{"type":"ping"}') {
    const unpongable = unpongableReason(ctx, socket);
    if (unpongable) {
      console.info("[custom-bot-ws] closing a socket we cannot honestly pong", {
        clientId: socket.clientId,
        reason: unpongable,
      });
      try {
        ctx.close(1011, unpongable);
      } catch {
        // Ignore close errors
      }
      return;
    }

    try {
      ctx.send('{"type":"pong"}');
    } catch {
      // Ignore send errors
    }
    return;
  }

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
// Disconnect Handling (grace period + generation-owned teardown)
// ============================================================================

/** Monotonic token establishing ownership of a pending grace teardown. */
let nextGraceGeneration = 0;

/** Pending grace-expiry teardowns by clientId. */
const pendingGrace = new Map<
  string,
  { generation: number; timeoutId: ReturnType<typeof setTimeout> }
>();

/**
 * End all BGS sessions for a bot, reject their pending resolvers, and prune
 * them from the client's session bookkeeping.
 */
const endBgsAndRejectResolvers = (compositeId: string): void => {
  const clientId = compositeId.split(":")[0];
  const endedSessions = endAllBgsForBot(compositeId);
  for (const session of endedSessions) {
    const resolver = pendingResolvers.get(session.bgsId);
    if (resolver) {
      clearTimeout(resolver.timeoutId);
      pendingResolvers.delete(session.bgsId);
      // Typed so a start waiting on this client records WHY. Harmless for the
      // other request types, which never read the reason.
      resolver.reject(
        new BgsStartFailure("client-disconnected", "Bot client disconnected"),
      );
    }
    removeClientBgsSession(clientId, session.bgsId);
  }
};

/**
 * Resign a set of bot games (client gone or bot no longer served).
 * Async finalization only — must be called with a snapshot taken while the
 * caller owned the state, never with a live lookup.
 */
/**
 * Forfeit a vanished client's games. Note what this does NOT do: it never
 * sends end_game_session, because the client it would go to is gone.
 *
 * That absence is the way to tell the two forfeit paths apart in a bot client
 * log, which matters because they mean opposite things - this one is expected
 * collateral from a restart, while resignBotOnFailure means something broke.
 * resignBotOnFailure calls notifyBotsGameEnded, so its games show a "Starting
 * game session" WITH a matching "Ending game session"; a game killed here
 * shows a start with no end. Both now also record bot_resign_cause on the
 * game, which is the durable version of the same distinction.
 */
const resignBotGames = async (
  games: { compositeId: string; game: ActiveBotGame }[],
): Promise<void> => {
  for (const { compositeId, game } of games) {
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
          cause: "bot-forfeit",
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
            // Recorded so this is separable from an engine failure in the
            // data. Restarting the bot client forfeits every game in flight,
            // which is expected collateral, and it used to be indistinguishable
            // from a game the engine actually broke.
            await persistCompletedGame(session, "client-disconnect");
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
};

/**
 * Grace-expiry teardown. The claim phase is fully synchronous: verify and
 * DELETE the pendingGrace entry, verify store ownership via the generation,
 * snapshot the games, end BGS + reject resolvers, unregister. Only then does
 * the async finalization (resigning games from the snapshot) run — so a
 * reattach that lands after the claim finds no client and registers fresh,
 * and a stale timer whose generation was superseded does nothing at all.
 */
const finalizeDisconnectedClient = (
  clientId: string,
  generation: number,
): void => {
  const entry = pendingGrace.get(clientId);
  if (entry?.generation !== generation) {
    return; // superseded by a reattach (or a newer disconnect)
  }
  pendingGrace.delete(clientId);

  const client = getClient(clientId);
  if (client?.graceGeneration !== generation) {
    return; // client reattached (or was replaced) since this timer was set
  }

  const activeGames = getActiveGamesForClient(clientId);
  for (const [botId] of client.bots) {
    endBgsAndRejectResolvers(`${clientId}:${botId}`);
  }
  unregisterClient(clientId);

  console.info("[custom-bot-ws] disconnect grace expired — client torn down", {
    clientId,
    generation,
    gameCount: activeGames.length,
  });

  void resignBotGames(activeGames).catch((error: unknown) => {
    console.error("[custom-bot-ws] error resigning games after grace expiry", {
      error,
      clientId,
    });
  });
};

/**
 * Start the disconnect grace period for a client whose current websocket
 * just closed.
 */
const beginDisconnectGrace = (clientId: string): void => {
  const generation = ++nextGraceGeneration;
  if (!markClientDisconnected(clientId, generation)) {
    return; // client not registered (already torn down)
  }

  const previous = pendingGrace.get(clientId);
  if (previous) {
    clearTimeout(previous.timeoutId);
  }

  const timeoutId = setTimeout(() => {
    finalizeDisconnectedClient(clientId, generation);
  }, BOT_DISCONNECT_GRACE_MS);
  (timeoutId as { unref?: () => void }).unref?.();
  pendingGrace.set(clientId, { generation, timeoutId });

  console.info("[custom-bot-ws] disconnect grace started", {
    clientId,
    generation,
    graceMs: BOT_DISCONNECT_GRACE_MS,
  });
};

/**
 * Cancel a pending grace teardown (the client reattached in time).
 */
const cancelDisconnectGrace = (clientId: string): boolean => {
  const entry = pendingGrace.get(clientId);
  if (!entry) return false;
  clearTimeout(entry.timeoutId);
  pendingGrace.delete(clientId);
  return true;
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
            superseded: false,
            inboundFrames: 0,
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

          // A superseded connection may still have frames in flight. They
          // must not be processed: pendingResolvers are keyed by bgsId, so a
          // late response from the old connection could resolve a request
          // that belongs to the new connection's resync.
          if (socket.superseded) {
            console.info(
              "[custom-bot-ws] ignoring message from superseded connection",
              { clientId: socket.clientId },
            );
            return;
          }

          socket.inboundFrames += 1;
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
            superseded: socket.superseded,
          });

          // Per-connection map cleanup is always safe.
          contextToSocket.delete(ws);
          if (ws.raw && typeof ws.raw === "object") {
            rawSocketMap.delete(ws.raw);
          }

          // Teardown is connection-scoped: only the connection that still
          // OWNS the clientId mapping may delete it and start grace. The
          // superseded flag is the explanatory fast path (set when a newer
          // attach replaced this socket); the mapping-identity check protects
          // the new connection even if flag-marking ever failed. Identity is
          // compared on the context and on its raw socket (the raw object is
          // stable per connection; context object identity may not be).
          if (!socket.clientId || socket.superseded) {
            return;
          }
          const currentCtx = clientIdToContext.get(socket.clientId);
          const ownsMapping =
            !!currentCtx &&
            (currentCtx === ws ||
              (!!currentCtx.raw &&
                typeof currentCtx.raw === "object" &&
                currentCtx.raw === ws.raw));
          if (!ownsMapping) {
            console.info(
              "[custom-bot-ws] close from non-current connection — no teardown",
              { clientId: socket.clientId },
            );
            return;
          }

          clientIdToContext.delete(socket.clientId);
          beginDisconnectGrace(socket.clientId);
        },
      };
    }),
  );

  return websocket;
};
