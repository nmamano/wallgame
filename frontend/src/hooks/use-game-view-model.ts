import { useState, useCallback, useRef, type MutableRefObject } from "react";
import type { BoardProps } from "@/components/board";
import type { GameState } from "../../../shared/domain/game-state";
import type { PlayerId } from "../../../shared/domain/game-types";
import type { PlayerColor } from "@/lib/player-colors";
import {
  DEFAULT_VIEW_MODEL,
  applyServerUpdate as applyServerUpdatePure,
  type GameViewModel,
  type ServerUpdate,
} from "@/lib/gameViewModel";

interface UpdateGameStateOptions {
  lastMoves?: BoardProps["lastMove"] | BoardProps["lastMoves"] | null;
}

interface UseGameViewModelResult {
  viewModel: GameViewModel;
  applyServerUpdate: (update: ServerUpdate) => void;
  updateGameState: (
    nextState: GameState,
    options?: UpdateGameStateOptions,
  ) => void;
  resetViewModel: () => void;
  playerColorsForBoardRef: MutableRefObject<Record<PlayerId, PlayerColor>>;
}

export function useGameViewModel(
  defaultPlayerColors: Record<PlayerId, PlayerColor>,
): UseGameViewModelResult {
  const [viewModel, setViewModel] = useState<GameViewModel>(DEFAULT_VIEW_MODEL);

  const playerColorsForBoardRef = useRef<Record<PlayerId, PlayerColor>>({
    1: defaultPlayerColors[1],
    2: defaultPlayerColors[2],
  });

  const applyServerUpdate = useCallback((update: ServerUpdate) => {
    setViewModel((prev) =>
      applyServerUpdatePure(prev, update, playerColorsForBoardRef.current),
    );
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
            ? ((options?.lastMoves as BoardProps["lastMoves"] | null) ?? null)
            : prev.lastMoves,
        };
      });
    },
    [],
  );

  const resetViewModel = useCallback(() => {
    setViewModel(DEFAULT_VIEW_MODEL);
    playerColorsForBoardRef.current = {
      1: defaultPlayerColors[1],
      2: defaultPlayerColors[2],
    };
  }, [defaultPlayerColors]);

  return {
    viewModel,
    applyServerUpdate,
    updateGameState,
    resetViewModel,
    playerColorsForBoardRef,
  };
}
