import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { EvalClient } from "@/lib/eval-client";
import type { GameState } from "../../../shared/domain/game-state";
import type {
  SerializedGameState,
  GameConfiguration,
} from "../../../shared/domain/game-types";
import { moveToStandardNotation } from "../../../shared/domain/standard-notation";

// ============================================================================
// Types
// ============================================================================

export type EvalToggleState = "off" | "loading" | "on" | "error";

export interface UseEvalBarOptions {
  gameId: string;
  config: GameConfiguration | null;

  // History state
  historyCursor: number | null;
  currentState: GameState | null;
  historyState: GameState | null;

  // Access control
  isRatedGame: boolean;
  isActivePlayer: boolean; // true if user is a player AND game is in-progress
  isPuzzle: boolean;

  // Optional socket token for player identification
  socketToken?: string;
}

export interface EvalBarState {
  // Toggle state
  toggleState: EvalToggleState;
  isDisabled: boolean;
  disabledReason?: string;

  // Evaluation state
  evaluation: number | null; // -1 to +1
  isPending: boolean;

  // Error display
  errorMessage: string | null;

  // Actions
  toggleOn: () => void;
  toggleOff: () => void;
}

// ============================================================================
// Serialization Helper
// ============================================================================

const serializeGameStateForEval = (
  state: GameState,
  config: GameConfiguration,
): SerializedGameState => {
  const historyRows = state.config.boardHeight;
  return {
    status: state.status,
    result: state.result,
    turn: state.turn,
    moveCount: state.moveCount,
    timeLeft: { ...state.timeLeft },
    lastMoveTime: state.lastMoveTime,
    pawns: {
      1: {
        cat: state.pawns[1].cat,
        mouse: state.pawns[1].mouse,
      },
      2: {
        cat: state.pawns[2].cat,
        mouse: state.pawns[2].mouse,
      },
    },
    walls: state.grid.getWalls(),
    initialState: state.getInitialState(),
    history: state.history.map((entry) => ({
      index: entry.index,
      notation: moveToStandardNotation(entry.move, historyRows),
    })),
    config: {
      boardWidth: state.config.boardWidth,
      boardHeight: state.config.boardHeight,
      variant: state.config.variant,
      rated: config.rated,
      timeControl: config.timeControl,
      variantConfig: state.config.variantConfig,
    },
  };
};

// ============================================================================
// Hook Implementation
// ============================================================================

const HISTORY_DEBOUNCE_MS = 1000;

export function useEvalBar(options: UseEvalBarOptions): EvalBarState {
  const {
    gameId,
    config,
    historyCursor,
    currentState,
    historyState,
    isRatedGame,
    isActivePlayer,
    isPuzzle,
    socketToken,
  } = options;

  // State
  const [toggleState, setToggleState] = useState<EvalToggleState>("off");
  const [evaluation, setEvaluation] = useState<number | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Refs
  const evalClientRef = useRef<EvalClient | null>(null);
  const debounceTimerRef = useRef<number | null>(null);
  // Track position key (gameId:moveCount) we're waiting for, not full requestId with timestamp
  const pendingPositionKeyRef = useRef<string | null>(null);
  const prevPositionKeyRef = useRef<string | null>(null);

  // Helper to extract position key from requestId (gameId:moveCount:timestamp -> gameId:moveCount)
  const extractPositionKey = (requestId: string): string => {
    const parts = requestId.split(":");
    return `${parts[0]}:${parts[1]}`;
  };

  // Computed: is toggle disabled?
  const isDisabled = isPuzzle || (isRatedGame && isActivePlayer);
  const disabledReason = isPuzzle
    ? "Evaluations are not available for puzzles."
    : isRatedGame && isActivePlayer
      ? "Evaluations are not available for players in rated games."
      : undefined;

  // Computed: the current display state (live or history)
  const displayState = historyCursor !== null ? historyState : currentState;

  // Generate a unique key for the current position
  const positionKey = useMemo(() => {
    if (!displayState) return null;
    return `${gameId}:${displayState.moveCount}:${historyCursor ?? "live"}`;
  }, [gameId, displayState, historyCursor]);

  // Request eval for the current position
  const requestEvalForCurrentPosition = useCallback(() => {
    const client = evalClientRef.current;
    const state = historyCursor !== null ? historyState : currentState;

    if (!client?.isReady() || !state || !config) {
      return;
    }

    // Don't request for ended games (but allow for history viewing)
    if (historyCursor === null && state.status !== "playing") {
      return;
    }

    const requestId = `${gameId}:${state.moveCount}:${Date.now()}`;
    // Track the position key (gameId:moveCount) we're waiting for
    pendingPositionKeyRef.current = `${gameId}:${state.moveCount}`;
    setIsPending(true);

    const serialized = serializeGameStateForEval(state, config);
    client.requestEval(requestId, serialized);
  }, [gameId, config, currentState, historyState, historyCursor]);

  // Connect to eval service
  const connect = useCallback(() => {
    if (!config || !currentState) {
      setErrorMessage("Game not initialized");
      setToggleState("error");
      return;
    }

    setToggleState("loading");
    setErrorMessage(null);

    const client = new EvalClient(gameId);
    evalClientRef.current = client;

    client.connect(
      {
        onHandshakeAccepted: () => {
          setToggleState("on");
          // Request eval for current position immediately
          requestEvalForCurrentPosition();
        },
        onHandshakeRejected: (_code, message) => {
          setToggleState("error");
          setErrorMessage(message);
          evalClientRef.current = null;
        },
        onEvalResponse: (requestId, evalValue) => {
          // Check if response is for the current position (ignore timestamp, compare gameId:moveCount)
          const responsePositionKey = extractPositionKey(requestId);
          if (responsePositionKey !== pendingPositionKeyRef.current) {
            // Stale response for a different position - ignore it
            console.log(
              `[useEvalBar] Ignoring stale eval response for ${responsePositionKey}, waiting for ${pendingPositionKeyRef.current}`,
            );
            return;
          }
          setEvaluation(evalValue);
          setIsPending(false);
        },
        onError: (message) => {
          setToggleState("error");
          setErrorMessage(message);
          evalClientRef.current = null;
        },
        onClose: () => {
          setToggleState("off");
          evalClientRef.current = null;
        },
      },
      config.variant,
      config.boardWidth,
      config.boardHeight,
      socketToken,
    );
  }, [
    config,
    currentState,
    gameId,
    socketToken,
    requestEvalForCurrentPosition,
  ]);

  // Disconnect from eval service
  const disconnect = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    evalClientRef.current?.close();
    evalClientRef.current = null;
    setToggleState("off");
    setEvaluation(null);
    setIsPending(false);
    setErrorMessage(null);
    pendingPositionKeyRef.current = null;
    prevPositionKeyRef.current = null;
  }, []);

  // Effect: Request eval when position changes
  useEffect(() => {
    if (toggleState !== "on") return;
    if (!positionKey || positionKey === prevPositionKeyRef.current) return;

    prevPositionKeyRef.current = positionKey;

    // Clear any pending debounce timer
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    // Set pending state immediately
    setIsPending(true);

    if (historyCursor !== null) {
      // Viewing history - debounce to avoid spam when scrubbing
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        requestEvalForCurrentPosition();
      }, HISTORY_DEBOUNCE_MS);
    } else {
      // Live game - request immediately
      requestEvalForCurrentPosition();
    }
  }, [toggleState, positionKey, historyCursor, requestEvalForCurrentPosition]);

  // Effect: Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  // Actions
  const toggleOn = useCallback(() => {
    if (isDisabled || toggleState === "loading") return;
    connect();
  }, [isDisabled, toggleState, connect]);

  const toggleOff = useCallback(() => {
    disconnect();
  }, [disconnect]);

  return {
    toggleState,
    isDisabled,
    disabledReason,
    evaluation,
    isPending,
    errorMessage,
    toggleOn,
    toggleOff,
  };
}
