/**
 * WebSocket Client for Custom Bot Protocol
 *
 * Handles the WebSocket connection to the Wall Game server
 * and implements the custom bot protocol.
 */

import type {
  AttachMessage,
  AttachedMessage,
  AttachRejectedMessage,
  RequestMessage,
  RematchStartedMessage,
  AckMessage,
  NackMessage,
  BotResponseMessage,
  CustomBotServerMessage,
  CustomBotSeatIdentity,
  CustomBotServerLimits,
} from "../../shared/contracts/custom-bot-protocol";
import {
  CUSTOM_BOT_PROTOCOL_VERSION,
  DEFAULT_BOT_LIMITS,
} from "../../shared/contracts/custom-bot-protocol";
import type { Variant, PlayerId } from "../../shared/domain/game-types";
import { logger } from "./logger";
import type { EngineRequest, EngineResponse } from "./engine-api";
import { createMoveRequest, createDrawRequest } from "./engine-api";
import { handleDumbBotRequest } from "./dumb-bot";
import {
  runEngine,
  calculateEngineTimeout,
  type EngineRunnerOptions,
} from "./engine-runner";

export interface BotClientOptions {
  serverUrl: string;
  seatToken: string;
  engineCommand?: string;
  supportedVariants?: Variant[];
  maxBoardWidth?: number;
  maxBoardHeight?: number;
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
  seatToken: string;
  engineCommand: string | undefined;
  supportedVariants: Variant[];
  maxBoardWidth: number;
  maxBoardHeight: number;
  clientName: string;
  clientVersion: string;
}

export class BotClient {
  private ws: WebSocket | null = null;
  private state: ClientState = "connecting";
  private options: ResolvedBotClientOptions;

  // Current session info
  private matchId: string | null = null;
  private gameId: string | null = null;
  private seat: CustomBotSeatIdentity | null = null;
  private limits: CustomBotServerLimits = DEFAULT_BOT_LIMITS;

  // Active request tracking
  private activeRequestId: string | null = null;
  private lastRequest: RequestMessage | null = null;
  private nackRetryCount: number = 0;
  private static readonly MAX_NACK_RETRIES = 1;

  // Rate limiting
  private lastSendTime: number = 0;

  // Connection promise callbacks (for resolving on attached/rejected)
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;

  constructor(options: BotClientOptions) {
    this.options = {
      serverUrl: options.serverUrl,
      seatToken: options.seatToken,
      engineCommand: options.engineCommand,
      supportedVariants: options.supportedVariants ?? [
        "standard",
        "classic",
        "freestyle",
      ],
      maxBoardWidth: options.maxBoardWidth ?? 20,
      maxBoardHeight: options.maxBoardHeight ?? 20,
      clientName: options.clientName ?? "wallgame-bot-client",
      clientVersion: options.clientVersion ?? "1.0.0",
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
        this.state = "disconnected";
        if (wasConnecting && this.connectReject) {
          this.connectReject(new Error("WebSocket closed during connection"));
          this.connectResolve = null;
          this.connectReject = null;
        }
      };
    });
  }

  /**
   * Run the bot until disconnection
   */
  async run(): Promise<void> {
    await this.connect();

    // Keep running until disconnected
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.state === "disconnected") {
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
      seatToken: this.options.seatToken,
      supportedGame: {
        variants: this.options.supportedVariants,
        maxBoardWidth: this.options.maxBoardWidth,
        maxBoardHeight: this.options.maxBoardHeight,
      },
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
      case "rematch-started":
        this.handleRematchStarted(message);
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
    logger.info("Successfully attached to game");
    logger.info(`  Match: ${message.match.matchId}`);
    logger.info(`  Game: ${message.match.gameId}`);
    logger.info(
      `  Seat: ${message.match.seat.role} (player ${message.match.seat.playerId})`,
    );
    logger.info(`  Server: ${message.server.name} v${message.server.version}`);

    this.state = "waiting";
    this.matchId = message.match.matchId;
    this.gameId = message.match.gameId;
    this.seat = message.match.seat;
    this.limits = message.limits;

    logger.debug("Limits:", message.limits);
    logger.debug("Initial state:", message.state);

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
    logger.info(`Received ${message.kind} request (${message.requestId})`);

    // Update active request ID (newer requests invalidate older ones)
    this.activeRequestId = message.requestId;
    this.lastRequest = message;
    this.nackRetryCount = 0;
    this.state = "processing";

    await this.processRequest(message);
  }

  /**
   * Process a request (used by both handleRequest and NACK retry)
   */
  private async processRequest(message: RequestMessage): Promise<void> {
    // Build engine request
    let engineRequest: EngineRequest;
    if (message.kind === "move") {
      engineRequest = createMoveRequest(
        message.requestId,
        this.matchId!,
        this.gameId!,
        message.serverTime,
        this.seat!,
        message.state,
        message.snapshot,
      );
    } else if (message.kind === "draw") {
      engineRequest = createDrawRequest(
        message.requestId,
        this.matchId!,
        this.gameId!,
        message.serverTime,
        this.seat!,
        message.offeredBy!,
        message.state,
        message.snapshot,
      );
    } else if (message.kind === "rematch") {
      // Auto-accept rematches per spec
      logger.info("Auto-accepting rematch offer");
      this.sendResponse(message.requestId, { action: "accept-rematch" });
      return;
    } else {
      logger.warn("Unknown request kind:", message.kind);
      return;
    }

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
    if (!this.options.engineCommand) {
      // Use dumb bot
      logger.debug("Using built-in dumb bot");
      return handleDumbBotRequest(request);
    }

    // Calculate timeout based on remaining time
    // Note: JSON keys are strings, so we need to access with string key
    const myPlayerId = this.seat!.playerId;
    const timeLeftMs =
      serverMessage.state.timeLeft[String(myPlayerId) as `${PlayerId}`];
    const timeoutMs = calculateEngineTimeout(timeLeftMs);

    const engineOptions: EngineRunnerOptions = {
      engineCommand: this.options.engineCommand,
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
      | { action: "decline-draw" }
      | { action: "accept-rematch" }
      | { action: "decline-rematch" },
  ): void {
    const message: BotResponseMessage = {
      type: "response",
      requestId,
      response,
    };

    this.send(message);
    this.state = "waiting";
  }

  /**
   * Handle rematch started notification
   */
  private handleRematchStarted(message: RematchStartedMessage): void {
    logger.info("Rematch started!");
    logger.info(`  New game: ${message.newGameId}`);
    logger.info(
      `  Seat: ${message.seat.role} (player ${message.seat.playerId})`,
    );

    this.gameId = message.newGameId;
    this.seat = message.seat;
    this.state = "waiting";
  }

  /**
   * Handle acknowledgment of a response
   */
  private handleAck(message: AckMessage): void {
    logger.debug(`Response ${message.requestId} acknowledged`);
  }

  /**
   * Handle rejection of a response
   */
  private async handleNack(message: NackMessage): Promise<void> {
    logger.warn(
      `Response ${message.requestId} rejected: ${message.code} - ${message.message}`,
    );

    if (!message.retryable) {
      logger.error("Non-retryable error, response rejected permanently");
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
      this.sendResponse(message.requestId, { action: "resign" });
    }
  }

  /**
   * Close the connection
   */
  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.state = "disconnected";
  }
}
