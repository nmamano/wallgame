import type {
  ControllerActionKind,
  ControllerError,
} from "@/lib/player-controllers";

const ACTION_COPY: Record<
  ControllerActionKind,
  { infinitive: string; progressive: string }
> = {
  resign: { infinitive: "resign", progressive: "resigning" },
  offerDraw: { infinitive: "offer a draw", progressive: "offering a draw" },
  requestTakeback: {
    infinitive: "request a takeback",
    progressive: "requesting a takeback",
  },
  giveTime: { infinitive: "give time", progressive: "giving time" },
  offerRematch: {
    infinitive: "offer a rematch",
    progressive: "offering a rematch",
  },
  respondRematch: {
    infinitive: "answer the rematch request",
    progressive: "answering the rematch request",
  },
};

export function describeControllerError(
  action: ControllerActionKind,
  error: ControllerError,
): string {
  const copy = ACTION_COPY[action];
  const infinitive = copy?.infinitive ?? "perform that action";
  const progressive = copy?.progressive ?? "performing that action";
  switch (error.kind) {
    case "ControllerUnavailable":
      return (
        error.message ??
        `We can't ${infinitive} because the controller for that seat is unavailable.`
      );
    case "NotCapable":
      return error.message ?? `You cannot ${infinitive} right now.`;
    case "TransientTransport":
      return (
        error.message ??
        `We lost the connection while ${progressive}. Try again in a moment.`
      );
    case "ActionRejected":
      return (
        error.message ??
        `The attempt to ${infinitive} was rejected${
          error.code ? ` (${error.code})` : ""
        }.`
      );
    case "UnsupportedAction":
      return error.message ?? `This seat does not support ${infinitive}.`;
    case "Unknown":
    default:
      return error.message ?? `Unable to ${infinitive} right now.`;
  }
}
