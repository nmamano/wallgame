import { useState, useCallback } from "react";
import type { GameState } from "../../../shared/domain/game-state";
import {
  DEFAULT_VIEW_MODEL,
  applyServerUpdate as applyServerUpdatePure,
  type GameViewModel,
  type LastMoveDiff,
  type ServerUpdate,
} from "@/lib/gameViewModel";

interface UpdateGameStateOptions {
  /** Colorless identity diffs; colors are applied at render time. */
  lastMoves?: LastMoveDiff[] | null;
}

interface UseGameViewModelResult {
  viewModel: GameViewModel;
  applyServerUpdate: (update: ServerUpdate) => void;
  updateGameState: (
    nextState: GameState,
    options?: UpdateGameStateOptions,
  ) => void;
  resetViewModel: () => void;
}

export function useGameViewModel(): UseGameViewModelResult {
  const [viewModel, setViewModel] = useState<GameViewModel>(DEFAULT_VIEW_MODEL);

  const applyServerUpdate = useCallback((update: ServerUpdate) => {
    setViewModel((prev) => applyServerUpdatePure(prev, update));
  }, []);

  const updateGameState = useCallback(
    (nextState: GameState, options?: UpdateGameStateOptions) => {
      setViewModel((prev) => {
        const shouldUpdateLastMoves =
          options && Object.prototype.hasOwnProperty.call(options, "lastMoves");

        return {
          ...prev,
          gameState: nextState,
          lastMoves: shouldUpdateLastMoves
            ? (options?.lastMoves ?? null)
            : prev.lastMoves,
        };
      });
    },
    [],
  );

  const resetViewModel = useCallback(() => {
    setViewModel(DEFAULT_VIEW_MODEL);
  }, []);

  return {
    viewModel,
    applyServerUpdate,
    updateGameState,
    resetViewModel,
  };
}
