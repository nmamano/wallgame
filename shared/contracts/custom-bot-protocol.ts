/**
 * Custom Bot Server <-> Client Protocol
 *
 * This protocol follows a strict REQUEST → RESPONSE model:
 * - The server sends requests when it needs a decision from the bot
 * - The client is idle unless there is an outstanding request
 * - Each request represents a single decision window
 * - Only one request is valid at a time; new requests invalidate prior ones
 */

import type {
  SerializedGameState,
  GameSnapshot,
  PlayerId,
  Variant,
} from "../domain/game-types";

// ============================================================================
// Protocol Version
// ============================================================================

export const CUSTOM_BOT_PROTOCOL_VERSION = 1;

// ============================================================================
// Shared Types
// ============================================================================

export interface CustomBotSeatIdentity {
  role: "host" | "joiner";
  playerId: PlayerId;
}

export interface CustomBotServerLimits {
  maxMessageBytes: number;
  minClientMessageIntervalMs: number;
  maxInvalidMessages: number;
}

export interface CustomBotClientInfo {
  name: string;
  version: string;
}

export interface CustomBotSupportedGame {
  variants: Variant[];
  maxBoardWidth: number;
  maxBoardHeight: number;
}

// ============================================================================
// Request Kinds
// ============================================================================

/**
 * Request kinds determine what actions are valid in the response.
 *
 * - "move": Bot must make a move or resign. It's the bot's turn.
 * - "draw": Opponent offered a draw. Bot can accept or decline.
 * - "rematch": Game is over. Opponent offered a rematch. Bot can accept or decline.
 */
export type BotRequestKind = "move" | "draw" | "rematch";

// ============================================================================
// Client -> Server Messages
// ============================================================================

export interface AttachMessage {
  type: "attach";
  protocolVersion: number;
  seatToken: string;
  supportedGame: CustomBotSupportedGame;
  client?: CustomBotClientInfo;
}

/**
 * Response to a server request.
 * The valid actions depend on the request kind:
 * - "move" request: action must be "move" or "resign"
 * - "draw" request: action must be "accept-draw" or "decline-draw"
 * - "rematch" request: action must be "accept-rematch" or "decline-rematch"
 */
export type BotResponseAction =
  | { action: "move"; moveNotation: string }
  | { action: "resign" }
  | { action: "accept-draw" }
  | { action: "decline-draw" }
  | { action: "accept-rematch" }
  | { action: "decline-rematch" };

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
  match: {
    matchId: string;
    gameId: string;
    seat: CustomBotSeatIdentity;
  };
  limits: CustomBotServerLimits;
}

export type AttachRejectedCode =
  | "INVALID_TOKEN"
  | "TOKEN_ALREADY_USED"
  | "SEAT_NOT_CUSTOM_BOT"
  | "SEAT_ALREADY_CONNECTED"
  | "UNSUPPORTED_GAME_CONFIG"
  | "PROTOCOL_UNSUPPORTED"
  | "INTERNAL_ERROR";

export interface AttachRejectedMessage {
  type: "attach-rejected";
  code: AttachRejectedCode;
  message: string;
}

/**
 * Server request for a decision from the bot.
 * The bot must respond with a matching action type.
 */
export interface RequestMessage {
  type: "request";
  requestId: string;
  serverTime: number;
  kind: BotRequestKind;
  /** Current game state - always included */
  state: SerializedGameState;
  /** Match metadata */
  snapshot: GameSnapshot;
  /** For draw requests: who offered the draw */
  offeredBy?: PlayerId;
}

/**
 * Sent when a rematch game starts.
 * After this, the bot should wait for a new request if it's their turn.
 */
export interface RematchStartedMessage {
  type: "rematch-started";
  serverTime: number;
  matchId: string;
  newGameId: string;
  seat: CustomBotSeatIdentity;
  /** Initial state of the new game */
  state: SerializedGameState;
  snapshot: GameSnapshot;
}

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
  | RematchStartedMessage
  | AckMessage
  | NackMessage;

// ============================================================================
// Default limits
// ============================================================================

export const DEFAULT_BOT_LIMITS: CustomBotServerLimits = {
  maxMessageBytes: 65536, // 64 KiB
  minClientMessageIntervalMs: 200, // 1 message per 200ms
  maxInvalidMessages: 10,
};
