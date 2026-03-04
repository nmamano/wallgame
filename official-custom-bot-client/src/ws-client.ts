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
  clientName: string;
  clientVersion: string;
}

// Reconnection configuration
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 300000; // 5 minutes
const RECONNECT_JITTER_MAX_MS = 2000;

// Keepalive ping interval
const PING_INTERVAL_MS = 30_000;
const HEARTBEAT_FILE = "/tmp/wallgame-bot-heartbeat";

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
  private engines: Map<string, EngineProcess> = new Map();

  // V3: Session routing table (bgsId -> botId) for routing messages without botId
  private sessionRoutes: Map<string, string> = new Map();

  // Reconnection state
  private reconnectAttempts: number = 0;
  private shouldReconnect: boolean = true;

  // Keepalive ping state
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongReceived: boolean = true;

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

    setTimeout(async () => {
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
    }, delay);
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
      message = JSON.parse(data);
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
  // ===========================================================================

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
        await this.send(response as GameSessionStartedMessage);
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

    // Clean up session route
    this.sessionRoutes.delete(message.bgsId);

    if (!engine) {
      // Dumb bot fallback
      logger.debug(`Using dumb bot for end session ${message.bgsId}`);
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
    }

    this.state = "waiting";
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
      const normalizedResponse: EvaluateResponseMessage = {
        ...evalResponse,
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
