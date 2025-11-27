import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Flag, Handshake, RotateCcw, Timer } from "lucide-react";
import type { PlayerId } from "../../../shared/game-types";

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
  from: PlayerId;
  to: PlayerId;
  requestId: number;
  status: "pending";
  createdAt: number;
}

interface PendingTakebackRequestState {
  requester: PlayerId;
  responder: PlayerId;
  requestId: number;
  status: "pending";
  createdAt: number;
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
  canCancelDrawOffer: boolean;
  canCancelTakebackRequest: boolean;
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
          <div className="flex items-center gap-2 text-sm">
            <Handshake className="w-4 h-4 text-primary" />
            {`${getPlayerName(drawDecisionPrompt.from)} offered a draw.`}
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => respondToDrawPrompt("accept")}>
              Accept
            </Button>
            <Button
              size="sm"
              variant="outline"
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
          <div className="flex items-center gap-2 text-sm">
            <RotateCcw className="w-4 h-4" />
            {`${getPlayerName(
              takebackDecisionPrompt.requester,
            )} requested a takeback.`}
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => respondToTakebackPrompt("allow")}>
              Allow
            </Button>
            <Button
              size="sm"
              variant="outline"
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
          <div className="flex items-center gap-2 text-sm">
            {incomingPassiveNotice.type === "opponent-resigned" ? (
              <Flag className="w-4 h-4 text-destructive" />
            ) : (
              <Timer className="w-4 h-4 text-primary" />
            )}
            {incomingPassiveNotice.message}
          </div>
          <div>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs px-2"
              onClick={handleDismissIncomingNotice}
            >
              Dismiss
            </Button>
          </div>
        </>
      );
    }
    return (
      <p className="text-sm text-muted-foreground">
        No active incoming offers.
      </p>
    );
  })();

  const outgoingSection = (() => {
    if (resignFlowPlayerId) {
      return (
        <>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={handleCancelResign}>
              Keep playing
            </Button>
            <Button
              size="sm"
              variant="destructive"
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
          <div className="flex items-center gap-2 text-sm">
            <Handshake className="w-4 h-4" />
            {`Waiting for a response to your draw offer.`}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleCancelDrawOffer}
            disabled={!canCancelDrawOffer}
          >
            {canCancelDrawOffer ? "Cancel offer" : "Can cancel in 2s"}
          </Button>
        </>
      );
    }
    if (takebackPendingForLocal && pendingTakebackRequest) {
      return (
        <>
          <div className="flex items-center gap-2 text-sm">
            <RotateCcw className="w-4 h-4" />
            {`Waiting for a response to your takeback request.`}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleCancelTakebackRequest}
            disabled={!canCancelTakebackRequest}
          >
            {canCancelTakebackRequest ? "Cancel request" : "Can cancel in 2s"}
          </Button>
        </>
      );
    }
    if (outgoingTimeInfo) {
      return (
        <>
          <div className="flex items-center gap-2 text-sm">
            <Timer className="w-4 h-4 text-primary" />
            {outgoingTimeInfo.message}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="text-xs px-2 self-start"
            onClick={handleDismissOutgoingInfo}
          >
            Dismiss
          </Button>
        </>
      );
    }
    return (
      <p className="text-sm text-muted-foreground">
        No active outgoing offers.
      </p>
    );
  })();

  return (
    <Card className="p-2 lg:p-3 bg-card/50 backdrop-blur">
      <div className="min-h-[60px] lg:min-h-[80px] rounded-lg border border-dashed border-border/60 p-2 lg:p-2.5 flex flex-col justify-center gap-1.5 lg:gap-2">
        {incomingSection}
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
      <div className="min-h-[60px] lg:min-h-[80px] rounded-lg border border-dashed border-border/60 p-2 lg:p-2.5 flex flex-col justify-center gap-1.5">
        {outgoingSection}
      </div>
    </Card>
  );
}
