import { useState, useRef, useCallback, useEffect } from "react";
import type { PlayerId } from "../../../shared/domain/game-types";
import type { GameState } from "../../../shared/domain/game-state";
import type {
  DrawDecision,
  GamePlayerController,
  ManualPlayerController,
  TakebackDecision,
} from "@/lib/player-controllers";
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
  historyLengthAtRequest: number;
}

type DecisionPromptSource = "local" | "remote";

export interface DrawDecisionPromptState {
  from: PlayerId;
  to: PlayerId;
  controller?: ManualPlayerController;
  source: DecisionPromptSource;
}

export interface TakebackDecisionPromptState {
  requester: PlayerId;
  responder: PlayerId;
  controller?: ManualPlayerController;
  source: DecisionPromptSource;
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
  // Game instance identifier (changes when a new game starts)
  gameInstanceId: number;

  // Game state
  gameState: GameState | null;
  gameStateRef: React.MutableRefObject<GameState | null>;
  primaryLocalPlayerId: PlayerId | null;
  autoAcceptingLocalIds: PlayerId[];
  isMultiplayerMatch: boolean;

  // Controllers
  playerControllersRef: React.MutableRefObject<
    Partial<
      Record<PlayerId, import("@/lib/player-controllers").GamePlayerController>
    >
  >;
  getSeatController: (playerId: PlayerId | null) => GamePlayerController | null;

  // Actions
  performGameAction: (
    action: import("../../../shared/domain/game-types").GameAction,
  ) => GameState;
  updateGameState: (
    nextState: GameState,
    options?: { lastMoves?: BoardProps["lastMoves"] | null },
  ) => void;
  computeLastMoves: (
    state: GameState,
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
  gameInstanceId,
  gameState,
  gameStateRef,
  primaryLocalPlayerId,
  autoAcceptingLocalIds,
  isMultiplayerMatch,
  playerControllersRef,
  getSeatController,
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
  const previousTimeLeftRef = useRef<Record<PlayerId, number> | null>(null);

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

      const lastMoves = computeLastMoves(nextState, playerColorsForBoard);
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
      const seatController = getSeatController(actorId);
      if (!seatController || typeof seatController.resign !== "function") {
        setActionError("Connection unavailable.");
      } else {
        void seatController.resign();
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
    isMultiplayerMatch,
    resignFlowPlayerId,
    resolvePrimaryActionPlayerId,
    performGameAction,
    addSystemMessage,
    getPlayerName,
    setActionError,
    getSeatController,
  ]);

  // Draw offer handlers
  const handleOfferDraw = useCallback(() => {
    const actorId = resolvePrimaryActionPlayerId();
    if (!actorId) {
      setActionError("You need to control a player to offer a draw.");
      return;
    }
    const opponentId: PlayerId = actorId === 1 ? 2 : 1;
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

    const actorController = getSeatController(actorId);
    if (isMultiplayerMatch) {
      if (!actorController || typeof actorController.offerDraw !== "function") {
        setActionError("Connection unavailable.");
        return;
      }
    }

    const opponentController = playerControllersRef.current[opponentId];
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
    if (isMultiplayerMatch) {
      void actorController?.offerDraw?.();
      return;
    }
    if (!opponentController || !isSupportedController(opponentController)) {
      setActionError("This opponent cannot respond to draw offers yet.");
      return;
    }
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
        source: "local",
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
    getSeatController,
  ]);

  const handleCancelDrawOffer = useCallback(() => {
    if (!pendingDrawOffer) return;
    if (isMultiplayerMatch) {
      setActionError("Draw offers cannot be cancelled in online games.");
      return;
    }
    const canCancel =
      Date.now() - pendingDrawOffer.createdAt >= CANCEL_COOLDOWN_MS &&
      pendingDrawOffer.status === "pending";
    if (!canCancel) return;
    drawOfferRequestIdRef.current++;
    setPendingDrawOffer(null);
    addSystemMessage("You cancelled your draw offer.");
  }, [pendingDrawOffer, addSystemMessage, isMultiplayerMatch, setActionError]);

  const respondToDrawPrompt = useCallback(
    (decision: DrawDecision) => {
      if (!drawDecisionPrompt) return;
      if (drawDecisionPrompt.controller) {
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
        return;
      }

      if (!isMultiplayerMatch) {
        setActionError("Connection unavailable.");
        return;
      }
      const responderController = getSeatController(drawDecisionPrompt.to);
      if (
        !responderController ||
        typeof responderController.respondToRemoteDraw !== "function"
      ) {
        setActionError("Connection unavailable.");
        return;
      }
      void responderController.respondToRemoteDraw(decision);
      addSystemMessage(
        decision === "accept"
          ? `${getPlayerName(drawDecisionPrompt.to)} accepted the draw offer.`
          : `${getPlayerName(drawDecisionPrompt.to)} declined the draw offer.`,
      );
      setDrawDecisionPrompt(null);
    },
    [
      drawDecisionPrompt,
      setActionError,
      isMultiplayerMatch,
      addSystemMessage,
      getPlayerName,
      getSeatController,
    ],
  );

  // Takeback handlers
  const handleRequestTakeback = useCallback(() => {
    const requesterId = resolvePrimaryActionPlayerId();
    if (!requesterId) {
      setActionError("You need to control a player to request a takeback.");
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
    const historyLengthAtRequest = currentState.history.length;
    const requesterController = getSeatController(requesterId);
    if (isMultiplayerMatch) {
      if (
        !requesterController ||
        typeof requesterController.requestTakeback !== "function"
      ) {
        setActionError("Connection unavailable.");
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
        historyLengthAtRequest,
      });
      addSystemMessage(
        `${getPlayerName(requesterId)} requested a takeback from ${getPlayerName(
          responderId,
        )}.`,
      );
      void requesterController.requestTakeback?.();
      return;
    }
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
      historyLengthAtRequest,
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
        source: "local",
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
    getSeatController,
  ]);

  const handleCancelTakebackRequest = useCallback(() => {
    if (!pendingTakebackRequest) return;
    if (isMultiplayerMatch) {
      setActionError("Takeback requests cannot be cancelled in online games.");
      return;
    }
    const canCancel =
      Date.now() - pendingTakebackRequest.createdAt >= CANCEL_COOLDOWN_MS &&
      pendingTakebackRequest.status === "pending";
    if (!canCancel) return;
    takebackRequestIdRef.current++;
    setPendingTakebackRequest(null);
    addSystemMessage("You cancelled your takeback request.");
  }, [
    pendingTakebackRequest,
    addSystemMessage,
    isMultiplayerMatch,
    setActionError,
  ]);

  const respondToTakebackPrompt = useCallback(
    (decision: TakebackDecision) => {
      if (!takebackDecisionPrompt) return;
      if (takebackDecisionPrompt.controller) {
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
        return;
      }

      if (!isMultiplayerMatch) {
        setActionError("Connection unavailable.");
        return;
      }
      const responderController = getSeatController(
        takebackDecisionPrompt.responder,
      );
      if (
        !responderController ||
        typeof responderController.respondToRemoteTakeback !== "function"
      ) {
        setActionError("Connection unavailable.");
        return;
      }
      void responderController.respondToRemoteTakeback(decision);
      addSystemMessage(
        decision === "allow"
          ? `${getPlayerName(takebackDecisionPrompt.responder)} accepted the takeback request.`
          : `${getPlayerName(takebackDecisionPrompt.responder)} declined the takeback request.`,
      );
      setTakebackDecisionPrompt(null);
    },
    [
      takebackDecisionPrompt,
      setActionError,
      isMultiplayerMatch,
      addSystemMessage,
      getPlayerName,
      getSeatController,
    ],
  );

  // Give time handler
  const handleGiveTime = useCallback(() => {
    const giverId = resolvePrimaryActionPlayerId();
    if (!giverId) {
      setActionError("You need to control a player to give time.");
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
    if (isMultiplayerMatch) {
      const giverController = getSeatController(giverId);
      if (!giverController || typeof giverController.giveTime !== "function") {
        setActionError("Connection unavailable.");
        return;
      }
      try {
        void giverController.giveTime(60);
        setOutgoingTimeInfo({
          id: ++noticeCounterRef.current,
          message: `You gave ${getPlayerName(opponentId)} 1:00.`,
          createdAt: Date.now(),
        });
        addSystemMessage(
          `${getPlayerName(giverId)} gave ${getPlayerName(opponentId)} one minute.`,
        );
      } catch (error) {
        console.error(error);
        setActionError("Unable to adjust the clocks right now.");
      }
      return;
    }
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
    getSeatController,
  ]);

  const handleIncomingDrawOffer = useCallback(
    (playerId: PlayerId) => {
      if (!isMultiplayerMatch) return;
      const recipientId: PlayerId = playerId === 1 ? 2 : 1;
      if (primaryLocalPlayerId !== recipientId) return;
      setDrawDecisionPrompt({
        from: playerId,
        to: recipientId,
        source: "remote",
      });
      setActionError(null);
      addSystemMessage(`${getPlayerName(playerId)} offered a draw.`);
    },
    [
      isMultiplayerMatch,
      primaryLocalPlayerId,
      addSystemMessage,
      getPlayerName,
      setActionError,
    ],
  );

  const handleIncomingDrawRejected = useCallback(
    (playerId: PlayerId) => {
      if (!isMultiplayerMatch) return;
      if (playerId === primaryLocalPlayerId) {
        return;
      }
      if (
        pendingDrawOffer?.from === primaryLocalPlayerId &&
        pendingDrawOffer.to === playerId
      ) {
        setPendingDrawOffer(null);
      }
      addSystemMessage(`${getPlayerName(playerId)} declined the draw offer.`);
    },
    [
      isMultiplayerMatch,
      pendingDrawOffer,
      primaryLocalPlayerId,
      addSystemMessage,
      getPlayerName,
    ],
  );

  const handleIncomingTakebackOffer = useCallback(
    (playerId: PlayerId) => {
      if (!isMultiplayerMatch) return;
      const responderId: PlayerId = playerId === 1 ? 2 : 1;
      if (primaryLocalPlayerId !== responderId) return;
      setTakebackDecisionPrompt({
        requester: playerId,
        responder: responderId,
        source: "remote",
      });
      setActionError(null);
      addSystemMessage(`${getPlayerName(playerId)} requested a takeback.`);
    },
    [
      isMultiplayerMatch,
      primaryLocalPlayerId,
      addSystemMessage,
      getPlayerName,
      setActionError,
    ],
  );

  const handleIncomingTakebackRejected = useCallback(
    (playerId: PlayerId) => {
      if (!isMultiplayerMatch) return;
      if (playerId === primaryLocalPlayerId) {
        return;
      }
      if (
        pendingTakebackRequest?.requester === primaryLocalPlayerId &&
        pendingTakebackRequest.responder === playerId
      ) {
        setPendingTakebackRequest(null);
      }
      addSystemMessage(
        `${getPlayerName(playerId)} declined the takeback request.`,
      );
    },
    [
      isMultiplayerMatch,
      pendingTakebackRequest,
      primaryLocalPlayerId,
      addSystemMessage,
      getPlayerName,
    ],
  );

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

  // Effect: Reset meta game state when game instance changes
  useEffect(() => {
    setPendingDrawOffer(null);
    setPendingTakebackRequest(null);
    setDrawDecisionPrompt(null);
    setTakebackDecisionPrompt(null);
    setResignFlowPlayerId(null);
    setIncomingPassiveNotice(null);
    setOutgoingTimeInfo(null);
    lastResignedPlayerRef.current = null;
    drawOfferRequestIdRef.current = 0;
    takebackRequestIdRef.current = 0;
    noticeCounterRef.current = 0;
  }, [gameInstanceId]);

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

  useEffect(() => {
    if (
      !isMultiplayerMatch ||
      !pendingDrawOffer ||
      gameState?.status !== "finished" ||
      gameState?.result?.reason !== "draw-agreement"
    ) {
      return;
    }
    addSystemMessage(
      `${getPlayerName(pendingDrawOffer.to)} accepted the draw offer.`,
    );
    setPendingDrawOffer(null);
  }, [
    isMultiplayerMatch,
    pendingDrawOffer,
    gameState?.status,
    gameState?.result?.reason,
    addSystemMessage,
    getPlayerName,
  ]);

  useEffect(() => {
    if (
      !isMultiplayerMatch ||
      pendingTakebackRequest?.requester !== primaryLocalPlayerId ||
      !gameState
    ) {
      return;
    }
    const historyLength = gameState.history.length;
    if (historyLength < pendingTakebackRequest.historyLengthAtRequest) {
      addSystemMessage(
        `${getPlayerName(pendingTakebackRequest.responder)} accepted the takeback request.`,
      );
      setPendingTakebackRequest(null);
    }
  }, [
    isMultiplayerMatch,
    pendingTakebackRequest,
    gameState,
    gameState?.history.length,
    addSystemMessage,
    getPlayerName,
    primaryLocalPlayerId,
  ]);

  useEffect(() => {
    if (!gameState) {
      previousTimeLeftRef.current = null;
      return;
    }
    if (!isMultiplayerMatch || !primaryLocalPlayerId) {
      previousTimeLeftRef.current = { ...gameState.timeLeft };
      return;
    }
    const prev = previousTimeLeftRef.current;
    previousTimeLeftRef.current = { ...gameState.timeLeft };
    if (!prev) return;
    const diff =
      gameState.timeLeft[primaryLocalPlayerId] - prev[primaryLocalPlayerId];
    if (diff >= 55) {
      const opponentId: PlayerId = primaryLocalPlayerId === 1 ? 2 : 1;
      setIncomingPassiveNotice({
        id: ++noticeCounterRef.current,
        type: "opponent-gave-time",
        message: `${getPlayerName(opponentId)} gave you 1:00.`,
      });
    }
  }, [
    gameState,
    isMultiplayerMatch,
    primaryLocalPlayerId,
    getPlayerName,
    setIncomingPassiveNotice,
  ]);

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
    handleIncomingDrawOffer,
    handleIncomingDrawRejected,
    handleIncomingTakebackOffer,
    handleIncomingTakebackRejected,
  };
}
