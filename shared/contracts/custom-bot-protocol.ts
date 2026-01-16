/**
 * Bot Game Session Protocol (v3)
 *
 * Bot clients connect proactively to the server without needing a per-game token.
 * Upon connection, the client registers one or more bots with their supported
 * game configurations. Connected bots are listed in the UI for users to play against.
 *
 * Key change from V2: Instead of stateless per-move requests, V3 uses stateful
 * Bot Game Sessions (BGS) with persistent engine processes. The engine maintains
 * game state and MCTS trees across moves within a session.
 *
 * V3 Protocol Flow:
 * 1. Client connects and sends "attach" with bot configurations
 * 2. Server creates BGS when game starts: "start_game_session"
 * 3. Server requests evaluations: "evaluate_position"
 * 4. Server applies moves: "apply_move"
 * 5. Server ends session: "end_game_session"
 *
 * All BGS messages follow request/response pattern with expectedPly for ordering.
 */

import type { Variant, GameInitialState } from "../domain/game-types";

// ============================================================================
// Protocol Version
// ============================================================================

export const CUSTOM_BOT_PROTOCOL_VERSION = 3;

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

/** Configuration for a specific variant (V3: no timeControls) */
export interface VariantConfig {
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
// Bot Game Session (BGS) Types
// ============================================================================

/**
 * Configuration for a Bot Game Session.
 * Reuses existing GameInitialState types for JSON-safe serialization.
 */
export interface BgsConfig {
  variant: Variant;
  boardWidth: number;
  boardHeight: number;
  initialState: GameInitialState;
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

/** Response to start_game_session */
export interface GameSessionStartedMessage {
  type: "game_session_started";
  bgsId: string;
  success: boolean;
  error: string;
}

/** Response to end_game_session */
export interface GameSessionEndedMessage {
  type: "game_session_ended";
  bgsId: string;
  success: boolean;
  error: string;
}

/**
 * Response to evaluate_position.
 * Contains the evaluation and best move for the current position.
 */
export interface EvaluateResponseMessage {
  type: "evaluate_response";
  bgsId: string;
  /** Echo back ply for correlation with request */
  ply: number;
  /** Best move for the side-to-move in standard notation */
  bestMove: string;
  /** Position evaluation from P1's perspective: +1 = P1 winning, 0 = even, -1 = P2 winning */
  evaluation: number;
  success: boolean;
  error: string;
}

/** Response to apply_move */
export interface MoveAppliedMessage {
  type: "move_applied";
  bgsId: string;
  /** New ply after move applied */
  ply: number;
  success: boolean;
  error: string;
}

export type CustomBotClientMessage =
  | AttachMessage
  | GameSessionStartedMessage
  | GameSessionEndedMessage
  | EvaluateResponseMessage
  | MoveAppliedMessage;

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

/** Request to start a new Bot Game Session */
export interface StartGameSessionMessage {
  type: "start_game_session";
  bgsId: string;
  botId: string;
  config: BgsConfig;
}

/** Request to end a Bot Game Session */
export interface EndGameSessionMessage {
  type: "end_game_session";
  bgsId: string;
}

/**
 * Request to evaluate the current position.
 * Engine should return best move and evaluation.
 */
export interface EvaluatePositionMessage {
  type: "evaluate_position";
  bgsId: string;
  /** Expected ply for ordering/staleness detection */
  expectedPly: number;
}

/**
 * Request to apply a move to the game state.
 * Engine should update its internal state.
 */
export interface ApplyMoveMessage {
  type: "apply_move";
  bgsId: string;
  /** Expected ply for ordering/staleness detection */
  expectedPly: number;
  /** Move in standard notation */
  move: string;
}

/** Server messages for BGS protocol */
export type BgsServerMessage =
  | StartGameSessionMessage
  | EndGameSessionMessage
  | EvaluatePositionMessage
  | ApplyMoveMessage;

export type CustomBotServerMessage =
  | AttachedMessage
  | AttachRejectedMessage
  | BgsServerMessage;

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
