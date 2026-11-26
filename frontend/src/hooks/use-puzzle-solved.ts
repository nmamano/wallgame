import { useEffect, useRef } from "react";
import { browserSendEvent } from "@/lib/analytics";
import { browserStorage } from "@/lib/browser-storage";
import {
  PUZZLE_SOLVED_EVENT,
  puzzleSolvedPhase,
  takePuzzleSolvedEvent,
  type PuzzleSolvedView,
} from "@/lib/puzzle-events";

/**
 * Sends `puzzle_solved` once, when this browser's seated player wins a puzzle
 * game this page saw in play (puzzle-events.ts has the rule). Nothing on
 * screen changes.
 */
export function usePuzzleSolved({
  gameId,
  puzzle,
  state,
  playerId,
  isReadOnly,
}: PuzzleSolvedView): void {
  // The game id this page saw in play, or null.
  const sawPlayingRef = useRef<string | null>(null);
  useEffect(() => {
    const view = { gameId, puzzle, state, playerId, isReadOnly };
    const phase = puzzleSolvedPhase(view);
    if (phase === "playing") {
      sawPlayingRef.current = gameId;
      return;
    }
    if (phase !== "won") return;
    const params = takePuzzleSolvedEvent({
      view,
      sawPlaying: sawPlayingRef.current === gameId,
      session: browserStorage("session"),
    });
    sawPlayingRef.current = null;
    if (params) browserSendEvent(PUZZLE_SOLVED_EVENT, params);
  }, [gameId, puzzle, state, playerId, isReadOnly]);
}
