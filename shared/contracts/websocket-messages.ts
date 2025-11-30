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

/**
 * Messages sent from client to server over the game WebSocket connection.
 *
 * Includes:
 * - Game moves: "submit-move" (actions on the board)
 * - Meta game actions: resign, draw offers/accept/reject, takeback offers/accept/reject, rematch offers/accept/reject
 * - Utility: ping, give-time
 */
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
  | { type: "rematch-reject" };

/**
 * Messages sent from server to client over the game WebSocket connection.
 *
 * Includes:
 * - Game state updates: "state" (serialized game state), "match-status" (game snapshot)
 * - Meta action broadcasts: takeback/draw/rematch offers and rejections (broadcast to both players)
 * - Utility: error messages, pong responses
 */
export type ServerMessage =
  | { type: "state"; state: SerializedGameState }
  | { type: "match-status"; snapshot: GameSnapshot }
  | { type: "error"; message: string }
  | { type: "pong"; timestamp: number }
  | { type: "takeback-offer"; playerId: number }
  | { type: "takeback-rejected"; playerId: number }
  | { type: "draw-offer"; playerId: number }
  | { type: "draw-rejected"; playerId: number }
  | { type: "rematch-offer"; playerId: number }
  | { type: "rematch-rejected"; playerId: number };

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
