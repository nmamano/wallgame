/**
 * WebSocket Client for Custom Bot Protocol V2
 *
 * Handles the WebSocket connection to the Wall Game server
 * and implements the proactive bot protocol.
 */

import type {
  AttachMessage,
  AttachedMessage,
  AttachRejectedMessage,
  RequestMessage,
  AckMessage,
  NackMessage,
  BotResponseMessage,
  CustomBotServerMessage,
  BotConfig,
} from "../../shared/contracts/custom-bot-protocol";
import {
  CUSTOM_BOT_PROTOCOL_VERSION,
  DEFAULT_BOT_LIMITS,
  type CustomBotServerLimits,
} from "../../shared/contracts/custom-bot-protocol";
import type { PlayerId } from "../../shared/domain/game-types";
import { logger } from "./logger";
import type {
  EngineRequest,
  EngineResponse,
} from "../../shared/custom-bot/engine-api";
import { createMoveRequest } from "../../shared/custom-bot/engine-api";
import { handleDumbBotRequest } from "./dumb-bot";
import {
  runEngine,
  calculateEngineTimeout,
  type EngineRunnerOptions,
} from "./engine-runner";

export interface BotClientOptions {
  serverUrl: string;
  clientId: string;
  bots: BotConfig[];
  engineCommands: Map<string, string | undefined>;
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
  engineCommands: Map<string, string | undefined>;
  clientName: string;
  clientVersion: string;
}

// Reconnection configuration
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 60000;
const RECONNECT_JITTER_MAX_MS = 2000;

export class BotClient {
  private ws: WebSocket | null = null;
  private state: ClientState = "connecting";
  private options: ResolvedBotClientOptions;

  // Server limits
  private limits: CustomBotServerLimits = DEFAULT_BOT_LIMITS;

  // Active request tracking
  private activeRequestId: string | null = null;
  private lastRequest: RequestMessage | null = null;
  private lastRequestById = new Map<string, RequestMessage>();
  private lastResponseById = new Map<string, BotResponseMessage["response"]>();
  private nackRetryCount: number = 0;
  private static readonly MAX_NACK_RETRIES = 1;

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
      clientVersion: options.clientVersion ?? "2.0.0",
    };
  }

  /**
   * Connect to the server and start the bot client.
   * Resolves when attached, rejects on attach-rejected or connection failure.
   */
  async connect(): Promise<void> {
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
          // Attempt reconnection
          this.scheduleReconnect();
        }
      };
    });
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
        await this.connect();
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
  private async send(
    message: AttachMessage | BotResponseMessage,
  ): Promise<void> {
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
      case "request":
        this.handleRequest(message);
        break;
      case "ack":
        this.handleAck(message);
        break;
      case "nack":
        this.handleNack(message);
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
      logger.info(`  Bot: ${bot.botId} (${bot.name})`);
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

  /**
   * Handle a decision request from the server
   */
  private async handleRequest(message: RequestMessage): Promise<void> {
    logger.info(
      `Received ${message.kind} request for bot ${message.botId} (${message.requestId})`,
    );

    // V2: Draw requests are auto-declined by client
    if (message.kind === "draw") {
      logger.info("Auto-declining draw offer");
      this.sendResponse(message.requestId, { action: "decline-draw" });
      return;
    }

    // Update active request ID (newer requests invalidate older ones)
    this.activeRequestId = message.requestId;
    this.lastRequest = message;
    this.lastRequestById.set(message.requestId, message);
    this.nackRetryCount = 0;
    this.state = "processing";

    await this.processRequest(message);
  }

  /**
   * Process a request (used by both handleRequest and NACK retry)
   */
  private async processRequest(message: RequestMessage): Promise<void> {
    if (message.kind !== "move") {
      logger.warn("Unknown request kind:", message.kind);
      return;
    }

    // Build engine request
    const engineRequest = createMoveRequest(
      message.requestId,
      message.botId,
      message.gameId,
      message.serverTime,
      message.playerId,
      message.state,
    );

    // Get response from engine (or dumb bot)
    const response = await this.getEngineResponse(engineRequest, message);

    // Check if request is still active (not invalidated by a newer request)
    if (this.activeRequestId !== message.requestId) {
      logger.debug(
        `Request ${message.requestId} was invalidated, discarding response`,
      );
      return;
    }

    if (response) {
      this.sendResponse(message.requestId, response.response);
    } else {
      // Engine failed - resign
      logger.error("Engine failed, resigning");
      this.sendResponse(message.requestId, { action: "resign" });
    }
  }

  /**
   * Get response from engine or dumb bot
   */
  private async getEngineResponse(
    request: EngineRequest,
    serverMessage: RequestMessage,
  ): Promise<EngineResponse | null> {
    const engineCommand = this.options.engineCommands.get(serverMessage.botId);

    if (!engineCommand) {
      // Use dumb bot
      logger.debug("Using built-in dumb bot");
      return handleDumbBotRequest(request);
    }

    // Calculate timeout based on remaining time
    const myPlayerId = serverMessage.playerId;
    const timeLeftRaw =
      serverMessage.state.timeLeft[String(myPlayerId) as `${PlayerId}`];
    // Server timeLeft is in seconds; normalize to ms for engine timeouts.
    const initialSeconds =
      serverMessage.state.config.timeControl.initialSeconds ?? 0;
    const timeLeftMs =
      initialSeconds > 0 && timeLeftRaw <= initialSeconds * 100
        ? timeLeftRaw * 1000
        : timeLeftRaw;
    const timeoutMs = calculateEngineTimeout(timeLeftMs);

    const engineOptions: EngineRunnerOptions = {
      engineCommand,
      timeoutMs,
    };

    const result = await runEngine(engineOptions, request);

    if (result.success && result.response) {
      return result.response;
    }

    // First attempt failed - retry once for retryable errors
    logger.warn(`Engine failed: ${result.error}, retrying once...`);

    const retryResult = await runEngine(engineOptions, request);

    if (retryResult.success && retryResult.response) {
      return retryResult.response;
    }

    logger.error(`Engine retry failed: ${retryResult.error}`);
    return null;
  }

  /**
   * Send a response to the server
   */
  private sendResponse(
    requestId: string,
    response:
      | { action: "move"; moveNotation: string }
      | { action: "resign" }
      | { action: "accept-draw" }
      | { action: "decline-draw" },
  ): void {
    const message: BotResponseMessage = {
      type: "response",
      requestId,
      response,
    };

    this.lastResponseById.set(requestId, response);
    this.send(message);
    this.state = "waiting";
  }

  /**
   * Handle acknowledgment of a response
   */
  private handleAck(message: AckMessage): void {
    logger.debug(`Response ${message.requestId} acknowledged`);
    this.lastRequestById.delete(message.requestId);
    this.lastResponseById.delete(message.requestId);
  }

  /**
   * Handle rejection of a response
   */
  private async handleNack(message: NackMessage): Promise<void> {
    logger.warn(
      `Response ${message.requestId} rejected: ${message.code} - ${message.message}`,
    );
    this.logNackContext(message);

    if (!message.retryable) {
      logger.error("Non-retryable error, response rejected permanently");
      this.lastRequestById.delete(message.requestId);
      this.lastResponseById.delete(message.requestId);
      return;
    }

    // Check if this is for the current active request and we have retries left
    if (
      message.requestId === this.activeRequestId &&
      this.lastRequest &&
      this.nackRetryCount < BotClient.MAX_NACK_RETRIES
    ) {
      this.nackRetryCount++;
      logger.info(
        `Retryable NACK - retrying (attempt ${this.nackRetryCount}/${BotClient.MAX_NACK_RETRIES})`,
      );

      // Re-run the engine with the same request (don't reset nackRetryCount)
      await this.processRequest(this.lastRequest);
    } else if (this.nackRetryCount >= BotClient.MAX_NACK_RETRIES) {
      logger.error("Max NACK retries exceeded, resigning");
      this.lastRequestById.delete(message.requestId);
      this.lastResponseById.delete(message.requestId);
      this.sendResponse(message.requestId, { action: "resign" });
    }
  }

  private logNackContext(message: NackMessage): void {
    if (message.code !== "ILLEGAL_MOVE") {
      return;
    }

    const request =
      this.lastRequestById.get(message.requestId) ?? this.lastRequest ?? null;
    const response = this.lastResponseById.get(message.requestId) ?? null;

    logger.error("Illegal move context:", {
      requestId: message.requestId,
      serverMessage: message.message,
      retryable: message.retryable,
      response,
      request: request
        ? {
            kind: request.kind,
            botId: request.botId,
            playerId: request.playerId,
            state: request.state,
          }
        : null,
    });
  }

  /**
   * Close the connection and stop reconnecting
   */
  close(): void {
    this.shouldReconnect = false;
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
