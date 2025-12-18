export type RematchDecision = "accepted" | "declined";

export type ControllerActionKind =
  | "resign"
  | "offerDraw"
  | "requestTakeback"
  | "giveTime"
  | "offerRematch"
  | "respondRematch";

export interface ActionRequestPayloadMap {
  resign: void;
  offerDraw: void;
  requestTakeback: void;
  giveTime: { seconds: number };
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
