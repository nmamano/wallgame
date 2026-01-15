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

export interface BotClientOptions {
  serverUrl: string;
  clientId: string;
  bots: BotConfig[];
  engineCommands: Map<string, EngineCommandConfig>;
  clientName?: string;
  clientVersion?: string;
}

export type EngineCommandConfig = Record<string, string>;

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
  engineCommands: Map<string, EngineCommandConfig>;
  clientName: string;
  clientVersion: string;
}

// Reconnection configuration
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 60000;
const RECONNECT_JITTER_MAX_MS = 2000;

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

  // Rate limiting
  private lastSendTime: number = 0;

  // Reconnection state
  private reconnectAttempts: number = 0;
  private shouldReconnect: boolean = true;

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
      const engineCommandConfig = this.options.engineCommands.get(bot.botId);
      if (!engineCommandConfig) {
        logger.info(`Bot ${bot.botId}: No engine command, will use built-in dumb bot`);
        continue;
      }

      // V3: Use the default engine command for all variants
      // The engine handles multiple variants internally
      const engineCommand = engineCommandConfig.default;
      if (!engineCommand) {
        logger.warn(`Bot ${bot.botId}: No default engine command, will use built-in dumb bot`);
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
            if (this.state === "connecting" && this.connectReject) {
              this.connectReject(new Error("WebSocket connection failed"));
              this.connectResolve = null;
              this.connectReject = null;
            }
          };

          this.ws.onclose = (event) => {
            logger.info("WebSocket closed:", event.code, event.reason);
            const wasConnecting = this.state === "connecting";
            const wasAttached =
              this.state === "attached" ||
              this.state === "waiting" ||
              this.state === "processing";
            this.state = "disconnected";

            if (wasConnecting && this.connectReject) {
              this.connectReject(new Error("WebSocket closed during reconnection"));
              this.connectResolve = null;
              this.connectReject = null;
            } else if (wasAttached && this.shouldReconnect) {
              this.scheduleReconnect();
            }
          };
        });

        // Reset reconnect attempts on successful connection
        this.reconnectAttempts = 0;
      } catch (error) {
        logger.error("Reconnection failed:", error);
        // Will schedule another reconnect via onclose handler
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
   * Send a message to the server with rate limiting
   */
  private async send(message: AttachMessage | BgsClientResponse): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.error("Cannot send: WebSocket not connected");
      return;
    }

    // Rate limit: wait if we're sending too fast
    const now = Date.now();
    const timeSinceLastSend = now - this.lastSendTime;
    const minInterval = this.limits.minClientMessageIntervalMs;

    if (timeSinceLastSend < minInterval) {
      const waitTime = minInterval - timeSinceLastSend;
      logger.debug(`Rate limiting: waiting ${waitTime}ms before send`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    const json = JSON.stringify(message);
    logger.debug("Sending:", json);
    this.ws.send(json);
    this.lastSendTime = Date.now();
  }

  /**
   * Handle incoming message from server
   */
  private handleMessage(data: string): void {
    logger.debug("Received:", data);

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
      logger.info(`  Bot: ${bot.botId} (${bot.name}) - Engine: ${hasEngine ? "external" : "dumb-bot"}`);
    }

    this.state = "waiting";
    this.limits = message.limits;

    logger.debug("Limits:", message.limits);

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
  private async handleStartGameSession(message: StartGameSessionMessage): Promise<void> {
    logger.info(`Starting game session ${message.bgsId} for bot ${message.botId}`);
    this.state = "processing";

    // Extract botId from bgsId if not directly provided
    // Server may send composite bgsId like "gameId" but botId indicates which bot
    const engine = this.getEngine(message.botId);

    if (!engine) {
      // Dumb bot fallback - always succeeds
      logger.debug(`Using dumb bot for session ${message.bgsId}`);
      const response: GameSessionStartedMessage = {
        type: "game_session_started",
        bgsId: message.bgsId,
        success: true,
        error: "",
      };
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
  private async handleEndGameSession(message: EndGameSessionMessage): Promise<void> {
    logger.info(`Ending game session ${message.bgsId}`);
    this.state = "processing";

    // Find which bot owns this session by checking all engines
    // In V3, bgsId typically equals gameId, so we need to track which bot has the session
    // For simplicity, we'll try all engines and use the one that responds
    // TODO: Track bgsId -> botId mapping for efficiency

    // Try to find an engine that has this session
    let responded = false;
    for (const [botId, engine] of this.engines) {
      try {
        const response = await engine.send(message);
        if (response.type === "game_session_ended") {
          await this.send(response as GameSessionEndedMessage);
          responded = true;
          break;
        }
      } catch {
        // Engine doesn't have this session, try next
        continue;
      }
    }

    if (!responded) {
      // Dumb bot fallback or session not found - just confirm
      logger.debug(`Session ${message.bgsId} ended (dumb bot or not found)`);
      const response: GameSessionEndedMessage = {
        type: "game_session_ended",
        bgsId: message.bgsId,
        success: true,
        error: "",
      };
      await this.send(response);
    }

    this.state = "waiting";
  }

  /**
   * V3: Handle evaluate_position - pass through to engine
   */
  private async handleEvaluatePosition(message: EvaluatePositionMessage): Promise<void> {
    logger.info(`Evaluating position for session ${message.bgsId} at ply ${message.expectedPly}`);
    this.state = "processing";

    // Track bgsId -> botId mapping for this session
    // For now, try all engines
    let responded = false;
    for (const [botId, engine] of this.engines) {
      try {
        const response = await engine.send(message);
        if (response.type === "evaluate_response") {
          // Clamp evaluation to valid range
          const evalResponse = response as EvaluateResponseMessage;
          const normalizedResponse: EvaluateResponseMessage = {
            ...evalResponse,
            evaluation: clampEvaluation(evalResponse.evaluation),
          };
          await this.send(normalizedResponse);
          responded = true;
          break;
        }
      } catch {
        // Engine doesn't have this session, try next
        continue;
      }
    }

    if (!responded) {
      // Dumb bot fallback
      logger.debug(`Using dumb bot for evaluation ${message.bgsId}`);
      const response: EvaluateResponseMessage = {
        type: "evaluate_response",
        bgsId: message.bgsId,
        ply: message.expectedPly,
        bestMove: "", // Dumb bot doesn't track state, can't provide move
        evaluation: 0, // Neutral evaluation
        success: false,
        error: "No engine available for this session",
      };
      await this.send(response);
    }

    this.state = "waiting";
  }

  /**
   * V3: Handle apply_move - pass through to engine
   */
  private async handleApplyMove(message: ApplyMoveMessage): Promise<void> {
    logger.info(`Applying move ${message.move} to session ${message.bgsId} at ply ${message.expectedPly}`);
    this.state = "processing";

    // Try all engines
    let responded = false;
    for (const [botId, engine] of this.engines) {
      try {
        const response = await engine.send(message);
        if (response.type === "move_applied") {
          await this.send(response as MoveAppliedMessage);
          responded = true;
          break;
        }
      } catch {
        // Engine doesn't have this session, try next
        continue;
      }
    }

    if (!responded) {
      // Dumb bot fallback
      logger.debug(`Dumb bot: move ${message.move} applied to session ${message.bgsId}`);
      const response: MoveAppliedMessage = {
        type: "move_applied",
        bgsId: message.bgsId,
        ply: message.expectedPly + 1,
        success: true,
        error: "",
      };
      await this.send(response);
    }

    this.state = "waiting";
  }

  /**
   * Close the connection and stop reconnecting
   */
  close(): void {
    this.shouldReconnect = false;

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
