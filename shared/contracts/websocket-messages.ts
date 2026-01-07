/**
 * WebSocket message types for game sessions.
 *
 * This file defines the message types sent over WebSocket connections between
 * the frontend and server during game sessions. It includes both:
 * - Game moves (actions on the board)
 * - Meta game actions (interactions outside the board, like draw offers, takebacks, etc.)
 */

import type {
  Move,
  SerializedGameState,
  GameSnapshot,
} from "../domain/game-types";
import type {
  ControllerActionKind,
  ActionRequestPayload,
  ActionNackCode,
} from "./controller-actions";

// ============================================================================
// Chat Types
// ============================================================================

export type ChatChannel = "game" | "team" | "audience";

export type ChatErrorCode =
  | "MODERATION"
  | "RATE_LIMITED"
  | "TOO_LONG"
  | "INVALID_CHANNEL";

/**
 * Messages sent from client to server over the game WebSocket connection.
 *
 * Includes:
 * - Game moves: "submit-move" (actions on the board)
 * - Meta game actions: resign, draw offers/accept/reject, takeback offers/accept/reject, rematch offers/accept/reject
 * - Utility: ping, give-time
 */
export interface ActionRequestMessage<
  K extends ControllerActionKind = ControllerActionKind,
> {
  type: "action-request";
  requestId: string;
  action: K;
  payload?: ActionRequestPayload<K>;
}

export type ClientMessage =
  | { type: "submit-move"; move: Move }
  | { type: "resign" }
  | { type: "ping" }
  | { type: "give-time"; seconds: number }
  | { type: "takeback-offer" }
  | { type: "takeback-accept" }
  | { type: "takeback-reject" }
  | { type: "draw-offer" }
  | { type: "draw-accept" }
  | { type: "draw-reject" }
  | { type: "rematch-offer" }
  | { type: "rematch-accept" }
  | { type: "rematch-reject" }
  | { type: "chat-message"; channel: ChatChannel; text: string }
  | ActionRequestMessage;

/**
 * Messages sent from server to client over the game WebSocket connection.
 *
 * Includes:
 * - Game state updates: "state" (serialized game state), "match-status" (game snapshot)
 * - Meta action broadcasts: takeback/draw/rematch offers and rejections (broadcast to both players)
 * - Utility: error messages, pong responses
 */
export interface ActionAckMessage {
  type: "actionAck";
  requestId: string;
  action: ControllerActionKind;
  serverTime: number;
}

export interface ActionNackMessage {
  type: "actionNack";
  requestId: string;
  action: ControllerActionKind;
  code: ActionNackCode;
  message?: string;
  retryable?: boolean;
  serverTime: number;
}

export type ServerMessage =
  | { type: "state"; state: SerializedGameState; evaluation?: number }
  | { type: "match-status"; snapshot: GameSnapshot }
  | { type: "welcome"; socketId: string }
  | { type: "error"; message: string }
  | { type: "pong"; timestamp: number }
  | { type: "takeback-offer"; playerId: number }
  | { type: "takeback-rejected"; playerId: number }
  | { type: "draw-offer"; playerId: number }
  | { type: "draw-rejected"; playerId: number }
  | { type: "rematch-offer"; playerId: number }
  | { type: "rematch-rejected"; playerId: number }
  | {
      type: "rematch-started";
      newGameId: string;
      seat?: { token: string; socketToken: string };
    }
  | {
      type: "chat-message";
      channel: ChatChannel;
      senderId: string;
      senderName: string;
      text: string;
      timestamp: number;
    }
  | { type: "chat-error"; code: ChatErrorCode; message: string }
  | ActionAckMessage
  | ActionNackMessage;

/**
 * Messages sent from client to server over the lobby WebSocket connection.
 * Used for matchmaking game list updates.
 */
export interface LobbyClientMessage {
  type: "ping";
}

/**
 * Messages sent from server to client over the lobby WebSocket connection.
 * Used for broadcasting matchmaking game list updates.
 */
export type LobbyServerMessage =
  | { type: "games"; games: GameSnapshot[] }
  | { type: "pong"; timestamp: number };

// ============================================================================
// Live Games WebSocket Messages (for /ws/live-games)
// ============================================================================

import type { LiveGameSummary } from "./games";

/**
 * Messages sent from client to server over the live-games WebSocket connection.
 * Used for keeping the connection alive.
 */
export interface LiveGamesClientMessage {
  type: "ping";
}

/**
 * Messages sent from server to client over the live-games WebSocket connection.
 * Used for real-time updates of the live games list.
 */
export type LiveGamesServerMessage =
  | { type: "snapshot"; games: LiveGameSummary[] }
  | { type: "upsert"; game: LiveGameSummary }
  | { type: "remove"; gameId: string }
  | { type: "pong"; timestamp: number };
