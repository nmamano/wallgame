import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Flag,
  Handshake,
  RotateCcw,
  Timer,
  Trophy,
  LogOut,
} from "lucide-react";
import type { PlayerId } from "../../../shared/domain/game-types";
import type { ActionChannel } from "@/lib/player-controllers";
import type { ResolveGameAccessResponse } from "../../../shared/contracts/games";
import type {
  GamePlayer,
  ScoreboardEntry,
  RematchState,
} from "@/hooks/use-game-page-controller";

type AccessKind = ResolveGameAccessResponse["kind"] | null;

interface DrawDecisionPromptState {
  from: PlayerId;
  to: PlayerId;
}

interface TakebackDecisionPromptState {
  requester: PlayerId;
  responder: PlayerId;
}

interface OutgoingTimeInfo {
  id: number;
  message: string;
  createdAt: number;
}

interface PassiveNotice {
  id: number;
  type: "opponent-resigned" | "opponent-gave-time";
  message: string;
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

interface LiveActionsProps {
  drawDecisionPrompt: DrawDecisionPromptState | null;
  takebackDecisionPrompt: TakebackDecisionPromptState | null;
  getPlayerName: (playerId: PlayerId) => string;
  respondToDrawPrompt: (decision: "accept" | "reject") => void;
  respondToTakebackPrompt: (decision: "allow" | "decline") => void;
  resignFlowPlayerId: PlayerId | null;
  pendingDrawForLocal: boolean;
  pendingDrawOffer: PendingDrawOfferState | null;
  takebackPendingForLocal: boolean;
  pendingTakebackRequest: PendingTakebackRequestState | null;
  outgoingTimeInfo: OutgoingTimeInfo | null;
  canCancelDrawOffer: boolean | null;
  canCancelTakebackRequest: boolean | null;
  incomingPassiveNotice: PassiveNotice | null;
  handleCancelResign: () => void;
  handleConfirmResign: () => void;
  handleCancelDrawOffer: () => void;
  handleCancelTakebackRequest: () => void;
  handleDismissOutgoingInfo: () => void;
  handleDismissIncomingNotice: () => void;
  actionButtonsDisabled: boolean;
  manualActionsDisabled: boolean;
  hasTakebackHistory: boolean;
  handleStartResign: () => void;
  handleOfferDraw: () => void;
  handleRequestTakeback: () => void;
  handleGiveTime: () => void;
}

interface EndgameProps {
  gameStatus: "playing" | "finished" | "aborted";
  winnerPlayer: GamePlayer | null;
  winReason: string;
  scoreboardEntries: ScoreboardEntry[];
  rematchState: RematchState;
  rematchStatusText: string;
  userRematchResponse: "pending" | "accepted" | "declined" | null;
  handleAcceptRematch: () => void;
  handleDeclineRematch: () => void;
  handleProposeRematch: () => void;
  openRematchWindow: () => void;
  handleExitAfterMatch: () => void;
  isMultiplayerMatch: boolean;
  primaryLocalPlayerId: PlayerId | null;
  spectatorRematchGameId?: string | null;
  handleFollowSpectatorRematch?: () => void;
  canFollowSpectatorRematch: boolean;
  accessKind: AccessKind;
  isReadOnly: boolean;
}

interface ActionsPanelProps {
  live: LiveActionsProps;
  endgame: EndgameProps;
}

export function ActionsPanel({ live, endgame }: ActionsPanelProps) {
  const {
    drawDecisionPrompt,
    takebackDecisionPrompt,
    getPlayerName,
    respondToDrawPrompt,
    respondToTakebackPrompt,
    resignFlowPlayerId,
    pendingDrawForLocal,
    pendingDrawOffer,
    takebackPendingForLocal,
    pendingTakebackRequest,
    outgoingTimeInfo,
    canCancelDrawOffer,
    canCancelTakebackRequest,
    incomingPassiveNotice,
    handleCancelResign,
    handleConfirmResign,
    handleCancelDrawOffer,
    handleCancelTakebackRequest,
    handleDismissOutgoingInfo,
    handleDismissIncomingNotice,
    handleOfferDraw,
    handleRequestTakeback,
    handleGiveTime,
    actionButtonsDisabled,
    manualActionsDisabled,
    hasTakebackHistory,
    handleStartResign,
  } = live;

  const {
    gameStatus,
    winnerPlayer,
    winReason,
    scoreboardEntries,
    rematchState,
    rematchStatusText,
    userRematchResponse,
    handleAcceptRematch,
    handleDeclineRematch,
    handleProposeRematch,
    openRematchWindow,
    handleExitAfterMatch,
    isMultiplayerMatch,
    primaryLocalPlayerId,
    spectatorRematchGameId,
    handleFollowSpectatorRematch,
    canFollowSpectatorRematch,
    accessKind,
    isReadOnly,
  } = endgame;
  const isReadOnlyView = isReadOnly || primaryLocalPlayerId === null;
  const isIncomingMultiplayerOffer =
    isMultiplayerMatch &&
    rematchState.status === "pending" &&
    primaryLocalPlayerId != null &&
    rematchState.offerer != null &&
    rematchState.offerer !== primaryLocalPlayerId;

  const isOutgoingMultiplayerOffer =
    isMultiplayerMatch &&
    rematchState.status === "pending" &&
    primaryLocalPlayerId != null &&
    rematchState.offerer === primaryLocalPlayerId;

  const canProposeMultiplayerRematch =
    !isReadOnlyView &&
    isMultiplayerMatch &&
    (rematchState.status === "idle" || rematchState.status === "declined");
  const isReplayView = accessKind === "replay";
  const actionsDisabled = actionButtonsDisabled || isReadOnlyView;
  const manualActionsBlocked = manualActionsDisabled || isReadOnlyView;
  const spectatorFollowHandler =
    canFollowSpectatorRematch && handleFollowSpectatorRematch
      ? handleFollowSpectatorRematch
      : undefined;

  if (gameStatus === "finished") {
    const spectatorStatusText = isReplayView
      ? "Replay complete."
      : spectatorRematchGameId
        ? "Players started a rematch."
        : "Waiting to see if players rematch.";
    const showSpectatorFollow =
      isReadOnlyView && Boolean(spectatorFollowHandler);

    return (
      <Card className="p-2 lg:p-3 bg-card/50 backdrop-blur space-y-1.5 lg:space-y-2">
        {/* Result Summary Area - Fixed height 64/84px */}
        <div className="h-[64px] lg:h-[84px] rounded-lg border border-dashed border-border/60 p-2 lg:p-2.5 overflow-hidden flex items-center gap-3">
          <Trophy className="w-8 h-8 lg:w-10 lg:h-10 text-yellow-500 shrink-0" />
          <div className="min-w-0">
            <h3 className="text-sm lg:text-base font-bold truncate">
              {winnerPlayer ? `${winnerPlayer.name} won` : "Draw"}
            </h3>
            <p className="text-[10px] lg:text-xs text-muted-foreground truncate">
              {winReason
                ? winReason.charAt(0).toUpperCase() + winReason.slice(1)
                : ""}
            </p>
          </div>
        </div>

        {/* Scoreboard Area - Replacing the 2x2 buttons grid */}
        <div className="grid grid-cols-2 gap-1.5 lg:gap-2 h-[64px] lg:h-[84px]">
          {scoreboardEntries.length > 0 ? (
            scoreboardEntries.map((entry) => (
              <div
                key={entry.id}
                className="rounded-lg border border-dashed border-border/60 px-2 lg:px-3 py-1 lg:py-1.5 flex flex-col justify-center"
              >
                <div className="text-[10px] lg:text-xs text-muted-foreground truncate">
                  {entry.name}
                </div>
                <div className="text-base lg:text-xl font-bold">
                  {entry.score}
                </div>
              </div>
            ))
          ) : (
            <div className="col-span-2 flex items-center justify-center text-[10px] lg:text-xs text-muted-foreground border border-dashed border-border/60 rounded-lg">
              Game Over
            </div>
          )}
        </div>

        {/* Rematch Controls Area - Fixed height 64/84px */}
        <div className="h-[64px] lg:h-[84px] rounded-lg border border-dashed border-border/60 p-2 lg:p-2.5 overflow-hidden flex flex-col justify-center">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] lg:text-xs text-muted-foreground truncate">
                {isReadOnlyView
                  ? spectatorStatusText
                  : rematchStatusText || "Match concluded"}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px] gap-1"
                onClick={handleExitAfterMatch}
              >
                <LogOut className="w-3 h-3" /> Exit
              </Button>
            </div>

            <div className="flex gap-2">
              {isReadOnlyView ? (
                showSpectatorFollow && spectatorFollowHandler ? (
                  <Button
                    size="sm"
                    className="h-7 lg:h-8 px-3 text-xs flex-1"
                    onClick={spectatorFollowHandler}
                  >
                    Watch rematch
                  </Button>
                ) : (
                  <div
                    className="text-[10px] lg:text-xs text-muted-foreground truncate"
                    aria-hidden="true"
                  />
                )
              ) : (
                <>
                  {canProposeMultiplayerRematch && (
                    <Button
                      size="sm"
                      className="h-7 lg:h-8 px-3 text-xs flex-1"
                      onClick={handleProposeRematch}
                    >
                      {rematchState.status === "declined"
                        ? "Retry Rematch"
                        : "Propose Rematch"}
                    </Button>
                  )}

                  {isOutgoingMultiplayerOffer && (
                    <Button
                      size="sm"
                      className="h-7 lg:h-8 px-3 text-xs flex-1"
                      disabled
                    >
                      Proposed...
                    </Button>
                  )}

                  {((rematchState.status === "pending" &&
                    !isMultiplayerMatch) ||
                    isIncomingMultiplayerOffer) && (
                    <>
                      <Button
                        size="sm"
                        className="h-7 lg:h-8 px-3 text-xs flex-1"
                        onClick={handleAcceptRematch}
                        disabled={userRematchResponse === "accepted"}
                      >
                        {userRematchResponse === "accepted"
                          ? "Accepted"
                          : "Accept"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 lg:h-8 px-3 text-xs flex-1"
                        onClick={handleDeclineRematch}
                        disabled={userRematchResponse === "declined"}
                      >
                        Decline
                      </Button>
                    </>
                  )}

                  {rematchState.status === "declined" &&
                    !isMultiplayerMatch && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 lg:h-8 px-3 text-xs flex-1"
                        onClick={openRematchWindow}
                      >
                        Offer Again
                      </Button>
                    )}

                  {rematchState.status === "starting" && (
                    <div className="text-[10px] lg:text-xs animate-pulse text-primary font-medium">
                      Starting next game...
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </Card>
    );
  }
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
              disabled={isReadOnlyView}
            >
              Accept
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 sm:h-8 px-3 text-xs sm:text-sm"
              onClick={() => respondToDrawPrompt("reject")}
              disabled={isReadOnlyView}
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
              disabled={isReadOnlyView}
            >
              Allow
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 sm:h-8 px-3 text-xs sm:text-sm"
              onClick={() => respondToTakebackPrompt("decline")}
              disabled={isReadOnlyView}
            >
              Decline
            </Button>
          </div>
        </>
      );
    }
    if (incomingPassiveNotice && !isReadOnlyView) {
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
              disabled={isReadOnlyView}
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
              disabled={isReadOnlyView}
            >
              Keep playing
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-7 sm:h-8 px-3 text-xs sm:text-sm"
              onClick={handleConfirmResign}
              disabled={isReadOnlyView}
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
              disabled={!canCancelDrawOffer || isReadOnlyView}
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
              disabled={!canCancelTakebackRequest || isReadOnlyView}
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
            disabled={isReadOnlyView}
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
    <Card className="p-2 lg:p-3 bg-card/50 backdrop-blur space-y-1.5 lg:space-y-2">
      <div className="h-[64px] lg:h-[84px] rounded-lg border border-dashed border-border/60 p-2 lg:p-2.5 overflow-hidden">
        <div className="flex flex-col justify-center gap-1 h-full">
          {incomingSection}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5 lg:gap-2 h-[64px] lg:h-[84px]">
        <Button
          variant="outline"
          className="w-full justify-start gap-1.5 lg:gap-2 text-xs lg:text-sm h-8 lg:h-9 px-2 lg:px-3"
          size="sm"
          onClick={handleStartResign}
          disabled={actionsDisabled}
        >
          <Flag className="w-3.5 h-3.5 lg:w-4 lg:h-4" /> Resign
        </Button>
        <Button
          variant="outline"
          className="w-full justify-start gap-1.5 lg:gap-2 text-xs lg:text-sm h-8 lg:h-9 px-2 lg:px-3"
          size="sm"
          onClick={handleOfferDraw}
          disabled={
            actionsDisabled || manualActionsBlocked || Boolean(pendingDrawOffer)
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
            actionsDisabled ||
            manualActionsBlocked ||
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
          disabled={actionsDisabled || manualActionsBlocked}
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
