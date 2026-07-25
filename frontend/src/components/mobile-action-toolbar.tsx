import { Button } from "@/components/ui/button";
import {
  Flag,
  Handshake,
  RotateCcw,
  Timer,
  Trophy,
  LogOut,
  X,
} from "lucide-react";
import type { PlayerId } from "../../../shared/domain/game-types";
import type { RematchState } from "@/hooks/use-game-page-controller";
import type {
  DrawDecisionPromptState,
  TakebackDecisionPromptState,
  PendingDrawOfferState,
  PendingTakebackRequestState,
  PassiveNotice,
  OutgoingTimeInfo,
} from "@/hooks/use-meta-game-actions";
import type { ResolveGameAccessResponse } from "../../../shared/contracts/games";

type AccessKind = ResolveGameAccessResponse["kind"] | null;

export interface MobileToolbarLiveProps {
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
  isUnlimited: boolean;
}

export interface MobileToolbarEndgameProps {
  gameStatus: "playing" | "finished" | "aborted";
  /** e.g. "Nil won", "Draw", "Game aborted". Formatted by the controller. */
  resultHeadline: string;
  /** e.g. "Capture", "No rating or record change". May be empty. */
  resultDetail: string;
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

interface MobileActionToolbarProps {
  live: MobileToolbarLiveProps;
  endgame: MobileToolbarEndgameProps;
}

/**
 * Compact floating toolbar for mobile game page.
 * Replaces the full ActionsPanel with a slim 40px bar.
 */
export function MobileActionToolbar({ live, endgame }: MobileActionToolbarProps) {
  const {
    drawDecisionPrompt,
    takebackDecisionPrompt,
    resignFlowPlayerId,
    pendingDrawForLocal,
    pendingDrawOffer,
    takebackPendingForLocal,
    pendingTakebackRequest,
    incomingPassiveNotice,
    handleCancelResign,
    handleConfirmResign,
    handleCancelDrawOffer,
    handleCancelTakebackRequest,
    handleDismissIncomingNotice,
    actionButtonsDisabled,
    manualActionsDisabled,
    hasTakebackHistory,
    handleStartResign,
    handleOfferDraw,
    handleRequestTakeback,
    handleGiveTime,
    isUnlimited,
    canCancelDrawOffer,
    canCancelTakebackRequest,
    respondToDrawPrompt,
    respondToTakebackPrompt,
  } = live;

  const {
    gameStatus,
    resultHeadline,
    resultDetail,
    rematchState,
    userRematchResponse,
    handleAcceptRematch,
    handleDeclineRematch,
    handleProposeRematch,
    handleExitAfterMatch,
    isMultiplayerMatch,
    primaryLocalPlayerId,
    spectatorRematchGameId,
    handleFollowSpectatorRematch,
    canFollowSpectatorRematch,
    isReadOnly,
  } = endgame;

  const isReadOnlyView = isReadOnly || primaryLocalPlayerId === null;
  const actionsDisabled = actionButtonsDisabled || isReadOnlyView;
  const manualActionsBlocked = manualActionsDisabled || isReadOnlyView;

  const barClass =
    "flex items-center justify-center w-full px-2 bg-card/90 backdrop-blur border-t border-border";

  // ── Endgame toolbar ──
  if (gameStatus === "finished") {
    const isIncomingOffer =
      isMultiplayerMatch &&
      rematchState.status === "pending" &&
      primaryLocalPlayerId != null &&
      rematchState.offerer != null &&
      rematchState.offerer !== primaryLocalPlayerId;

    const isOutgoingOffer =
      isMultiplayerMatch &&
      rematchState.status === "pending" &&
      primaryLocalPlayerId != null &&
      rematchState.offerer === primaryLocalPlayerId;

    const canPropose =
      !isReadOnlyView &&
      isMultiplayerMatch &&
      (rematchState.status === "idle" || rematchState.status === "declined");

    const spectatorFollowHandler =
      canFollowSpectatorRematch && handleFollowSpectatorRematch
        ? handleFollowSpectatorRematch
        : undefined;

    return (
      <div className={`${barClass} relative gap-2 py-1`} style={{ minHeight: "40px" }}>
        {/* Centered result text */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Trophy className="w-4 h-4 text-yellow-500 shrink-0 mr-1.5" />
          <span className="text-xs font-medium truncate">
            {resultHeadline}
            {resultDetail ? ` - ${resultDetail}` : ""}
          </span>
        </div>
        {/* Action buttons on the right */}
        <div className="flex-1" />
        <div className="flex gap-1 shrink-0 z-10">
          {isReadOnlyView ? (
            spectatorFollowHandler && spectatorRematchGameId ? (
              <Button size="sm" className="h-7 px-2 text-[10px]" onClick={spectatorFollowHandler}>
                Watch
              </Button>
            ) : null
          ) : (
            <>
              {canPropose && (
                <Button size="sm" className="h-7 px-2 text-[10px]" onClick={handleProposeRematch}>
                  Rematch
                </Button>
              )}
              {isOutgoingOffer && (
                <Button size="sm" className="h-7 px-2 text-[10px]" disabled>
                  Proposed...
                </Button>
              )}
              {((rematchState.status === "pending" && !isMultiplayerMatch) || isIncomingOffer) && (
                <>
                  <Button
                    size="sm"
                    className="h-7 px-2 text-[10px]"
                    onClick={handleAcceptRematch}
                    disabled={userRematchResponse === "accepted"}
                  >
                    {userRematchResponse === "accepted" ? "OK" : "Accept"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[10px]"
                    onClick={handleDeclineRematch}
                    disabled={userRematchResponse === "declined"}
                  >
                    No
                  </Button>
                </>
              )}
              {rematchState.status === "starting" && (
                <span className="text-[10px] animate-pulse text-primary font-medium">Starting...</span>
              )}
            </>
          )}
          <Button size="sm" variant="ghost" className="h-7 px-1.5 text-[10px]" onClick={handleExitAfterMatch}>
            <LogOut className="w-3 h-3" />
          </Button>
        </div>
      </div>
    );
  }

  // ── Resign confirmation ──
  if (resignFlowPlayerId) {
    return (
      <div className={`${barClass} gap-2 py-1`} style={{ minHeight: "40px" }}>
        <span className="text-xs text-muted-foreground">Resign?</span>
        <div className="flex-1" />
        <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={handleCancelResign}>
          Cancel
        </Button>
        <Button size="sm" variant="destructive" className="h-7 px-2 text-[10px]" onClick={handleConfirmResign}>
          Resign
        </Button>
      </div>
    );
  }

  // ── Incoming draw/takeback decision ──
  if (drawDecisionPrompt) {
    return (
      <div className={`${barClass} gap-2 py-1`} style={{ minHeight: "40px" }}>
        <Handshake className="w-4 h-4 text-primary shrink-0" />
        <span className="text-xs truncate">Draw offer</span>
        <div className="flex-1" />
        <Button size="sm" className="h-7 px-2 text-[10px]" onClick={() => respondToDrawPrompt("accept")}>
          Accept
        </Button>
        <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => respondToDrawPrompt("reject")}>
          Decline
        </Button>
      </div>
    );
  }

  if (takebackDecisionPrompt) {
    return (
      <div className={`${barClass} gap-2 py-1`} style={{ minHeight: "40px" }}>
        <RotateCcw className="w-4 h-4 shrink-0" />
        <span className="text-xs truncate">Takeback request</span>
        <div className="flex-1" />
        <Button size="sm" className="h-7 px-2 text-[10px]" onClick={() => respondToTakebackPrompt("allow")}>
          Allow
        </Button>
        <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => respondToTakebackPrompt("decline")}>
          Decline
        </Button>
      </div>
    );
  }

  // ── Incoming passive notice ──
  if (incomingPassiveNotice && !isReadOnlyView) {
    return (
      <div className={`${barClass} gap-2 py-1`} style={{ minHeight: "40px" }}>
        <span className="text-xs truncate">{incomingPassiveNotice.message}</span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" className="h-7 px-1.5 text-[10px]" onClick={handleDismissIncomingNotice}>
          <X className="w-3 h-3" />
        </Button>
      </div>
    );
  }

  // ── Pending outgoing offers ──
  if (pendingDrawForLocal && pendingDrawOffer) {
    return (
      <div className={`${barClass} gap-2 py-1`} style={{ minHeight: "40px" }}>
        <Handshake className="w-4 h-4 shrink-0" />
        <span className="text-xs truncate">Draw offered...</span>
        <div className="flex-1" />
        {canCancelDrawOffer !== null && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[10px]"
            onClick={handleCancelDrawOffer}
            disabled={!canCancelDrawOffer}
          >
            Cancel
          </Button>
        )}
      </div>
    );
  }

  if (takebackPendingForLocal && pendingTakebackRequest) {
    return (
      <div className={`${barClass} gap-2 py-1`} style={{ minHeight: "40px" }}>
        <RotateCcw className="w-4 h-4 shrink-0" />
        <span className="text-xs truncate">Takeback requested...</span>
        <div className="flex-1" />
        {canCancelTakebackRequest !== null && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[10px]"
            onClick={handleCancelTakebackRequest}
            disabled={!canCancelTakebackRequest}
          >
            Cancel
          </Button>
        )}
      </div>
    );
  }

  // ── Default: action buttons ──
  return (
    <div className={`${barClass} gap-3 py-1`} style={{ minHeight: "40px" }}>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={handleStartResign}
        disabled={actionsDisabled}
        title="Resign"
      >
        <Flag className="w-4 h-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={handleOfferDraw}
        disabled={actionsDisabled || manualActionsBlocked || Boolean(pendingDrawOffer)}
        title="Offer Draw"
      >
        <Handshake className="w-4 h-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={handleRequestTakeback}
        disabled={
          actionsDisabled ||
          manualActionsBlocked ||
          Boolean(pendingTakebackRequest) ||
          !hasTakebackHistory
        }
        title="Request Takeback"
      >
        <RotateCcw className="w-4 h-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={handleGiveTime}
        disabled={actionsDisabled || manualActionsBlocked || isUnlimited}
        title="Give Time"
      >
        <Timer className="w-4 h-4" />
      </Button>
    </div>
  );
}
