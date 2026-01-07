/**
 * Proactive Bot Protocol (v2)
 *
 * Bot clients connect proactively to the server without needing a per-game token.
 * Upon connection, the client registers one or more bots with their supported
 * game configurations. Connected bots are listed in the UI for users to play against.
 *
 * This protocol follows a strict REQUEST -> RESPONSE model:
 * - The server sends requests when it needs a decision from the bot
 * - The client is idle unless there is an outstanding request
 * - Each request represents a single decision window
 * - Only one request is valid at a time per client; new requests invalidate prior ones
 */

import type {
  SerializedGameState,
  PlayerId,
  Variant,
  TimeControlPreset,
} from "../domain/game-types";

// ============================================================================
// Protocol Version
// ============================================================================

export const CUSTOM_BOT_PROTOCOL_VERSION = 2;

// ============================================================================
// Bot Configuration Types
// ============================================================================

/** Range of supported board dimensions */
export interface BoardDimensionRange {
  min: number;
  max: number;
}

/** Recommended settings for a variant (shown in UI "Recommended" tab) */
export interface RecommendedSettings {
  boardWidth: number;
  boardHeight: number;
}

/** Configuration for a specific variant */
export interface VariantConfig {
  timeControls: TimeControlPreset[];
  boardWidth: BoardDimensionRange;
  boardHeight: BoardDimensionRange;
  /** 1-3 recommended settings for this variant. Empty for variants without variant-specific settings. */
  recommended: RecommendedSettings[];
}

/** Visual appearance of a bot */
export interface BotAppearance {
  color?: string;
  catStyle?: string;
  mouseStyle?: string;
  homeStyle?: string;
}

/** Configuration for a single bot */
export interface BotConfig {
  /** Unique identifier for this bot within the client */
  botId: string;
  /** Display name shown to users */
  name: string;
  /** If set, identifies this as an official bot. Omit for non-official bots. */
  officialToken?: string;
  /** If set, this bot is only visible to this user (case-insensitive). Null for public bots. */
  username: string | null;
  /** Visual appearance preferences */
  appearance?: BotAppearance;
  /** Supported variants and their configurations */
  variants: Partial<Record<Variant, VariantConfig>>;
}

// ============================================================================
// Shared Types
// ============================================================================

export interface CustomBotServerLimits {
  maxMessageBytes: number;
  minClientMessageIntervalMs: number;
}

export interface CustomBotClientInfo {
  name: string;
  version: string;
}

// ============================================================================
// Request Kinds
// ============================================================================

/**
 * Request kinds determine what actions are valid in the response.
 *
 * - "move": Bot must make a move or resign. It's the bot's turn.
 * - "draw": Opponent offered a draw. Bot must accept or decline.
 */
export type BotRequestKind = "move" | "draw";

// ============================================================================
// Client -> Server Messages
// ============================================================================

export interface AttachMessage {
  type: "attach";
  protocolVersion: number;
  /** Client-chosen identifier. If another client connects with the same ID, this connection is force-closed. */
  clientId: string;
  /** Array of bots served by this client. Cannot be empty. */
  bots: BotConfig[];
  /** Client identification for logging/debugging */
  client: CustomBotClientInfo;
}

/**
 * Response to a server request.
 * The valid actions depend on the request kind:
 * - "move" request: action must be "move" or "resign"
 * - "draw" request: action must be "accept-draw" or "decline-draw"
 */
export type BotResponseAction =
  | {
      action: "move";
      moveNotation: string;
      /**
       * Position evaluation from the bot's perspective.
       * Range: [-1, +1] where +1 = winning, 0 = even, -1 = losing.
       */
      evaluation: number;
    }
  | { action: "resign" }
  | { action: "accept-draw" }
  | { action: "decline-draw" };

export interface BotResponseMessage {
  type: "response";
  requestId: string;
  response: BotResponseAction;
}

export type CustomBotClientMessage = AttachMessage | BotResponseMessage;

// ============================================================================
// Server -> Client Messages
// ============================================================================

export interface AttachedMessage {
  type: "attached";
  protocolVersion: number;
  serverTime: number;
  server: { name: string; version: string };
  limits: CustomBotServerLimits;
}

export type AttachRejectedCode =
  | "NO_BOTS"
  | "INVALID_BOT_CONFIG"
  | "INVALID_OFFICIAL_TOKEN"
  | "DUPLICATE_BOT_ID"
  | "TOO_MANY_CLIENTS"
  | "PROTOCOL_UNSUPPORTED"
  | "INVALID_MESSAGE"
  | "INTERNAL_ERROR";

export interface AttachRejectedMessage {
  type: "attach-rejected";
  code: AttachRejectedCode;
  message: string;
}

/** Base fields for all request messages */
interface RequestMessageBase {
  type: "request";
  requestId: string;
  /** Which bot this request is for (matches botId from attachment) */
  botId: string;
  /** The game this request is for */
  gameId: string;
  serverTime: number;
  /** The PlayerId the bot is playing as in this game (1 or 2) */
  playerId: PlayerId;
  /** Opponent's display name (for logging) */
  opponentName: string;
  /** Current game state - always included */
  state: SerializedGameState;
}

/** Request for the bot to make a move */
export interface MoveRequestMessage extends RequestMessageBase {
  kind: "move";
}

/** Request for the bot to respond to a draw offer */
export interface DrawRequestMessage extends RequestMessageBase {
  kind: "draw";
  /** Who offered the draw */
  offeredBy: PlayerId;
}

export type RequestMessage = MoveRequestMessage | DrawRequestMessage;

export type NackCode =
  | "NOT_ATTACHED"
  | "INVALID_MESSAGE"
  | "RATE_LIMITED"
  | "STALE_REQUEST"
  | "ILLEGAL_MOVE"
  | "INVALID_ACTION"
  | "INTERNAL_ERROR";

export interface AckMessage {
  type: "ack";
  requestId: string;
  serverTime: number;
}

export interface NackMessage {
  type: "nack";
  requestId: string;
  code: NackCode;
  message: string;
  /** If true, the same request is still active and can be retried */
  retryable: boolean;
  serverTime: number;
}

export type CustomBotServerMessage =
  | AttachedMessage
  | AttachRejectedMessage
  | RequestMessage
  | AckMessage
  | NackMessage;

// ============================================================================
// Default limits
// ============================================================================

export const DEFAULT_BOT_LIMITS: CustomBotServerLimits = {
  maxMessageBytes: 65536, // 64 KiB
  minClientMessageIntervalMs: 200, // 1 message per 200ms
};

// ============================================================================
// Bot Listing Types (for API responses)
// ============================================================================

/** Bot info as returned by the listing API */
export interface ListedBot {
  /** Composite ID: clientId:botId */
  id: string;
  clientId: string;
  botId: string;
  name: string;
  isOfficial: boolean;
  appearance: BotAppearance;
  variants: Partial<Record<Variant, VariantConfig>>;
}

/** A recommended bot entry (bot + specific settings) */
export interface RecommendedBotEntry {
  bot: ListedBot;
  boardWidth: number;
  boardHeight: number;
}
