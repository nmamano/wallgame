import { useCallback } from "react";
import { useLocalStorageState } from "./use-local-storage";

const STORAGE_KEY = "wallgame-puzzles-completed";

/**
 * Hook for tracking puzzle completion progress in localStorage.
 * Progress persists across browser sessions but doesn't sync across devices.
 */
export function usePuzzleProgress() {
  const [completedPuzzles, setCompletedPuzzles] = useLocalStorageState<
    string[]
  >(STORAGE_KEY, []);

  const markCompleted = useCallback(
    (puzzleId: string) => {
      setCompletedPuzzles((prev) => {
        if (prev.includes(puzzleId)) return prev;
        return [...prev, puzzleId];
      });
    },
    [setCompletedPuzzles],
  );

  const isCompleted = useCallback(
    (puzzleId: string) => {
      return completedPuzzles.includes(puzzleId);
    },
    [completedPuzzles],
  );

  const clearProgress = useCallback(() => {
    setCompletedPuzzles([]);
  }, [setCompletedPuzzles]);

  return {
    completedPuzzles,
    markCompleted,
    isCompleted,
    clearProgress,
  };
}
