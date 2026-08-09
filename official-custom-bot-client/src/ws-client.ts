/**
 * WebSocket Client for Custom Bot Protocol V3
 *
 * Handles the WebSocket connection to the Wall Game server
 * and implements the proactive bot protocol with Bot Game Sessions (BGS).
 *
 * V3 Key Changes:
 * - Engine process is started once at startup (long-lived)
 * - Server sends BGS messages (start_game_session, evaluate_position, apply_move, end_game_session)
 * - Client passes messages through to engine and returns responses
 */

import type {
  AttachMessage,
  AttachedMessage,
  AttachRejectedMessage,
  CustomBotServerMessage,
  BotConfig,
  StartGameSessionMessage,
  EndGameSessionMessage,
  EvaluatePositionMessage,
  ApplyMoveMessage,
  GameSessionStartedMessage,
  GameSessionEndedMessage,
  EvaluateResponseMessage,
  MoveAppliedMessage,
} from "../../shared/contracts/custom-bot-protocol";
import {
  CUSTOM_BOT_PROTOCOL_VERSION,
  DEFAULT_BOT_LIMITS,
  type CustomBotServerLimits,
} from "../../shared/contracts/custom-bot-protocol";
import { logger } from "./logger";
import { join } from "node:path";
import { clampEvaluation } from "../../shared/custom-bot/engine-api";
import type { EngineProcess } from "./engine-runner";
import { spawnEngine } from "./engine-runner";
import {
  handleStartGameSession as dumbBotStartSession,
  handleEndGameSession as dumbBotEndSession,
  handleEvaluatePosition as dumbBotEvaluate,
  handleApplyMove as dumbBotApplyMove,
} from "./dumb-bot";

export interface BotClientOptions {
  serverUrl: string;
  clientId: string;
  bots: BotConfig[];
  engineCommands: Map<string, string>;
  /**
   * Per-bot chance (0-1) that a move comes from the built-in naive policy
   * instead of the bot's engine. Bots absent from the map never do this.
   */
  naiveMoveRates?: Map<string, number>;
  clientName?: string;
  clientVersion?: string;
}

type ClientState =
  | "connecting"
  | "attached"
  | "waiting"
  | "processing"
  | "disconnected";

interface ResolvedBotClientOptions {
  serverUrl: string;
  clientId: string;
  bots: BotConfig[];
  engineCommands: Map<string, string>;
  naiveMoveRates: Map<string, number>;
  clientName: string;
  clientVersion: string;
}

// Reconnection configuration
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 300000; // 5 minutes
const RECONNECT_JITTER_MAX_MS = 2000;

// Keepalive ping interval
const PING_INTERVAL_MS = 30_000;

// Standard notation for a move that takes no actions. Valid on the wire — the
// server applies it as a pass — which is exactly why the naive policy must
// never be allowed to answer with it.
const PASS_NOTATION = "---";
// Heartbeat file the monitor (scripts/bot-monitor.sh) polls for liveness.
// Resolved from the repo root (this file lives at official-custom-bot-client/src/),
// env-overridable — never tied to a hardcoded home directory.
const HEARTBEAT_FILE =
  process.env.WALLGAME_HEARTBEAT_FILE ??
  join(import.meta.dir, "../../.wallgame-bot-heartbeat");

// V3 BGS client response type
type BgsClientResponse =
  | GameSessionStartedMessage
  | GameSessionEndedMessage
  | EvaluateResponseMessage
  | MoveAppliedMessage;

export class BotClient {
  private ws: WebSocket | null = null;
  private state: ClientState = "connecting";
  private options: ResolvedBotClientOptions;

  // Server limits
  private limits: CustomBotServerLimits = DEFAULT_BOT_LIMITS;

  // V3: Long-lived engine processes (one per bot)
  private engines = new Map<string, EngineProcess>();

  // V3: Session routing table (bgsId -> botId) for routing messages without botId
  private sessionRoutes = new Map<string, string>();

  // Sessions where an engine plays the game but a SHADOW dumb-bot session is
  // kept alongside it, so a fraction of moves can come from the naive policy
  // (see naiveMoveRates). A bgsId is in this set only while the shadow is known
  // to be in lockstep with the engine; the first sign of drift removes it and
  // the session finishes on pure engine moves.
  private shadowSessions = new Set<string>();

  // Reconnection state
  private reconnectAttempts = 0;
  private shouldReconnect = true;

  // Keepalive ping state
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongReceived = true;

  // Connection promise callbacks (for resolving on attached/rejected)
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private runResolve: (() => void) | null = null;

  constructor(options: BotClientOptions) {
    this.options = {
      serverUrl: options.serverUrl,
      clientId: options.clientId,
      bots: options.bots,
      engineCommands: options.engineCommands,
      naiveMoveRates: options.naiveMoveRates ?? new Map<string, number>(),
      clientName: options.clientName ?? "wallgame-bot-client",
      clientVersion: options.clientVersion ?? "3.0.0",
    };
  }

  /**
   * Connect to the server and start the bot client.
   * V3: Starts engine processes before connecting to WebSocket.
   * Resolves when attached, rejects on attach-rejected or connection failure.
   */
  async connect(): Promise<void> {
    // V3: Start engine processes first
    await this.startEngines();

    const wsUrl = this.deriveWebSocketUrl(this.options.serverUrl);
    logger.info(`Connecting to ${wsUrl}`);

    return new Promise((resolve, reject) => {
      // Store callbacks for resolution in handleAttached/handleAttachRejected
      this.connectResolve = resolve;
      this.connectReject = reject;

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        logger.info("WebSocket connected, sending attach...");
        this.sendAttach();
        // Don't resolve here - wait for attached message
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data as string);
      };

      this.ws.onerror = (event) => {
        logger.error("WebSocket error:", event);
        if (this.state === "connecting" && this.connectReject) {
          this.connectReject(new Error("WebSocket connection failed"));
          this.connectResolve = null;
          this.connectReject = null;
        }
      };

      this.ws.onclose = (event) => {
        this.stopPingLoop();
        logger.info("WebSocket closed:", event.code, event.reason);
        const wasConnecting = this.state === "connecting";
        const wasAttached =
          this.state === "attached" ||
          this.state === "waiting" ||
          this.state === "processing";
        this.state = "disconnected";
        this.discardSessionBookkeeping();

        if (wasConnecting && this.connectReject) {
          this.connectReject(new Error("WebSocket closed during connection"));
          this.connectResolve = null;
          this.connectReject = null;
        } else if (wasAttached && this.shouldReconnect) {
          // Attempt reconnection (engines stay running)
          this.scheduleReconnect();
        }
      };
    });
  }

  /**
   * V3: Start engine processes for each bot
   */
  private async startEngines(): Promise<void> {
    for (const bot of this.options.bots) {
      const engineCommand = this.options.engineCommands.get(bot.botId);
      if (!engineCommand) {
        logger.info(
          `Bot ${bot.botId}: No engine command, will use built-in dumb bot`,
        );
        continue;
      }

      try {
        logger.info(`Starting engine for bot ${bot.botId}: ${engineCommand}`);
        const engine = await spawnEngine(engineCommand);
        this.engines.set(bot.botId, engine);
        logger.info(`Engine started for bot ${bot.botId}`);
      } catch (error) {
        logger.error(`Failed to start engine for bot ${bot.botId}:`, error);
        // Continue without this engine - will use dumb bot fallback
      }
    }
  }

  /**
   * V3: Get engine for a bot (or undefined for dumb bot fallback)
   */
  private getEngine(botId: string): EngineProcess | undefined {
    return this.engines.get(botId);
  }

  /**
   * Schedule a reconnection attempt with exponential backoff + jitter
   */
  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    const baseDelay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_DELAY_MS,
    );
    const jitter = Math.random() * RECONNECT_JITTER_MAX_MS;
    const delay = baseDelay + jitter;

    this.reconnectAttempts++;
    logger.info(
      `Scheduling reconnect attempt ${this.reconnectAttempts} in ${Math.round(
        delay,
      )}ms`,
    );

    // Named rather than passed inline, because setTimeout expects a void
    // callback and an async arrow hands it a promise nothing can observe. The
    // body and its timing are unchanged; `void` states that the rejection is
    // handled internally, which the try/catch below does.
    const attemptReconnect = async () => {
      if (!this.shouldReconnect) return;

      try {
        // V3: Engines stay running, just reconnect WebSocket
        const wsUrl = this.deriveWebSocketUrl(this.options.serverUrl);
        logger.info(`Reconnecting to ${wsUrl}`);

        await new Promise<void>((resolve, reject) => {
          this.connectResolve = resolve;
          this.connectReject = reject;

          this.ws = new WebSocket(wsUrl);

          this.ws.onopen = () => {
            logger.info("WebSocket reconnected, sending attach...");
            this.sendAttach();
          };

          this.ws.onmessage = (event) => {
            this.handleMessage(event.data as string);
          };

          this.ws.onerror = (event) => {
            logger.error("WebSocket error:", event);
          };

          this.ws.onclose = (event) => {
            this.stopPingLoop();
            logger.info("WebSocket closed:", event.code, event.reason);
            this.state = "disconnected";
            // A reconnected socket carries games again once the server resyncs
            // them, so dropping a second time leaks exactly as the first would.
            this.discardSessionBookkeeping();

            if (this.shouldReconnect) {
              this.scheduleReconnect();
            } else {
              reject(new Error("WebSocket closed during reconnection"));
            }
          };
        });

        // Reset reconnect attempts on successful connection
        this.reconnectAttempts = 0;
      } catch (error) {
        logger.error("Reconnection failed:", error);
        // Schedule another attempt
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      }
    };
    setTimeout(() => void attemptReconnect(), delay);
  }

  /**
   * Run the bot until explicitly closed
   */
  async run(): Promise<void> {
    await this.connect();

    // Keep running until shouldReconnect is false
    return new Promise((resolve) => {
      this.runResolve = resolve;
      const checkInterval = setInterval(() => {
        if (this.state === "disconnected" && !this.shouldReconnect) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  }

  /**
   * Derive WebSocket URL from server URL
   */
  private deriveWebSocketUrl(serverUrl: string): string {
    const url = new URL(serverUrl);
    const protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${url.host}/ws/custom-bot`;
  }

  /**
   * Send the attach message to the server
   */
  private sendAttach(): void {
    const message: AttachMessage = {
      type: "attach",
      protocolVersion: CUSTOM_BOT_PROTOCOL_VERSION,
      clientId: this.options.clientId,
      bots: this.options.bots,
      client: {
        name: this.options.clientName,
        version: this.options.clientVersion,
      },
    };

    this.send(message);
    logger.debug("Sent attach message");
  }

  /**
   * Send a message to the server.
   * Note: Rate limiting was removed in V3 - server handles synchronization.
   */
  private send(message: AttachMessage | BgsClientResponse): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.error("Cannot send: WebSocket not connected");
      return;
    }

    const json = JSON.stringify(message);
    logger.debug("Sending:", json);
    this.ws.send(json);
  }

  /**
   * Handle incoming message from server
   */
  private handleMessage(data: string): void {
    logger.debug("Received:", data);

    // Handle keepalive pong before typed parse (pong is outside the typed protocol).
    // Exact string match — must stay in sync with server's JSON.stringify({type:"pong"}).
    if (data === '{"type":"pong"}') {
      this.pongReceived = true;
      logger.debug("Received pong");
      Bun.write(HEARTBEAT_FILE, "").catch((e) =>
        logger.warn("Heartbeat write failed:", e),
      );
      return;
    }

    let message: CustomBotServerMessage;
    try {
      // Unvalidated by design: the handlers below switch on message.type and
      // ignore anything they do not recognise. The assertion only names the
      // shape the code already assumes.
      message = JSON.parse(data) as CustomBotServerMessage;
    } catch (error) {
      logger.error("Failed to parse server message:", error);
      return;
    }

    switch (message.type) {
      case "attached":
        this.handleAttached(message);
        break;
      case "attach-rejected":
        this.handleAttachRejected(message);
        break;
      // V3 BGS messages
      case "start_game_session":
        void this.handleStartGameSession(message);
        break;
      case "end_game_session":
        void this.handleEndGameSession(message);
        break;
      case "evaluate_position":
        void this.handleEvaluatePosition(message);
        break;
      case "apply_move":
        void this.handleApplyMove(message);
        break;
      default:
        logger.warn(
          "Unknown message type:",
          (message as { type: string }).type,
        );
    }
  }

  /**
   * Handle successful attachment
   */
  private handleAttached(message: AttachedMessage): void {
    const botCount = this.options.bots.length;
    logger.info(`Successfully attached with ${botCount} bot(s)`);
    logger.info(`  Server: ${message.server.name} v${message.server.version}`);
    logger.info(`  Protocol: v${message.protocolVersion}`);

    for (const bot of this.options.bots) {
      const hasEngine = this.engines.has(bot.botId);
      logger.info(
        `  Bot: ${bot.botId} (${bot.name}) - Engine: ${hasEngine ? "external" : "dumb-bot"}`,
      );
    }

    this.state = "waiting";
    this.limits = message.limits;

    logger.debug("Limits:", message.limits);

    // Start keepalive ping loop
    this.startPingLoop();

    // Resolve the connect() promise
    if (this.connectResolve) {
      this.connectResolve();
      this.connectResolve = null;
      this.connectReject = null;
    }
  }

  /**
   * Handle attachment rejection
   */
  private handleAttachRejected(message: AttachRejectedMessage): void {
    logger.error(`Attachment rejected: ${message.code}`);
    logger.error(`  Message: ${message.message}`);

    // Don't reconnect on permanent failures
    if (
      message.code === "INVALID_OFFICIAL_TOKEN" ||
      message.code === "PROTOCOL_UNSUPPORTED" ||
      message.code === "INVALID_BOT_CONFIG" ||
      message.code === "NO_BOTS"
    ) {
      this.shouldReconnect = false;
    }

    this.state = "disconnected";

    // Reject the connect() promise
    if (this.connectReject) {
      this.connectReject(
        new Error(`Attachment rejected: ${message.code} - ${message.message}`),
      );
      this.connectResolve = null;
      this.connectReject = null;
    }

    this.ws?.close();
  }

  // ===========================================================================
  // V3 BGS Message Handlers
  //
  // Every handler below writes its reply with `await this.send(...)`, and
  // send() is synchronous (`private send(...): void`). So each of those awaits
  // is an await of a non-Promise, which is what await-thenable objects to.
  //
  // They are kept deliberately rather than removed. `await undefined` still
  // yields to the microtask queue, so dropping the keyword would move the
  // statement after each send - `this.state = "waiting"`, a `return`, a shadow
  // session update - from the next microtask into the same tick. That is a
  // scheduling change in a client that is live in production, and this is a
  // lint-coverage change, not the place to make it.
  //
  // Scoped to this section rather than the file so an await of a non-Promise
  // anywhere else in ws-client.ts is still reported.
  // ===========================================================================

  /* eslint-disable @typescript-eslint/await-thenable */

  /**
   * V3: Handle start_game_session - pass through to engine
   */
  private async handleStartGameSession(
    message: StartGameSessionMessage,
  ): Promise<void> {
    logger.info(
      `Starting game session ${message.bgsId} for bot ${message.botId}`,
    );
    this.state = "processing";

    // Record session route for subsequent messages (evaluate, apply_move, end)
    this.sessionRoutes.set(message.bgsId, message.botId);

    const engine = this.getEngine(message.botId);

    if (!engine) {
      // Dumb bot fallback - stateful session tracking
      logger.debug(`Using dumb bot for session ${message.bgsId}`);
      const response = dumbBotStartSession(message);
      await this.send(response);
      this.state = "waiting";
      return;
    }

    try {
      const response = await engine.send(message);
      // Validate response type
      if (response.type !== "game_session_started") {
        logger.error(`Unexpected response type: ${response.type}`);
        const errorResponse: GameSessionStartedMessage = {
          type: "game_session_started",
          bgsId: message.bgsId,
          success: false,
          error: `Unexpected response type: ${response.type}`,
        };
        await this.send(errorResponse);
      } else {
        const started = response;
        // Only ever alongside a live engine session: a session the engine
        // refused gets no end_game_session, so a shadow opened before this
        // point would sit in the dumb bot's session map for the life of the
        // process with nothing left to shadow.
        if (started.success) this.startShadowSession(message);
        await this.send(started);
      }
    } catch (error) {
      logger.error(`Engine error for start_game_session:`, error);
      const errorResponse: GameSessionStartedMessage = {
        type: "game_session_started",
        bgsId: message.bgsId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      await this.send(errorResponse);
    }

    this.state = "waiting";
  }

  /**
   * V3: Handle end_game_session - pass through to engine
   */
  private async handleEndGameSession(
    message: EndGameSessionMessage,
  ): Promise<void> {
    logger.info(`Ending game session ${message.bgsId}`);
    this.state = "processing";

    const botId = this.sessionRoutes.get(message.bgsId);
    const engine = botId ? this.getEngine(botId) : undefined;

    if (!engine) {
      // Dumb bot fallback (no engine-side session to leak)
      logger.debug(`Using dumb bot for end session ${message.bgsId}`);
      this.sessionRoutes.delete(message.bgsId);
      const response = dumbBotEndSession(message);
      await this.send(response);
      this.state = "waiting";
      return;
    }

    try {
      const response = await engine.send(message);
      await this.send(response as GameSessionEndedMessage);
    } catch (error) {
      logger.error(`Engine error for end_game_session:`, error);
      const errorResponse: GameSessionEndedMessage = {
        type: "game_session_ended",
        bgsId: message.bgsId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      await this.send(errorResponse);
    } finally {
      // Remove the route only AFTER the engine has been contacted, never before.
      // Deleting up-front (the old behavior) meant that if engine.send() threw,
      // a server retry would find no route, silently fall back to the dumb bot,
      // report success, and never tell the real engine to tear down — a silent
      // engine-side session leak.
      this.sessionRoutes.delete(message.bgsId);
      this.endShadowSession(message);
      this.state = "waiting";
    }
  }

  /**
   * V3: Handle evaluate_position - pass through to engine
   */
  private async handleEvaluatePosition(
    message: EvaluatePositionMessage,
  ): Promise<void> {
    logger.info(
      `Evaluating position for session ${message.bgsId} at ply ${message.expectedPly}`,
    );
    this.state = "processing";

    const botId = this.sessionRoutes.get(message.bgsId);
    const engine = botId ? this.getEngine(botId) : undefined;

    if (!engine) {
      // Dumb bot fallback
      logger.debug(`Using dumb bot for evaluation ${message.bgsId}`);
      const response = dumbBotEvaluate(message);
      await this.send(response);
      this.state = "waiting";
      return;
    }

    try {
      const response = await engine.send(message);
      // Clamp evaluation to valid range
      const evalResponse = response as EvaluateResponseMessage;
      // On a naive turn the ENGINE's evaluation is kept and only the move is
      // swapped. Playing the naive move but reporting the naive bot's crude
      // distance heuristic would make the eval jump around for reasons no
      // observer could explain, and it would also throw away the engine's
      // error handling above.
      const naiveMove = evalResponse.success
        ? this.rollNaiveMove(message, botId)
        : null;
      const normalizedResponse: EvaluateResponseMessage = {
        ...evalResponse,
        bestMove: naiveMove ?? evalResponse.bestMove,
        evaluation: clampEvaluation(evalResponse.evaluation),
      };
      await this.send(normalizedResponse);
    } catch (error) {
      logger.error(`Engine error for evaluate_position:`, error);
      const errorResponse: EvaluateResponseMessage = {
        type: "evaluate_response",
        bgsId: message.bgsId,
        ply: message.expectedPly,
        evaluation: 0,
        bestMove: "",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      await this.send(errorResponse);
    }

    this.state = "waiting";
  }

  /**
   * V3: Handle apply_move - pass through to engine
   */
  private async handleApplyMove(message: ApplyMoveMessage): Promise<void> {
    logger.info(
      `Applying move ${message.move} to session ${message.bgsId} at ply ${message.expectedPly}`,
    );
    this.state = "processing";

    const botId = this.sessionRoutes.get(message.bgsId);
    const engine = botId ? this.getEngine(botId) : undefined;

    if (!engine) {
      // Dumb bot fallback
      logger.debug(`Using dumb bot for apply_move ${message.bgsId}`);
      const response = dumbBotApplyMove(message);
      await this.send(response);
      this.state = "waiting";
      return;
    }

    try {
      const response = await engine.send(message);
      this.applyToShadowSession(message, response as MoveAppliedMessage);
      await this.send(response as MoveAppliedMessage);
    } catch (error) {
      logger.error(`Engine error for apply_move:`, error);
      const errorResponse: MoveAppliedMessage = {
        type: "move_applied",
        bgsId: message.bgsId,
        ply: message.expectedPly,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      await this.send(errorResponse);
    }

    this.state = "waiting";
  }

  /* eslint-enable @typescript-eslint/await-thenable */

  // ===========================================================================
  // Shadow naive sessions
  //
  // A bot with a naiveMoveRate plays its engine's move most of the time and the
  // built-in naive move the rest of the time. The naive bot is STATEFUL — it
  // needs the board, the pawns and the ply — so it cannot be consulted for the
  // first time on the move it is asked to play. It therefore shadows the whole
  // game: start_game_session and apply_move go to BOTH, and only
  // evaluate_position picks one.
  //
  // The engine stays the authority. Every wire response is the engine's; the
  // shadow's replies are read for agreement and then discarded.
  // ===========================================================================

  /**
   * Open a shadow session next to an engine session, if this bot mixes in naive
   * moves. A shadow that fails to open is not an error for the game — the
   * session just plays out on pure engine moves.
   */
  private startShadowSession(message: StartGameSessionMessage): void {
    const rate = this.options.naiveMoveRates.get(message.botId) ?? 0;
    if (rate <= 0) return;

    const response = dumbBotStartSession(message);
    if (!response.success) {
      logger.warn(
        `Naive shadow session ${message.bgsId} failed to start, engine moves only:`,
        response.error,
      );
      return;
    }

    this.shadowSessions.add(message.bgsId);
    logger.info(
      `Naive shadow session open for ${message.bgsId} (rate ${rate}, bot ${message.botId})`,
    );
  }

  /**
   * Replay a move into the shadow session so it stays on the same position as
   * the engine. Drift is the one failure that would matter — a naive move
   * computed from a stale board is a move the server would reject — so the
   * shadow's ply is compared against the engine's and any disagreement retires
   * the shadow for the rest of the game.
   */
  private applyToShadowSession(
    message: ApplyMoveMessage,
    engineResponse: MoveAppliedMessage,
  ): void {
    if (!this.shadowSessions.has(message.bgsId)) return;

    // A move the ENGINE refused must not advance the shadow, or the two end up
    // a ply apart with nothing left to detect it — the engine's ply is the only
    // thing the shadow is ever checked against.
    if (!engineResponse.success) {
      this.retireShadowSession(
        message.bgsId,
        `engine rejected ${message.move}: ${engineResponse.error}`,
      );
      return;
    }

    const shadowResponse = dumbBotApplyMove(message);
    if (!shadowResponse.success) {
      this.retireShadowSession(
        message.bgsId,
        `could not apply ${message.move}: ${shadowResponse.error}`,
      );
      return;
    }
    if (shadowResponse.ply !== engineResponse.ply) {
      this.retireShadowSession(
        message.bgsId,
        `ply drift — engine at ${engineResponse.ply}, shadow at ${shadowResponse.ply}`,
      );
    }
  }

  private endShadowSession(message: EndGameSessionMessage): void {
    if (!this.shadowSessions.delete(message.bgsId)) return;
    dumbBotEndSession(message);
  }

  private retireShadowSession(bgsId: string, reason: string): void {
    this.shadowSessions.delete(bgsId);
    dumbBotEndSession({ type: "end_game_session", bgsId });
    logger.warn(
      `Naive shadow session ${bgsId} retired, engine moves only for the rest of the game: ${reason}`,
    );
  }

  /**
   * Drop the client-side session bookkeeping when the socket goes down.
   *
   * The server cannot deliver end_game_session while we are disconnected, so a
   * game that FINISHES during the outage leaves its shadow in the naive bot's
   * session map, and its route in sessionRoutes, for the life of the process.
   * Both are bounded per affected game and clear on restart, so this is a slow
   * leak rather than a correctness bug — but nothing else ever collects them.
   *
   * Clearing here is safe because a reattach rebuilds every game that is still
   * playing: the server calls resyncBgsFromHistory, which sends a fresh
   * start_game_session and replays the history, repopulating both maps. If the
   * disconnect grace expires instead, the server resigns those games, so there
   * is nothing left to route. Either way the surviving entries are exactly the
   * ones that would have leaked.
   *
   * Engine sessions are deliberately left alone: engines keep running across a
   * reconnect, and the resync ends and restarts their sessions itself.
   */
  private discardSessionBookkeeping(): void {
    const shadows = this.shadowSessions.size;
    const routes = this.sessionRoutes.size;
    if (shadows === 0 && routes === 0) return;

    // Every bgsId we know about, from both directions. A bot WITH an engine
    // keeps its naive shadow in shadowSessions; a bot with NO engine is served
    // by the naive bot directly, so its primary session sits in the same map
    // under a plain route. Both leak identically, so both get ended here.
    // Ending an id the naive bot never knew about is a no-op.
    for (const bgsId of new Set([
      ...this.shadowSessions,
      ...this.sessionRoutes.keys(),
    ])) {
      dumbBotEndSession({ type: "end_game_session", bgsId });
    }
    this.shadowSessions.clear();
    this.sessionRoutes.clear();

    logger.info(
      `Disconnected: dropped ${routes} session route(s) and ${shadows} naive shadow(s); a reattach rebuilds whichever games are still playing`,
    );
  }

  /**
   * Decide this move: null means "play the engine's move".
   *
   * Every reason to decline is checked here rather than at the call site, so
   * the naive path can only ever REPLACE a move the engine already produced —
   * it can never be the reason a turn has no move at all. In particular the
   * naive policy answers "---" (no actions) when it is stuck, and the server
   * would apply that as a wasted turn.
   */
  private rollNaiveMove(
    message: EvaluatePositionMessage,
    botId: string | undefined,
  ): string | null {
    if (!botId || !this.shadowSessions.has(message.bgsId)) return null;

    const rate = this.options.naiveMoveRates.get(botId) ?? 0;
    if (Math.random() >= rate) return null;

    const response = dumbBotEvaluate(message);
    if (!response.success) {
      this.retireShadowSession(
        message.bgsId,
        `evaluation failed at ply ${message.expectedPly}: ${response.error}`,
      );
      return null;
    }
    if (!response.bestMove || response.bestMove === PASS_NOTATION) {
      logger.warn(
        `Naive policy had no move at ply ${message.expectedPly}, using the engine's move`,
      );
      return null;
    }

    logger.info(
      `Playing naive move ${response.bestMove} at ply ${message.expectedPly} (session ${message.bgsId})`,
    );
    return response.bestMove;
  }

  /**
   * Start the keepalive ping loop.
   * Sends {"type":"ping"} every PING_INTERVAL_MS. If no pong was received
   * since the last ping, the connection is considered dead and closed
   * to trigger reconnect.
   */
  private startPingLoop(): void {
    this.stopPingLoop();
    this.pongReceived = true;

    this.pingInterval = setInterval(() => {
      if (!this.pongReceived) {
        logger.warn("No pong received — closing dead connection");
        this.ws?.close();
        return;
      }

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: "ping" }));
          this.pongReceived = false;
          logger.debug("Sent ping");
        } catch (error) {
          logger.error("Failed to send ping:", error);
          this.ws?.close();
        }
      }
    }, PING_INTERVAL_MS);
  }

  /**
   * Stop the keepalive ping loop.
   */
  private stopPingLoop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Close the connection and stop reconnecting
   */
  close(): void {
    this.shouldReconnect = false;
    this.stopPingLoop();

    // V3: Kill all engine processes
    for (const [botId, engine] of this.engines) {
      logger.info(`Killing engine for bot ${botId}`);
      engine.kill();
    }
    this.engines.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.state = "disconnected";
    if (this.runResolve) {
      this.runResolve();
      this.runResolve = null;
    }
  }
}
