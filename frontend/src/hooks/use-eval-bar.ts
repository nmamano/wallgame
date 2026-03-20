import { useState, useRef, useEffect, useCallback } from "react";
import { EvalClient, type EvalHistoryEntry } from "@/lib/eval-client";
import type { GameState } from "../../../shared/domain/game-state";
import type { GameConfiguration } from "../../../shared/domain/game-types";

// ============================================================================
// Types
// ============================================================================

export type EvalToggleState = "off" | "loading" | "on" | "error";
export type EvalDisplayMode = "off" | "eval-only" | "eval-and-best-move";

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
  displayMode: EvalDisplayMode;
  isDisabled: boolean;
  disabledReason?: string;

  // Evaluation state
  evaluation: number | null; // -1 to +1
  bestMove: string | null;
  isPending: boolean;

  // Error display
  errorMessage: string | null;

  // Actions
  cycleToggle: () => void;
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * V3 evaluation bar hook using BGS-based history protocol.
 *
 * Key changes from V2:
 * - Server sends full evaluation history on connect (eval-history message)
 * - Server streams updates when new moves are made (eval-update message)
 * - Client looks up evaluation from history by ply instead of requesting per-position
 * - No debouncing needed - history scrubbing is instant
 */
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
  const [displayMode, setDisplayMode] = useState<EvalDisplayMode>("off");
  const [evalHistory, setEvalHistory] = useState<EvalHistoryEntry[]>([]);
  const [isPending, setIsPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Refs
  const evalClientRef = useRef<EvalClient | null>(null);

  // Computed: is toggle disabled?
  const isDisabled = isPuzzle || (isRatedGame && isActivePlayer);
  const disabledReason = isPuzzle
    ? "Evaluations are not available for puzzles."
    : isRatedGame && isActivePlayer
      ? "Evaluations are not available for players in rated games."
      : undefined;

  // Computed: the current display state (live or history)
  const displayState = historyCursor !== null ? historyState : currentState;

  // Computed: current ply (moveCount) to look up in history
  const currentPly = displayState?.moveCount ?? null;

  // V3: Look up evaluation from history by ply
  // This is instant - no network request needed when scrubbing through history
  const currentEntry =
    currentPly !== null
      ? (evalHistory.find((entry) => entry.ply === currentPly) ?? null)
      : null;
  const evaluation = currentEntry?.evaluation ?? null;
  // Empty bestMove string means no best move available — normalize to null
  const rawBestMove = currentEntry?.bestMove ?? null;
  const bestMove = rawBestMove === "" ? null : rawBestMove;

  // Connect to eval service
  const connect = useCallback(() => {
    if (!config || !currentState) {
      setErrorMessage("Game not initialized");
      setToggleState("error");
      return;
    }

    setToggleState("loading");
    setErrorMessage(null);
    setEvalHistory([]);
    setIsPending(true);

    const client = new EvalClient(gameId);
    evalClientRef.current = client;

    client.connect(
      {
        onHandshakeAccepted: () => {
          // V3: Stay in loading state until we receive eval-history
          // The server will send eval-pending followed by eval-history
          console.debug("[useEvalBar] Handshake accepted, waiting for history");
        },
        onHandshakeRejected: (_code, message) => {
          setToggleState("error");
          setDisplayMode("off");
          setErrorMessage(message);
          setIsPending(false);
          evalClientRef.current = null;
        },
        // V3: Handle pending state during BGS initialization
        onEvalPending: (totalMoves) => {
          console.debug(
            `[useEvalBar] BGS initialization pending, ${totalMoves} moves to replay`,
          );
          setIsPending(true);
        },
        // V3: Receive full evaluation history
        onEvalHistory: (entries) => {
          console.debug(
            `[useEvalBar] Received eval history with ${entries.length} entries`,
          );
          setEvalHistory(entries);
          setIsPending(false);
          setToggleState("on");
        },
        // V3: Streaming update when new move is made in live game
        onEvalUpdate: (ply, evalValue, bestMove) => {
          console.debug(`[useEvalBar] Received eval update for ply ${ply}`);
          setEvalHistory((prev) => {
            // Check if we already have this ply (shouldn't happen, but be safe)
            const existing = prev.find((e) => e.ply === ply);
            if (existing) {
              // Update existing entry
              return prev.map((e) =>
                e.ply === ply ? { ply, evaluation: evalValue, bestMove } : e,
              );
            }
            // Append new entry
            return [...prev, { ply, evaluation: evalValue, bestMove }];
          });
        },
        // V2 fallback: handle legacy eval-response (deprecated, kept for migration)
        onEvalResponse: (requestId, evalValue, bestMove) => {
          console.debug(
            `[useEvalBar] Received V2 eval response for ${requestId}`,
          );
          // Extract ply from requestId (gameId:moveCount:timestamp)
          const parts = requestId.split(":");
          const ply = parseInt(parts[1], 10);
          if (!isNaN(ply)) {
            setEvalHistory((prev) => {
              const existing = prev.find((e) => e.ply === ply);
              if (existing) {
                return prev.map((e) =>
                  e.ply === ply
                    ? { ply, evaluation: evalValue, bestMove: bestMove ?? "" }
                    : e,
                );
              }
              return [
                ...prev,
                { ply, evaluation: evalValue, bestMove: bestMove ?? "" },
              ];
            });
          }
          setIsPending(false);
          setToggleState("on");
        },
        onError: (message) => {
          setToggleState("error");
          setDisplayMode("off");
          setErrorMessage(message);
          setIsPending(false);
          evalClientRef.current = null;
        },
        onClose: () => {
          setToggleState("off");
          setDisplayMode("off");
          evalClientRef.current = null;
        },
      },
      config.variant,
      config.boardWidth,
      config.boardHeight,
      socketToken,
    );
  }, [config, currentState, gameId, socketToken]);

  // Disconnect from eval service
  const disconnect = useCallback(() => {
    evalClientRef.current?.close();
    evalClientRef.current = null;
    setToggleState("off");
    setDisplayMode("off");
    setEvalHistory([]);
    setIsPending(false);
    setErrorMessage(null);
  }, []);

  // Effect: Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  // Actions: 3-state cycle: off → eval-only → eval-and-best-move → off
  const cycleToggle = useCallback(() => {
    if (isDisabled || toggleState === "loading") return;

    if (displayMode === "off") {
      // off → eval-only: connect WebSocket and start showing eval bar
      setDisplayMode("eval-only");
      connect();
    } else if (displayMode === "eval-only") {
      // eval-only → eval-and-best-move: just flip the mode, no reconnect
      setDisplayMode("eval-and-best-move");
    } else {
      // eval-and-best-move → off: disconnect and reset
      disconnect();
    }
  }, [isDisabled, toggleState, displayMode, connect, disconnect]);

  return {
    toggleState,
    displayMode,
    isDisabled,
    disabledReason,
    evaluation,
    bestMove,
    isPending,
    errorMessage,
    cycleToggle,
  };
}
