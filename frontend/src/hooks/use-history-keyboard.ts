import { useEffect } from "react";
import type { GameStatus } from "../../../shared/domain/game-types";
import type { HistoryNav } from "@/types/history";

/**
 * Left and right arrow keys step through the move list.
 *
 * Only when the game is NOT active (Nil, board 90c329b0). During a live game
 * the arrows stay inert: a player mid-turn is aiming at the board, and
 * silently rewinding the position under them is the opposite of helpful. The
 * one exception is a player who has ALREADY opened the history of a live game
 * by clicking a move - they are reading, not playing, so the arrows follow
 * them there and the same keys take them back to the live position.
 */

export type HistoryKeyDirection = "back" | "forward";

export interface HistoryKeyContext {
  /** null before the first state arrives. */
  gameStatus: GameStatus | null;
  /** null means the live position; a number means a ply is being viewed. */
  historyCursor: number | null;
  /** The keystroke is typing, not navigating - the chat box owns it. */
  targetIsTextEntry: boolean;
  /** Ctrl/Meta/Alt are browser and OS shortcuts; do not take them. */
  hasModifier: boolean;
}

/**
 * Which way to step, or null to leave the keystroke alone.
 *
 * Pure, and exported for its own tests: the decision is the whole feature, and
 * a test that had to synthesize keyboard events through a rendered game page
 * would be measuring React, not this rule.
 */
export const historyKeyDirection = (
  key: string,
  context: HistoryKeyContext,
): HistoryKeyDirection | null => {
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  if (context.targetIsTextEntry) return null;
  if (context.hasModifier) return null;

  const gameIsActive = context.gameStatus === "playing";
  const alreadyBrowsingHistory = context.historyCursor !== null;
  if (gameIsActive && !alreadyBrowsingHistory) return null;

  return key === "ArrowLeft" ? "back" : "forward";
};

const isTextEntry = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

export const useHistoryKeyboard = (options: {
  gameStatus: GameStatus | null;
  historyNav: HistoryNav;
  enabled?: boolean;
}): void => {
  const { gameStatus, historyNav, enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const direction = historyKeyDirection(event.key, {
        gameStatus,
        historyCursor: historyNav.cursor,
        targetIsTextEntry: isTextEntry(event.target),
        hasModifier: event.ctrlKey || event.metaKey || event.altKey,
      });
      if (!direction) return;

      // Claimed only once the rule says yes, so a live game leaves the arrows
      // to the page (scrolling included).
      event.preventDefault();
      if (direction === "back") {
        historyNav.stepBack();
        return;
      }
      historyNav.stepForward();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, gameStatus, historyNav]);
};
