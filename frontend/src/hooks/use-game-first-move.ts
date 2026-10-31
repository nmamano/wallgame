import { useEffect, useRef } from "react";
import { browserSendEvent } from "@/lib/analytics";
import { browserStorage } from "@/lib/browser-storage";
import {
  GAME_FIRST_MOVE_EVENT,
  firstMovePhase,
  takeFirstMoveEvent,
  type FirstMoveView,
} from "@/lib/game-events";

/**
 * Sends `game_first_move` once, when this browser's seated player makes
 * their first move of a game (game-events.ts has the rule). Nothing on
 * screen changes.
 */
export function useGameFirstMove({
  gameId,
  state,
  playerId,
  isReadOnly,
  isPuzzle,
  opponent,
}: FirstMoveView): void {
  // The game id this page saw before its player's first move, or null.
  const sawBeforeRef = useRef<string | null>(null);
  useEffect(() => {
    const view = { gameId, state, playerId, isReadOnly, isPuzzle, opponent };
    const phase = firstMovePhase(view);
    if (phase === "before") {
      sawBeforeRef.current = gameId;
      return;
    }
    if (phase !== "after") return;
    const params = takeFirstMoveEvent({
      view,
      sawBefore: sawBeforeRef.current === gameId,
      session: browserStorage("session"),
    });
    sawBeforeRef.current = null;
    if (params) browserSendEvent(GAME_FIRST_MOVE_EVENT, params);
  }, [gameId, state, playerId, isReadOnly, isPuzzle, opponent]);
}
