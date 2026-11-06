import { z } from "zod";

export type RematchDecision = "accepted" | "declined";

export type ControllerActionKind =
  | "resign"
  | "offerDraw"
  | "requestTakeback"
  | "giveTime"
  | "offerRematch"
  | "respondRematch";

/**
 * The most one gift of time can add: one hour, the start clock of the longest
 * time control. A gift larger than a whole game is not a real gift; the UI
 * gives 60 s per click.
 */
export const MAX_TIME_GIFT_SECONDS = 60 * 60;

/** A gift of time: a finite number of seconds, above 0, at most one hour. */
export const giveTimePayloadSchema = z.object({
  seconds: z.number().positive().max(MAX_TIME_GIFT_SECONDS),
});

export interface ActionRequestPayloadMap {
  resign: void;
  offerDraw: void;
  requestTakeback: void;
  giveTime: z.infer<typeof giveTimePayloadSchema>;
  offerRematch: void;
  respondRematch: { decision: RematchDecision };
}

export type ActionRequestPayload<K extends ControllerActionKind> =
  ActionRequestPayloadMap[K];

export type ActionNackCode =
  | "UNAUTHORIZED"
  | "INVALID_PAYLOAD"
  | "UNKNOWN_ACTION"
  | "MATCH_NOT_FOUND"
  | "NOT_IN_MATCH"
  | "INTERNAL_ERROR"
  | "NOT_ALLOWED"
  | "NOT_YOUR_TURN"
  | "ALREADY_PENDING"
  | "TOO_LATE"
  | "RATE_LIMITED"
  | "REMATCH_NOT_AVAILABLE"
  | "REMATCH_ALREADY_DECIDED"
  | "INVALID_SECONDS";
