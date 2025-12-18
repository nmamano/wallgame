import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Flag, Handshake, RotateCcw, Timer } from "lucide-react";
import type { PlayerId } from "../../../shared/domain/game-types";
import type { ActionChannel } from "@/lib/player-controllers";

interface DrawDecisionPromptState {
  from: PlayerId;
  to: PlayerId;
}

interface TakebackDecisionPromptState {
  requester: PlayerId;
  responder: PlayerId;
}

interface PassiveNotice {
  id: number;
  type: "opponent-resigned" | "opponent-gave-time";
  message: string;
}

interface OutgoingTimeInfo {
  id: number;
  message: string;
  createdAt: number;
}

interface PendingDrawOfferState {
  actorSeatId: PlayerId;
  opponentSeatId: PlayerId;
  requestId: number;
  status: "pending";
  createdAt: number;
  channel: ActionChannel;
}

interface PendingTakebackRequestState {
  actorSeatId: PlayerId;
  opponentSeatId: PlayerId;
  requestId: number;
  status: "pending";
  createdAt: number;
  historyLengthAtRequest: number;
  channel: ActionChannel;
}

interface ActionsPanelProps {
  // Incoming section props
  drawDecisionPrompt: DrawDecisionPromptState | null;
  takebackDecisionPrompt: TakebackDecisionPromptState | null;
  incomingPassiveNotice: PassiveNotice | null;
  getPlayerName: (playerId: PlayerId) => string;
  respondToDrawPrompt: (decision: "accept" | "reject") => void;
  respondToTakebackPrompt: (decision: "allow" | "decline") => void;
  handleDismissIncomingNotice: () => void;

  // Outgoing section props
  resignFlowPlayerId: PlayerId | null;
  pendingDrawForLocal: boolean;
  pendingDrawOffer: PendingDrawOfferState | null;
  takebackPendingForLocal: boolean;
  pendingTakebackRequest: PendingTakebackRequestState | null;
  outgoingTimeInfo: OutgoingTimeInfo | null;
  canCancelDrawOffer: boolean | null;
  canCancelTakebackRequest: boolean | null;
  handleCancelResign: () => void;
  handleConfirmResign: () => void;
  handleCancelDrawOffer: () => void;
  handleCancelTakebackRequest: () => void;
  handleDismissOutgoingInfo: () => void;

  // Action buttons props
  actionButtonsDisabled: boolean;
  manualActionsDisabled: boolean;
  hasTakebackHistory: boolean;
  handleStartResign: () => void;
  handleOfferDraw: () => void;
  handleRequestTakeback: () => void;
  handleGiveTime: () => void;
}

export function ActionsPanel({
  drawDecisionPrompt,
  takebackDecisionPrompt,
  incomingPassiveNotice,
  getPlayerName,
  respondToDrawPrompt,
  respondToTakebackPrompt,
  handleDismissIncomingNotice,
  resignFlowPlayerId,
  pendingDrawForLocal,
  pendingDrawOffer,
  takebackPendingForLocal,
  pendingTakebackRequest,
  outgoingTimeInfo,
  canCancelDrawOffer,
  canCancelTakebackRequest,
  handleCancelResign,
  handleConfirmResign,
  handleCancelDrawOffer,
  handleCancelTakebackRequest,
  handleDismissOutgoingInfo,
  actionButtonsDisabled,
  manualActionsDisabled,
  hasTakebackHistory,
  handleStartResign,
  handleOfferDraw,
  handleRequestTakeback,
  handleGiveTime,
}: ActionsPanelProps) {
  const incomingSection = (() => {
    if (drawDecisionPrompt) {
      return (
        <>
          <div className="flex items-center gap-2 text-xs sm:text-sm leading-tight">
            <Handshake className="w-4 h-4 text-primary shrink-0" />
            <span className="truncate">
              {`${getPlayerName(drawDecisionPrompt.from)} offered a draw.`}
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 sm:h-8 px-3 text-xs sm:text-sm"
              onClick={() => respondToDrawPrompt("accept")}
            >
              Accept
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 sm:h-8 px-3 text-xs sm:text-sm"
              onClick={() => respondToDrawPrompt("reject")}
            >
              Decline
            </Button>
          </div>
        </>
      );
    }
    if (takebackDecisionPrompt) {
      return (
        <>
          <div className="flex items-center gap-2 text-xs sm:text-sm leading-tight">
            <RotateCcw className="w-4 h-4 shrink-0" />
            <span className="truncate">
              {`${getPlayerName(
                takebackDecisionPrompt.requester,
              )} requested a takeback.`}
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 sm:h-8 px-3 text-xs sm:text-sm"
              onClick={() => respondToTakebackPrompt("allow")}
            >
              Allow
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 sm:h-8 px-3 text-xs sm:text-sm"
              onClick={() => respondToTakebackPrompt("decline")}
            >
              Decline
            </Button>
          </div>
        </>
      );
    }
    if (incomingPassiveNotice) {
      return (
        <>
          <div className="flex items-center gap-2 text-xs sm:text-sm leading-tight">
            {incomingPassiveNotice.type === "opponent-resigned" ? (
              <Flag className="w-4 h-4 text-destructive shrink-0" />
            ) : (
              <Timer className="w-4 h-4 text-primary shrink-0" />
            )}
            <span className="truncate">{incomingPassiveNotice.message}</span>
          </div>
          <div>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs px-2 h-7"
              onClick={handleDismissIncomingNotice}
            >
              Dismiss
            </Button>
          </div>
        </>
      );
    }
    return (
      <p className="text-xs sm:text-sm leading-tight text-muted-foreground truncate">
        No active incoming offers.
      </p>
    );
  })();

  const outgoingSection = (() => {
    if (resignFlowPlayerId) {
      return (
        <>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 sm:h-8 px-3 text-xs sm:text-sm"
              onClick={handleCancelResign}
            >
              Keep playing
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-7 sm:h-8 px-3 text-xs sm:text-sm"
              onClick={handleConfirmResign}
            >
              Resign
            </Button>
          </div>
        </>
      );
    }
    if (pendingDrawForLocal && pendingDrawOffer) {
      return (
        <>
          <div className="flex items-center gap-2 text-xs sm:text-sm leading-tight">
            <Handshake className="w-4 h-4 shrink-0" />
            <span className="truncate">
              {`Waiting for a response to your draw offer.`}
            </span>
          </div>
          {canCancelDrawOffer !== null && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 sm:h-8 px-3 text-xs sm:text-sm"
              onClick={handleCancelDrawOffer}
              disabled={!canCancelDrawOffer}
            >
              {canCancelDrawOffer ? "Cancel offer" : "Can cancel in 2s"}
            </Button>
          )}
        </>
      );
    }
    if (takebackPendingForLocal && pendingTakebackRequest) {
      return (
        <>
          <div className="flex items-center gap-2 text-xs sm:text-sm leading-tight">
            <RotateCcw className="w-4 h-4 shrink-0" />
            <span className="truncate">
              {`Waiting for a response to your takeback request.`}
            </span>
          </div>
          {canCancelTakebackRequest !== null && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 sm:h-8 px-3 text-xs sm:text-sm"
              onClick={handleCancelTakebackRequest}
              disabled={!canCancelTakebackRequest}
            >
              {canCancelTakebackRequest ? "Cancel request" : "Can cancel in 2s"}
            </Button>
          )}
        </>
      );
    }
    if (outgoingTimeInfo) {
      return (
        <>
          <div className="flex items-center gap-2 text-xs sm:text-sm leading-tight">
            <Timer className="w-4 h-4 text-primary shrink-0" />
            <span className="truncate">{outgoingTimeInfo.message}</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="text-xs px-2 self-start h-7"
            onClick={handleDismissOutgoingInfo}
          >
            Dismiss
          </Button>
        </>
      );
    }
    return (
      <p className="text-xs sm:text-sm leading-tight text-muted-foreground truncate">
        No active outgoing offers.
      </p>
    );
  })();

  return (
    <Card className="p-2 lg:p-3 bg-card/50 backdrop-blur">
      <div className="h-[64px] lg:h-[84px] rounded-lg border border-dashed border-border/60 p-2 lg:p-2.5 overflow-hidden">
        <div className="flex flex-col justify-center gap-1 h-full">
          {incomingSection}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5 lg:gap-2 my-1 lg:my-0">
        <Button
          variant="outline"
          className="w-full justify-start gap-1.5 lg:gap-2 text-xs lg:text-sm h-8 lg:h-9 px-2 lg:px-3"
          size="sm"
          onClick={handleStartResign}
          disabled={actionButtonsDisabled}
        >
          <Flag className="w-3.5 h-3.5 lg:w-4 lg:h-4" /> Resign
        </Button>
        <Button
          variant="outline"
          className="w-full justify-start gap-1.5 lg:gap-2 text-xs lg:text-sm h-8 lg:h-9 px-2 lg:px-3"
          size="sm"
          onClick={handleOfferDraw}
          disabled={
            actionButtonsDisabled ||
            manualActionsDisabled ||
            Boolean(pendingDrawOffer)
          }
        >
          <Handshake className="w-3.5 h-3.5 lg:w-4 lg:h-4" /> Draw
        </Button>
        <Button
          variant="outline"
          className="w-full justify-start gap-1.5 lg:gap-2 text-xs lg:text-sm h-8 lg:h-9 px-2 lg:px-3"
          size="sm"
          onClick={handleRequestTakeback}
          disabled={
            actionButtonsDisabled ||
            manualActionsDisabled ||
            Boolean(pendingTakebackRequest) ||
            !hasTakebackHistory
          }
        >
          <RotateCcw className="w-3.5 h-3.5 lg:w-4 lg:h-4" /> Takeback
        </Button>
        <Button
          variant="outline"
          className="w-full justify-start gap-1.5 lg:gap-2 text-xs lg:text-sm h-8 lg:h-9 px-2 lg:px-3"
          size="sm"
          onClick={handleGiveTime}
          disabled={actionButtonsDisabled || manualActionsDisabled}
        >
          <Timer className="w-3.5 h-3.5 lg:w-4 lg:h-4" /> Give time
        </Button>
      </div>
      <div className="h-[64px] lg:h-[84px] rounded-lg border border-dashed border-border/60 p-2 lg:p-2.5 overflow-hidden">
        <div className="flex flex-col justify-center gap-1 h-full">
          {outgoingSection}
        </div>
      </div>
    </Card>
  );
}
