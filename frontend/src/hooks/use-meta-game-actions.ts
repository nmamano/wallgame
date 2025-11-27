import { useState, useRef, useCallback, useEffect } from "react";
import type { PlayerId } from "../../../shared/game-types";
import type { GameState } from "../../../shared/game-state";
import type { LocalPlayerController } from "@/lib/player-controllers";
import type { DrawDecision, TakebackDecision } from "@/lib/player-controllers";
import {
  isLocalController,
  isSupportedController,
} from "@/lib/player-controllers";
import type { BoardProps } from "@/components/board";

export interface PendingDrawOfferState {
  from: PlayerId;
  to: PlayerId;
  requestId: number;
  status: "pending";
  createdAt: number;
}

export interface PendingTakebackRequestState {
  requester: PlayerId;
  responder: PlayerId;
  requestId: number;
  status: "pending";
  createdAt: number;
}

export interface DrawDecisionPromptState {
  from: PlayerId;
  to: PlayerId;
  controller: LocalPlayerController;
}

export interface TakebackDecisionPromptState {
  requester: PlayerId;
  responder: PlayerId;
  controller: LocalPlayerController;
}

export interface PassiveNotice {
  id: number;
  type: "opponent-resigned" | "opponent-gave-time";
  message: string;
}

export interface OutgoingTimeInfo {
  id: number;
  message: string;
  createdAt: number;
}

interface UseMetaGameActionsParams {
  // Game state
  gameState: GameState | null;
  gameStateRef: React.MutableRefObject<GameState | null>;
  primaryLocalPlayerId: PlayerId | null;
  autoAcceptingLocalIds: PlayerId[];
  isMultiplayerMatch: boolean;
  matchReadyForPlay: boolean;
  clockTick: number;

  // Controllers
  playerControllersRef: React.MutableRefObject<
    Partial<
      Record<PlayerId, import("@/lib/player-controllers").GamePlayerController>
    >
  >;

  // Game client (for multiplayer)
  gameClientRef: React.MutableRefObject<
    import("@/lib/game-client").GameClient | null
  >;

  // Actions
  performGameAction: (
    action: import("../../../shared/game-types").GameAction,
  ) => GameState;
  updateGameState: (
    nextState: GameState,
    options?: { lastMoves?: BoardProps["lastMoves"] | null },
  ) => void;
  computeLastMoves: (
    before: GameState,
    after: GameState,
    playerColorsForBoard: Record<
      PlayerId,
      import("@/lib/player-colors").PlayerColor
    >,
  ) => BoardProps["lastMoves"] | null;
  playerColorsForBoard: Record<
    PlayerId,
    import("@/lib/player-colors").PlayerColor
  >;

  // UI callbacks
  addSystemMessage: (text: string) => void;
  getPlayerName: (playerId: PlayerId) => string;
  setActionError: (error: string | null) => void;
  resolvePrimaryActionPlayerId: () => PlayerId | null;

  // Staging cleanup (for takeback)
  clearStaging?: () => void;
}

// Constants
const CANCEL_COOLDOWN_MS = 2000;
const AUTO_ACCEPT_DELAY_MS = 300;

export function useMetaGameActions({
  gameState,
  gameStateRef,
  primaryLocalPlayerId,
  autoAcceptingLocalIds,
  isMultiplayerMatch,
  matchReadyForPlay,
  playerControllersRef,
  gameClientRef,
  performGameAction,
  updateGameState,
  computeLastMoves,
  playerColorsForBoard,
  addSystemMessage,
  getPlayerName,
  setActionError,
  resolvePrimaryActionPlayerId,
  clearStaging,
}: UseMetaGameActionsParams) {
  // State
  const [pendingDrawOffer, setPendingDrawOffer] =
    useState<PendingDrawOfferState | null>(null);
  const [pendingTakebackRequest, setPendingTakebackRequest] =
    useState<PendingTakebackRequestState | null>(null);
  const [drawDecisionPrompt, setDrawDecisionPrompt] =
    useState<DrawDecisionPromptState | null>(null);
  const [takebackDecisionPrompt, setTakebackDecisionPrompt] =
    useState<TakebackDecisionPromptState | null>(null);
  const [resignFlowPlayerId, setResignFlowPlayerId] = useState<PlayerId | null>(
    null,
  );
  const [incomingPassiveNotice, setIncomingPassiveNotice] =
    useState<PassiveNotice | null>(null);
  const [outgoingTimeInfo, setOutgoingTimeInfo] =
    useState<OutgoingTimeInfo | null>(null);

  // Refs
  const drawOfferRequestIdRef = useRef(0);
  const takebackRequestIdRef = useRef(0);
  const lastResignedPlayerRef = useRef<PlayerId | null>(null);
  const noticeCounterRef = useRef(0);

  // Execute takeback
  const executeTakeback = useCallback(
    (requesterId: PlayerId) => {
      const currentState = gameStateRef.current;
      if (!currentState) {
        setActionError("Game is still loading");
        return false;
      }
      if (currentState.history.length === 0) {
        setActionError("There are no moves to take back yet.");
        return false;
      }
      const stepsNeeded = currentState.turn === requesterId ? 2 : 1;
      if (currentState.history.length < stepsNeeded) {
        setActionError("Not enough moves have been played for a takeback.");
        return false;
      }
      let nextState = currentState;
      for (let i = 0; i < stepsNeeded; i++) {
        nextState = nextState.applyGameAction({
          kind: "takeback",
          playerId: requesterId,
          timestamp: Date.now(),
        });
      }

      // After takeback, if there's still history, show arrow for the now-last move
      let lastMoves: BoardProps["lastMoves"] | null = null;
      if (nextState.history.length > 0) {
        // Temporarily undo one more move to get the "before" state for the last move
        const beforeLastMove = nextState.applyGameAction({
          kind: "takeback",
          playerId: requesterId,
          timestamp: Date.now(),
        });
        lastMoves = computeLastMoves(
          beforeLastMove,
          nextState,
          playerColorsForBoard,
        );
      }

      updateGameState(nextState, { lastMoves });
      if (clearStaging) {
        clearStaging();
      }
      return true;
    },
    [
      gameStateRef,
      setActionError,
      computeLastMoves,
      updateGameState,
      playerColorsForBoard,
      clearStaging,
    ],
  );

  // Resign handlers
  const handleStartResign = useCallback(() => {
    const actorId = resolvePrimaryActionPlayerId();
    if (!actorId) {
      setActionError("You need to control a player to resign.");
      return;
    }
    setResignFlowPlayerId(actorId);
    setActionError(null);
  }, [resolvePrimaryActionPlayerId, setActionError]);

  const handleCancelResign = useCallback(() => {
    setResignFlowPlayerId(null);
  }, []);

  const handleConfirmResign = useCallback(() => {
    const actorId = resignFlowPlayerId ?? resolvePrimaryActionPlayerId();
    if (!actorId) {
      setActionError("You need to control a player to resign.");
      setResignFlowPlayerId(null);
      return;
    }
    if (isMultiplayerMatch) {
      if (!matchReadyForPlay || !gameClientRef.current) {
        setActionError("Connection unavailable.");
      } else {
        gameClientRef.current.sendResign();
      }
      setResignFlowPlayerId(null);
      return;
    }
    try {
      lastResignedPlayerRef.current = actorId;
      performGameAction({
        kind: "resign",
        playerId: actorId,
        timestamp: Date.now(),
      });
      addSystemMessage(`${getPlayerName(actorId)} resigned.`);
    } catch (error) {
      console.error(error);
      setActionError(
        error instanceof Error ? error.message : "Unable to resign the game.",
      );
    } finally {
      setResignFlowPlayerId(null);
    }
  }, [
    matchReadyForPlay,
    isMultiplayerMatch,
    resignFlowPlayerId,
    resolvePrimaryActionPlayerId,
    performGameAction,
    addSystemMessage,
    getPlayerName,
    setActionError,
    gameClientRef,
  ]);

  // Draw offer handlers
  const handleOfferDraw = useCallback(() => {
    const actorId = resolvePrimaryActionPlayerId();
    if (!actorId) {
      setActionError("You need to control a player to offer a draw.");
      return;
    }
    if (isMultiplayerMatch) {
      setActionError("Draw offers are not available in friend games yet.");
      return;
    }
    const currentState = gameStateRef.current;
    if (!currentState) {
      setActionError("Game is still loading.");
      return;
    }
    if (currentState.status !== "playing") {
      setActionError("Draw offers are only available during active games.");
      return;
    }
    if (pendingDrawOffer) {
      setActionError("You already have a draw offer pending.");
      return;
    }
    const opponentId: PlayerId = actorId === 1 ? 2 : 1;
    const opponentController = playerControllersRef.current[opponentId];
    if (!opponentController || !isSupportedController(opponentController)) {
      setActionError("This opponent cannot respond to draw offers yet.");
      return;
    }
    const requestId = ++drawOfferRequestIdRef.current;
    setActionError(null);
    setPendingDrawOffer({
      from: actorId,
      to: opponentId,
      status: "pending",
      createdAt: Date.now(),
      requestId,
    });
    addSystemMessage(
      `${getPlayerName(actorId)} offered a draw to ${getPlayerName(
        opponentId,
      )}.`,
    );
    const shouldAutoAccept = autoAcceptingLocalIds.includes(opponentId);
    const responsePromise = shouldAutoAccept
      ? new Promise<DrawDecision>((resolve) =>
          window.setTimeout(() => resolve("accept"), AUTO_ACCEPT_DELAY_MS),
        )
      : opponentController.respondToDrawOffer({
          state: currentState.clone(),
          playerId: opponentId,
          opponentId: actorId,
          offeredBy: actorId,
        });
    const shouldShowPrompt =
      isLocalController(opponentController) &&
      opponentId === primaryLocalPlayerId &&
      !shouldAutoAccept;
    if (shouldShowPrompt) {
      setDrawDecisionPrompt({
        from: actorId,
        to: opponentId,
        controller: opponentController,
      });
    }
    responsePromise
      .then((decision) => {
        if (drawOfferRequestIdRef.current !== requestId) return;
        if (decision === "accept") {
          try {
            performGameAction({
              kind: "draw",
              playerId: opponentId,
              timestamp: Date.now(),
            });
            addSystemMessage(
              `${getPlayerName(opponentId)} accepted the draw offer.`,
            );
          } catch (error) {
            console.error(error);
            setActionError(
              error instanceof Error
                ? error.message
                : "Unable to convert the draw offer into a result.",
            );
          }
        } else {
          addSystemMessage(
            `${getPlayerName(opponentId)} declined the draw offer.`,
          );
        }
      })
      .catch((error) => {
        if (drawOfferRequestIdRef.current !== requestId) return;
        console.error(error);
        setActionError(
          error instanceof Error
            ? error.message
            : "The draw offer could not be processed.",
        );
      })
      .finally(() => {
        if (drawOfferRequestIdRef.current === requestId) {
          setPendingDrawOffer(null);
          if (shouldShowPrompt) {
            setDrawDecisionPrompt(null);
          }
        }
      });
  }, [
    resolvePrimaryActionPlayerId,
    pendingDrawOffer,
    performGameAction,
    addSystemMessage,
    getPlayerName,
    autoAcceptingLocalIds,
    primaryLocalPlayerId,
    isMultiplayerMatch,
    gameStateRef,
    playerControllersRef,
    setActionError,
  ]);

  const handleCancelDrawOffer = useCallback(() => {
    if (!pendingDrawOffer) return;
    const canCancel =
      Date.now() - pendingDrawOffer.createdAt >= CANCEL_COOLDOWN_MS &&
      pendingDrawOffer.status === "pending";
    if (!canCancel) return;
    drawOfferRequestIdRef.current++;
    setPendingDrawOffer(null);
    addSystemMessage("You cancelled your draw offer.");
  }, [pendingDrawOffer, addSystemMessage]);

  const respondToDrawPrompt = useCallback(
    (decision: DrawDecision) => {
      if (!drawDecisionPrompt) return;
      try {
        drawDecisionPrompt.controller.submitDrawDecision(decision);
        setDrawDecisionPrompt(null);
      } catch (error) {
        console.error(error);
        setActionError(
          error instanceof Error
            ? error.message
            : "Unable to respond to the draw offer.",
        );
      }
    },
    [drawDecisionPrompt, setActionError],
  );

  // Takeback handlers
  const handleRequestTakeback = useCallback(() => {
    const requesterId = resolvePrimaryActionPlayerId();
    if (!requesterId) {
      setActionError("You need to control a player to request a takeback.");
      return;
    }
    if (isMultiplayerMatch) {
      setActionError("Takebacks are not available in friend games yet.");
      return;
    }
    const currentState = gameStateRef.current;
    if (!currentState) {
      setActionError("Game is still loading.");
      return;
    }
    if (currentState.history.length === 0) {
      setActionError("There are no moves to take back yet.");
      return;
    }
    if (pendingTakebackRequest) {
      setActionError("A takeback request is already pending.");
      return;
    }
    const responderId: PlayerId = requesterId === 1 ? 2 : 1;
    const responderController = playerControllersRef.current[responderId];
    if (!responderController || !isSupportedController(responderController)) {
      setActionError("This opponent cannot respond to takeback requests yet.");
      return;
    }
    const requestId = ++takebackRequestIdRef.current;
    setActionError(null);
    setPendingTakebackRequest({
      requester: requesterId,
      responder: responderId,
      status: "pending",
      createdAt: Date.now(),
      requestId,
    });
    addSystemMessage(
      `${getPlayerName(requesterId)} requested a takeback from ${getPlayerName(
        responderId,
      )}.`,
    );
    const shouldAutoAccept = autoAcceptingLocalIds.includes(responderId);
    const responsePromise = shouldAutoAccept
      ? new Promise<TakebackDecision>((resolve) =>
          window.setTimeout(() => resolve("allow"), AUTO_ACCEPT_DELAY_MS),
        )
      : responderController.respondToTakebackRequest({
          state: currentState.clone(),
          playerId: responderId,
          opponentId: requesterId,
          requestedBy: requesterId,
        });
    const shouldShowPrompt =
      isLocalController(responderController) &&
      responderId === primaryLocalPlayerId &&
      !shouldAutoAccept;
    if (shouldShowPrompt) {
      setTakebackDecisionPrompt({
        requester: requesterId,
        responder: responderId,
        controller: responderController,
      });
    }
    responsePromise
      .then((decision) => {
        if (takebackRequestIdRef.current !== requestId) return;
        if (decision === "allow") {
          const success = executeTakeback(requesterId);
          if (success) {
            addSystemMessage(
              `${getPlayerName(responderId)} accepted the takeback request.`,
            );
          }
        } else {
          addSystemMessage(
            `${getPlayerName(responderId)} declined the takeback request.`,
          );
        }
      })
      .catch((error) => {
        if (takebackRequestIdRef.current !== requestId) return;
        console.error(error);
        setActionError(
          error instanceof Error
            ? error.message
            : "The takeback request could not be processed.",
        );
      })
      .finally(() => {
        if (takebackRequestIdRef.current === requestId) {
          setPendingTakebackRequest(null);
          if (shouldShowPrompt) {
            setTakebackDecisionPrompt(null);
          }
        }
      });
  }, [
    resolvePrimaryActionPlayerId,
    pendingTakebackRequest,
    executeTakeback,
    addSystemMessage,
    getPlayerName,
    autoAcceptingLocalIds,
    primaryLocalPlayerId,
    isMultiplayerMatch,
    gameStateRef,
    playerControllersRef,
    setActionError,
  ]);

  const handleCancelTakebackRequest = useCallback(() => {
    if (!pendingTakebackRequest) return;
    const canCancel =
      Date.now() - pendingTakebackRequest.createdAt >= CANCEL_COOLDOWN_MS &&
      pendingTakebackRequest.status === "pending";
    if (!canCancel) return;
    takebackRequestIdRef.current++;
    setPendingTakebackRequest(null);
    addSystemMessage("You cancelled your takeback request.");
  }, [pendingTakebackRequest, addSystemMessage]);

  const respondToTakebackPrompt = useCallback(
    (decision: TakebackDecision) => {
      if (!takebackDecisionPrompt) return;
      try {
        takebackDecisionPrompt.controller.submitTakebackDecision(decision);
        setTakebackDecisionPrompt(null);
      } catch (error) {
        console.error(error);
        setActionError(
          error instanceof Error
            ? error.message
            : "Unable to respond to the takeback request.",
        );
      }
    },
    [takebackDecisionPrompt, setActionError],
  );

  // Give time handler
  const handleGiveTime = useCallback(() => {
    const giverId = resolvePrimaryActionPlayerId();
    if (!giverId) {
      setActionError("You need to control a player to give time.");
      return;
    }
    if (isMultiplayerMatch) {
      setActionError("Manual time adjustments are disabled in friend games.");
      return;
    }
    const currentState = gameStateRef.current;
    if (!currentState) {
      setActionError("Game is still loading.");
      return;
    }
    if (currentState.status !== "playing") {
      setActionError("You can only adjust clocks during an active game.");
      return;
    }
    const opponentId: PlayerId = giverId === 1 ? 2 : 1;
    try {
      performGameAction({
        kind: "giveTime",
        playerId: giverId,
        seconds: 60,
        timestamp: Date.now(),
      });
      addSystemMessage(
        `${getPlayerName(giverId)} gave ${getPlayerName(
          opponentId,
        )} one minute.`,
      );
    } catch (error) {
      console.error(error);
      setActionError(
        error instanceof Error
          ? error.message
          : "Unable to adjust the clocks right now.",
      );
    }
  }, [
    resolvePrimaryActionPlayerId,
    performGameAction,
    addSystemMessage,
    getPlayerName,
    isMultiplayerMatch,
    gameStateRef,
    setActionError,
  ]);

  // Notice handlers
  const handleDismissIncomingNotice = useCallback(() => {
    setIncomingPassiveNotice(null);
  }, []);

  const handleDismissOutgoingInfo = useCallback(() => {
    setOutgoingTimeInfo(null);
  }, []);

  // Effect: Watch for resignation notices
  useEffect(() => {
    if (
      gameState?.status === "finished" &&
      gameState.result?.reason === "resignation"
    ) {
      const winner = gameState.result.winner;
      const resignedPlayer: PlayerId = winner === 1 ? 2 : 1;
      if (
        resignedPlayer &&
        resignedPlayer !== primaryLocalPlayerId &&
        resignedPlayer !== lastResignedPlayerRef.current
      ) {
        setIncomingPassiveNotice({
          id: ++noticeCounterRef.current,
          type: "opponent-resigned",
          message: `${getPlayerName(resignedPlayer)} resigned.`,
        });
      }
      lastResignedPlayerRef.current = null;
    }
  }, [
    gameState?.status,
    gameState?.result,
    primaryLocalPlayerId,
    getPlayerName,
  ]);

  // Effect: Clear meta game state when game finishes
  useEffect(() => {
    if (gameState?.status === "finished") {
      setPendingDrawOffer(null);
      setPendingTakebackRequest(null);
      setDrawDecisionPrompt(null);
      setTakebackDecisionPrompt(null);
      setResignFlowPlayerId(null);
      lastResignedPlayerRef.current = null;
    }
  }, [gameState?.status]);

  // Helper to handle giveTime action notices (called from performGameAction)
  const handleGiveTimeNotice = useCallback(
    (action: { kind: "giveTime"; playerId: PlayerId }) => {
      const recipientId: PlayerId = action.playerId === 1 ? 2 : 1;
      if (action.playerId === primaryLocalPlayerId) {
        setOutgoingTimeInfo({
          id: ++noticeCounterRef.current,
          message: `You gave ${getPlayerName(recipientId)} 1:00.`,
          createdAt: Date.now(),
        });
      } else if (recipientId === primaryLocalPlayerId) {
        setIncomingPassiveNotice({
          id: ++noticeCounterRef.current,
          type: "opponent-gave-time",
          message: `${getPlayerName(action.playerId)} gave you 1:00.`,
        });
      }
    },
    [primaryLocalPlayerId, getPlayerName],
  );

  // Reset all meta game actions (for initialization cleanup)
  const resetMetaGameActions = useCallback(() => {
    setPendingDrawOffer(null);
    setPendingTakebackRequest(null);
    setDrawDecisionPrompt(null);
    setTakebackDecisionPrompt(null);
    setResignFlowPlayerId(null);
    setIncomingPassiveNotice(null);
    setOutgoingTimeInfo(null);
  }, []);

  return {
    // State
    pendingDrawOffer,
    pendingTakebackRequest,
    drawDecisionPrompt,
    takebackDecisionPrompt,
    resignFlowPlayerId,
    incomingPassiveNotice,
    outgoingTimeInfo,

    // Handlers
    executeTakeback,
    handleStartResign,
    handleCancelResign,
    handleConfirmResign,
    handleOfferDraw,
    handleCancelDrawOffer,
    respondToDrawPrompt,
    handleRequestTakeback,
    handleCancelTakebackRequest,
    respondToTakebackPrompt,
    handleGiveTime,
    handleDismissIncomingNotice,
    handleDismissOutgoingInfo,
    handleGiveTimeNotice,

    // Reset function (for initialization cleanup)
    resetMetaGameActions,
  };
}
