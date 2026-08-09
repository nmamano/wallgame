/**
 * WebSocket message types for game sessions.
 *
 * This file defines the message types sent over WebSocket connections between
 * the frontend and server during game sessions. It includes both:
 * - Game moves (actions on the board)
 * - Meta game actions (interactions outside the board, like draw offers, takebacks, etc.)
 */

import { z } from "zod";
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
import { cellSchema } from "./games";

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
 * - Utility: ping
 *
 * Giving time is NOT here. It goes through `action-request` with the `giveTime`
 * action, which is the only path the client has used since 2025-12-18.
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
 * What the game socket accepts off the wire.
 *
 * `ClientMessage` above describes what our own client PRODUCES. It says nothing
 * about what arrives: the socket used to `JSON.parse(raw) as ClientMessage`, a
 * cast that asserts a shape rather than checking one, so any JSON at all reached
 * the handlers. A hand-written `submit-move` frame from an authenticated seat
 * could therefore carry a pawn target off the board, and did — measured against
 * 66f6688, the crafted frame `{"type":"submit-move","move":{"actions":[{"type":
 * "cat","target":[0,-1]}]}}` was accepted, moved the authoritative state and
 * persisted the term "C`8" (board task d39862b4).
 *
 * So this schema is the boundary: everything below is validated before a handler
 * sees it, and a frame that fails takes the error-frame path the socket already
 * had for malformed JSON.
 *
 * TWO PLACES IT IS DELIBERATELY LOOSER THAN `ClientMessage`, because tightening
 * them would move a rejection that already exists rather than add one:
 *
 *   - `chat-message.channel` is a plain string, not `ChatChannel`. An unknown
 *     channel is already refused by `validateChatChannelAccess`, which answers
 *     with a `chat-error` frame carrying INVALID_CHANNEL. An enum here would
 *     replace that with a generic `error` frame.
 *   - `action-request.action` is a plain string, not `ControllerActionKind`, and
 *     its payload stays `unknown`. Each action validates its own payload and
 *     answers with its own nack code (UNKNOWN_ACTION, INVALID_SECONDS,
 *     INVALID_PAYLOAD); an enum would make UNKNOWN_ACTION unreachable.
 *
 * Objects are not `.strict()`: an unknown field is stripped rather than
 * rejected, so a client one version ahead is not cut off mid-game.
 */
const gameActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cat"), target: cellSchema }),
  z.object({ type: z.literal("mouse"), target: cellSchema }),
  z.object({
    type: z.literal("wall"),
    target: cellSchema,
    wallOrientation: z.enum(["vertical", "horizontal"]),
  }),
]);

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("submit-move"),
    move: z.object({ actions: z.array(gameActionSchema) }),
  }),
  z.object({ type: z.literal("resign") }),
  z.object({ type: z.literal("ping") }),
  // No `give-time` variant, on purpose. It was a second way to give time that
  // reached the clock with no policy at all, so a seat could send a negative
  // number and take its opponent's clock away. Nothing had sent it since
  // 2025-12-18, so it is gone rather than validated: one path to a clock is one
  // rule to keep, and the surviving `action-request` path already has it.
  z.object({ type: z.literal("takeback-offer") }),
  z.object({ type: z.literal("takeback-accept") }),
  z.object({ type: z.literal("takeback-reject") }),
  z.object({ type: z.literal("draw-offer") }),
  z.object({ type: z.literal("draw-accept") }),
  z.object({ type: z.literal("draw-reject") }),
  z.object({ type: z.literal("rematch-offer") }),
  z.object({ type: z.literal("rematch-accept") }),
  z.object({ type: z.literal("rematch-reject") }),
  z.object({
    type: z.literal("chat-message"),
    channel: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("action-request"),
    requestId: z.string(),
    action: z.string(),
    payload: z.unknown().optional(),
  }),
]);

/** A frame that passed the schema. Handlers take this, never `ClientMessage`. */
export type InboundClientMessage = z.infer<typeof clientMessageSchema>;

/** The validated action-request frame, whose `action` is still any string. */
export type InboundActionRequestMessage = Extract<
  InboundClientMessage,
  { type: "action-request" }
>;

/**
 * Compile-time parity, minus the two variants named above.
 *
 * Every OTHER inbound variant must still satisfy the producer contract, so a
 * field added to `ClientMessage` without a matching rule here is a build error
 * rather than an unchecked field. The two exclusions are listed by name so the
 * deliberate width difference stays visible instead of being absorbed.
 */
type Assert<T extends true> = T;

export type InboundParityChecked = Assert<
  Exclude<
    InboundClientMessage,
    { type: "chat-message" } | { type: "action-request" }
  > extends Exclude<ClientMessage, { type: "chat-message" | "action-request" }>
    ? true
    : false
>;

/**
 * And the width difference itself, stated rather than implied: every channel our
 * client can produce is still accepted. Only the reverse is untrue.
 */
export type InboundChatChannelAcceptsContract = Assert<
  ChatChannel extends Extract<
    InboundClientMessage,
    { type: "chat-message" }
  >["channel"]
    ? true
    : false
>;

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
