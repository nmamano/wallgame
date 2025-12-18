import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { PlayerId } from "../../../shared/domain/game-types";
import type { GameState } from "../../../shared/domain/game-state";
import type {
  ActionChannel,
  ControllerResult,
  DrawDecision,
  GamePlayerController,
  ManualPlayerController,
  MetaActionKind,
  MetaActionPayload,
  TakebackDecision,
} from "@/lib/player-controllers";
import {
  controllerError,
  controllerOk,
  isLocalController,
  isSupportedController,
} from "@/lib/player-controllers";
import { describeControllerError } from "@/lib/controller-errors";
import type { BoardProps } from "@/components/board";

export interface PendingDrawOfferState {
  actorSeatId: PlayerId;
  opponentSeatId: PlayerId;
  requestId: number;
  status: "pending";
  createdAt: number;
  channel: ActionChannel;
}

export interface PendingTakebackRequestState {
  actorSeatId: PlayerId;
  opponentSeatId: PlayerId;
  requestId: number;
  status: "pending";
  createdAt: number;
  historyLengthAtRequest: number;
  channel: ActionChannel;
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

  // Controllers
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

type MetaActionResult = { status: "completed" } | { status: "started" };

interface MetaActionExecutor {
  can: (seatId: PlayerId, action: MetaActionKind) => boolean;
  run<K extends MetaActionKind>(
    seatId: PlayerId,
    action: K,
    payload: MetaActionPayload<K>,
  ): Promise<{
    result: ControllerResult<MetaActionResult>;
    channel: ActionChannel | null;
  }>;
}

interface CreateMetaActionExecutorOptions {
  getSeatController: (playerId: PlayerId | null) => GamePlayerController | null;
  performGameAction: (
    action: import("../../../shared/domain/game-types").GameAction,
  ) => GameState;
}

const META_ACTION_CAPABILITY_MAP: Record<
  MetaActionKind,
  keyof GamePlayerController["capabilities"] | null
> = {
  resign: "canMove",
  offerDraw: "canOfferDraw",
  requestTakeback: "canRequestTakeback",
  giveTime: "canMove",
};

function createMetaActionExecutor({
  getSeatController,
  performGameAction,
}: CreateMetaActionExecutorOptions): MetaActionExecutor {
  const can = (seatId: PlayerId, action: MetaActionKind) => {
    const controller = getSeatController(seatId);
    if (!controller) return false;
    const capabilityKey = META_ACTION_CAPABILITY_MAP[action];
    if (!capabilityKey) {
      return true;
    }
    return Boolean(controller.capabilities[capabilityKey]);
  };

  const run = async <K extends MetaActionKind>(
    seatId: PlayerId,
    action: K,
    payload: MetaActionPayload<K>,
  ): Promise<{
    result: ControllerResult<MetaActionResult>;
    channel: ActionChannel | null;
  }> => {
    const controller = getSeatController(seatId);
    if (!controller) {
      return {
        channel: null,
        result: controllerError({
          kind: "ControllerUnavailable",
          action,
          message: "Seat controller unavailable.",
        }),
      };
    }

    const capabilityKey = META_ACTION_CAPABILITY_MAP[action];
    if (capabilityKey && !controller.capabilities[capabilityKey]) {
      return {
        channel: controller.actionChannel,
        result: controllerError({
          kind: "NotCapable",
          action,
          message: "This seat cannot perform that action right now.",
        }),
      };
    }

    if (controller.actionChannel === "local-state") {
      const localResult = executeLocalAction(seatId, action, payload);
      return {
        channel: controller.actionChannel,
        result: wrapMetaResult(action, localResult),
      };
    }

    if (typeof controller.performVoluntaryAction !== "function") {
      return {
        channel: controller.actionChannel,
        result: controllerError({
          kind: "UnsupportedAction",
          action,
          message: "Seat cannot perform remote voluntary actions.",
        }),
      };
    }

    try {
      const remoteResult = await controller.performVoluntaryAction(
        action,
        payload,
      );
      return {
        channel: controller.actionChannel,
        result: wrapMetaResult(action, remoteResult),
      };
    } catch (error) {
      console.error(error);
      return {
        channel: controller.actionChannel,
        result: controllerError({
          kind: "Unknown",
          action,
          message:
            error instanceof Error
              ? error.message
              : "Unexpected error while executing action.",
          cause: error,
        }),
      };
    }
  };

  const executeLocalAction = <K extends MetaActionKind>(
    seatId: PlayerId,
    action: K,
    payload: MetaActionPayload<K>,
  ): ControllerResult<void> => {
    try {
      switch (action) {
        case "resign": {
          performGameAction({
            kind: "resign",
            playerId: seatId,
            timestamp: Date.now(),
          });
          return controllerOk(undefined);
        }
        case "giveTime": {
          const seconds = payload?.seconds ?? 0;
          performGameAction({
            kind: "giveTime",
            playerId: seatId,
            seconds,
            timestamp: Date.now(),
          });
          return controllerOk(undefined);
        }
        case "offerDraw":
        case "requestTakeback":
          return controllerOk(undefined);
        default:
          return controllerError({
            kind: "UnsupportedAction",
            action,
            message: "Unsupported local meta action.",
          });
      }
    } catch (error) {
      return controllerError({
        kind: "Unknown",
        action,
        message:
          error instanceof Error
            ? error.message
            : "Unexpected error while executing local action.",
        cause: error,
      });
    }
  };

  const wrapMetaResult = (
    action: MetaActionKind,
    result: ControllerResult<void>,
  ): ControllerResult<MetaActionResult> => {
    if (result.ok) {
      return controllerOk(deriveMetaActionStatus(action));
    }
    return controllerError(result.error);
  };

  return { can, run };
}

function deriveMetaActionStatus(action: MetaActionKind): MetaActionResult {
  switch (action) {
    case "offerDraw":
    case "requestTakeback":
      return { status: "started" };
    default:
      return { status: "completed" };
  }
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

  const metaActionExecutor = useMemo(
    () =>
      createMetaActionExecutor({
        getSeatController,
        performGameAction,
      }),
    [getSeatController, performGameAction],
  );

  const resolveSeatChannel = useCallback(
    (playerId: PlayerId | null): ActionChannel | null => {
      if (playerId == null) {
        return null;
      }
      const controller = getSeatController(playerId);
      return controller?.actionChannel ?? null;
    },
    [getSeatController],
  );

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
    const controller = getSeatController(actorId);
    if (!controller) {
      setActionError(
        describeControllerError("resign", {
          kind: "ControllerUnavailable",
          action: "resign",
        }),
      );
      setResignFlowPlayerId(null);
      return;
    }
    if (!metaActionExecutor.can(actorId, "resign")) {
      setActionError("You cannot resign right now.");
      setResignFlowPlayerId(null);
      return;
    }
    if (controller.actionChannel === "local-state") {
      lastResignedPlayerRef.current = actorId;
    }
    void metaActionExecutor
      .run(actorId, "resign", undefined)
      .then(({ channel, result }) => {
        if (!result.ok) {
          setActionError(describeControllerError("resign", result.error));
          return;
        }
        if (channel === "local-state") {
          addSystemMessage(`${getPlayerName(actorId)} resigned.`);
        }
      })
      .catch((error) => {
        console.error(error);
        setActionError(
          error instanceof Error ? error.message : "Unable to resign the game.",
        );
      })
      .finally(() => {
        setResignFlowPlayerId(null);
      });
  }, [
    resignFlowPlayerId,
    resolvePrimaryActionPlayerId,
    getSeatController,
    metaActionExecutor,
    addSystemMessage,
    getPlayerName,
    setActionError,
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
    if (!actorController) {
      setActionError(
        describeControllerError("offerDraw", {
          kind: "ControllerUnavailable",
          action: "offerDraw",
        }),
      );
      return;
    }
    if (!metaActionExecutor.can(actorId, "offerDraw")) {
      setActionError("You cannot offer a draw right now.");
      return;
    }
    const opponentController = getSeatController(opponentId);
    const requestId = ++drawOfferRequestIdRef.current;
    const pendingEntry: PendingDrawOfferState = {
      actorSeatId: actorId,
      opponentSeatId: opponentId,
      status: "pending",
      createdAt: Date.now(),
      requestId,
      channel: actorController.actionChannel,
    };
    const announceOffer = () => {
      setPendingDrawOffer(pendingEntry);
      addSystemMessage(
        `${getPlayerName(actorId)} offered a draw to ${getPlayerName(
          opponentId,
        )}.`,
      );
    };
    setActionError(null);
    if (actorController.actionChannel === "remote-controller") {
      void metaActionExecutor
        .run(actorId, "offerDraw", undefined)
        .then(({ result }) => {
          if (!result.ok) {
            setActionError(describeControllerError("offerDraw", result.error));
            return;
          }
          announceOffer();
        })
        .catch((error) => {
          console.error(error);
          setActionError(
            error instanceof Error
              ? error.message
              : "The draw offer could not be sent.",
          );
        });
      return;
    }
    if (!opponentController) {
      setActionError("This opponent cannot respond to draw offers yet.");
      return;
    }
    if (!isSupportedController(opponentController)) {
      setActionError("This opponent cannot respond to draw offers yet.");
      return;
    }
    announceOffer();
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
    gameStateRef,
    setActionError,
    getSeatController,
    metaActionExecutor,
  ]);

  const handleCancelDrawOffer = useCallback(() => {
    if (!pendingDrawOffer) return;
    if (pendingDrawOffer.channel === "remote-controller") {
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
  }, [pendingDrawOffer, addSystemMessage, setActionError]);

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

      if (drawDecisionPrompt.source !== "remote") {
        setActionError(
          "We no longer have a connection for that draw offer. Please wait for the next update.",
        );
        return;
      }
      const responderController = getSeatController(drawDecisionPrompt.to);
      if (
        !responderController ||
        typeof responderController.respondToRemoteDraw !== "function"
      ) {
        setActionError(
          "We can't reach that player's controller to deliver your decision.",
        );
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
    if (!requesterController) {
      setActionError(
        describeControllerError("requestTakeback", {
          kind: "ControllerUnavailable",
          action: "requestTakeback",
        }),
      );
      return;
    }
    if (!metaActionExecutor.can(requesterId, "requestTakeback")) {
      setActionError("You cannot request a takeback right now.");
      return;
    }
    const responderController = getSeatController(responderId);
    const requestId = ++takebackRequestIdRef.current;
    const pendingEntry: PendingTakebackRequestState = {
      actorSeatId: requesterId,
      opponentSeatId: responderId,
      status: "pending",
      createdAt: Date.now(),
      requestId,
      historyLengthAtRequest,
      channel: requesterController.actionChannel,
    };
    const announceRequest = () => {
      setPendingTakebackRequest(pendingEntry);
      addSystemMessage(
        `${getPlayerName(requesterId)} requested a takeback from ${getPlayerName(
          responderId,
        )}.`,
      );
    };
    setActionError(null);
    if (requesterController.actionChannel === "remote-controller") {
      void metaActionExecutor
        .run(requesterId, "requestTakeback", undefined)
        .then(({ result }) => {
          if (!result.ok) {
            setActionError(
              describeControllerError("requestTakeback", result.error),
            );
            return;
          }
          announceRequest();
        })
        .catch((error) => {
          console.error(error);
          setActionError(
            error instanceof Error
              ? error.message
              : "The takeback request could not be sent.",
          );
        });
      return;
    }
    if (!responderController) {
      setActionError("This opponent cannot respond to takeback requests yet.");
      return;
    }
    if (!isSupportedController(responderController)) {
      setActionError("This opponent cannot respond to takeback requests yet.");
      return;
    }
    announceRequest();
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
    gameStateRef,
    setActionError,
    getSeatController,
    metaActionExecutor,
  ]);

  const handleCancelTakebackRequest = useCallback(() => {
    if (!pendingTakebackRequest) return;
    if (pendingTakebackRequest.channel === "remote-controller") {
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
  }, [pendingTakebackRequest, addSystemMessage, setActionError]);

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

      if (takebackDecisionPrompt.source !== "remote") {
        setActionError(
          "We no longer have a connection for that takeback request. Please wait for the next update.",
        );
        return;
      }
      const responderController = getSeatController(
        takebackDecisionPrompt.responder,
      );
      if (
        !responderController ||
        typeof responderController.respondToRemoteTakeback !== "function"
      ) {
        setActionError(
          "We can't reach that player's controller to deliver your decision.",
        );
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
    const giverController = getSeatController(giverId);
    if (!giverController) {
      setActionError(
        describeControllerError("giveTime", {
          kind: "ControllerUnavailable",
          action: "giveTime",
        }),
      );
      return;
    }
    if (!metaActionExecutor.can(giverId, "giveTime")) {
      setActionError("You cannot give time right now.");
      return;
    }
    setActionError(null);
    void metaActionExecutor
      .run(giverId, "giveTime", {
        seconds: 60,
      })
      .then(({ channel, result }) => {
        if (!result.ok) {
          setActionError(describeControllerError("giveTime", result.error));
          return;
        }
        if (channel === "remote-controller") {
          setOutgoingTimeInfo({
            id: ++noticeCounterRef.current,
            message: `You gave ${getPlayerName(opponentId)} 1:00.`,
            createdAt: Date.now(),
          });
        }
        addSystemMessage(
          `${getPlayerName(giverId)} gave ${getPlayerName(
            opponentId,
          )} one minute.`,
        );
      })
      .catch((error) => {
        console.error(error);
        setActionError(
          error instanceof Error
            ? error.message
            : "Unable to adjust the clocks right now.",
        );
      });
  }, [
    resolvePrimaryActionPlayerId,
    addSystemMessage,
    getPlayerName,
    gameStateRef,
    setActionError,
    getSeatController,
    metaActionExecutor,
    noticeCounterRef,
  ]);

  const handleIncomingDrawOffer = useCallback(
    (playerId: PlayerId) => {
      if (!primaryLocalPlayerId) return;
      if (resolveSeatChannel(primaryLocalPlayerId) !== "remote-controller") {
        return;
      }
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
      primaryLocalPlayerId,
      resolveSeatChannel,
      addSystemMessage,
      getPlayerName,
      setActionError,
    ],
  );

  const handleIncomingDrawRejected = useCallback(
    (playerId: PlayerId) => {
      if (!primaryLocalPlayerId) return;
      if (resolveSeatChannel(primaryLocalPlayerId) !== "remote-controller") {
        return;
      }
      if (playerId === primaryLocalPlayerId) {
        return;
      }
      if (
        pendingDrawOffer?.actorSeatId === primaryLocalPlayerId &&
        pendingDrawOffer.opponentSeatId === playerId
      ) {
        setPendingDrawOffer(null);
      }
      addSystemMessage(`${getPlayerName(playerId)} declined the draw offer.`);
    },
    [
      pendingDrawOffer,
      primaryLocalPlayerId,
      resolveSeatChannel,
      addSystemMessage,
      getPlayerName,
    ],
  );

  const handleIncomingTakebackOffer = useCallback(
    (playerId: PlayerId) => {
      if (!primaryLocalPlayerId) return;
      if (resolveSeatChannel(primaryLocalPlayerId) !== "remote-controller") {
        return;
      }
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
      primaryLocalPlayerId,
      resolveSeatChannel,
      addSystemMessage,
      getPlayerName,
      setActionError,
    ],
  );

  const handleIncomingTakebackRejected = useCallback(
    (playerId: PlayerId) => {
      if (!primaryLocalPlayerId) return;
      if (resolveSeatChannel(primaryLocalPlayerId) !== "remote-controller") {
        return;
      }
      if (playerId === primaryLocalPlayerId) {
        return;
      }
      if (
        pendingTakebackRequest?.actorSeatId === primaryLocalPlayerId &&
        pendingTakebackRequest.opponentSeatId === playerId
      ) {
        setPendingTakebackRequest(null);
      }
      addSystemMessage(
        `${getPlayerName(playerId)} declined the takeback request.`,
      );
    },
    [
      pendingTakebackRequest,
      primaryLocalPlayerId,
      resolveSeatChannel,
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
    const activeDrawOffer = pendingDrawOffer;
    if (
      activeDrawOffer?.channel !== "remote-controller" ||
      gameState?.status !== "finished" ||
      gameState?.result?.reason !== "draw-agreement"
    ) {
      return;
    }
    if (!activeDrawOffer) {
      return;
    }
    addSystemMessage(
      `${getPlayerName(activeDrawOffer.opponentSeatId)} accepted the draw offer.`,
    );
    setPendingDrawOffer(null);
  }, [
    pendingDrawOffer,
    gameState?.status,
    gameState?.result?.reason,
    addSystemMessage,
    getPlayerName,
  ]);

  useEffect(() => {
    const activeTakebackRequest = pendingTakebackRequest;
    if (
      activeTakebackRequest?.channel !== "remote-controller" ||
      activeTakebackRequest?.actorSeatId !== primaryLocalPlayerId ||
      !gameState
    ) {
      return;
    }
    if (!activeTakebackRequest) {
      return;
    }
    const historyLength = gameState.history.length;
    if (historyLength < activeTakebackRequest.historyLengthAtRequest) {
      addSystemMessage(
        `${getPlayerName(activeTakebackRequest.opponentSeatId)} accepted the takeback request.`,
      );
      setPendingTakebackRequest(null);
    }
  }, [
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
    if (!primaryLocalPlayerId) {
      previousTimeLeftRef.current = { ...gameState.timeLeft };
      return;
    }
    const channel = resolveSeatChannel(primaryLocalPlayerId);
    if (channel !== "remote-controller") {
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
    primaryLocalPlayerId,
    resolveSeatChannel,
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
