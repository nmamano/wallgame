/**
 * The `game_first_move` analytics event: a game this browser's player
 * actually started (Wall Game Growth, 2026-10-31, task 8ec46ee4).
 *
 * GA already knows where a visitor came from (UTM, referrer); this event says
 * whether that visitor then played, so Growth can measure the play rate per
 * channel. It is sent once per game id, in the browser of a SEATED player,
 * right after the server accepted that player's own first move. Not when a
 * game is created (a lobby game that never starts would count), and never for
 * a spectator, a replay or a puzzle.
 *
 * Pure functions over injected storage, as `account-nudge.ts`: the project
 * has no React test harness, so the rule is checked by running it.
 */

import type { GameState } from "../../../shared/domain/game-state";
import type { PlayerId } from "../../../shared/domain/game-types";
import type { IdStorage } from "./anonymous-id";

/** GA4 event names are snake_case and capped at 40 characters. */
export const GAME_FIRST_MOVE_EVENT = "game_first_move";

const SENT_KEY_PREFIX = "wall-game-first-move:";
const SENT_VALUE = "1";

/** Flat scalars only (GA4 stores no nested values); no user or game id. */
export interface FirstMoveParams {
  [key: string]: string;
  variant: string;
  opponent: "bot" | "human";
  board: string;
}

/** The live game, as this browser sees it. */
export interface FirstMoveView {
  gameId: string;
  /** The live state (not a history snapshot), or null before it loads. */
  state: Pick<GameState, "history" | "turn" | "config"> | null;
  /** This browser's seat (`primaryLocalPlayerId`), or null. */
  playerId: PlayerId | null;
  /** Spectating or watching a replay. */
  isReadOnly: boolean;
  isPuzzle: boolean;
  opponent: "bot" | "human";
}

/**
 * Whether `playerId` has made a move in `state`. Turns alternate, so after
 * two moves both players have moved; after one, the player who moved is the
 * one no longer on turn.
 */
export function hasMoved(
  state: Pick<GameState, "history" | "turn">,
  playerId: PlayerId,
): boolean {
  const moves = state.history.length;
  return moves >= 2 || (moves === 1 && state.turn !== playerId);
}

/**
 * Where this view stands for the event: "none" (no seated game of its own:
 * no state yet, no seat, a spectator, a replay, a puzzle), "before" (the
 * player has not moved yet) or "after" (the player has moved).
 */
export function firstMovePhase(
  view: FirstMoveView,
): "none" | "before" | "after" {
  if (!view.state || view.playerId === null) return "none";
  if (view.isReadOnly || view.isPuzzle) return "none";
  return hasMoved(view.state, view.playerId) ? "after" : "before";
}

/**
 * The event's params when it is due now, or null; marks the game as sent in
 * `session` when it is.
 *
 * Due only when this page saw the player BEFORE their first move and sees
 * them after it (`sawBefore`), so opening a game that is already under way -
 * a reload, a second tab - sends nothing. The session mark is the second
 * guard: a takeback that undoes the first move and a new first move do not
 * send it again in this tab.
 */
export function takeFirstMoveEvent({
  view,
  sawBefore,
  session,
}: {
  view: FirstMoveView;
  sawBefore: boolean;
  session: IdStorage | undefined;
}): FirstMoveParams | null {
  if (!sawBefore || !view.state || firstMovePhase(view) !== "after") {
    return null;
  }
  const key = SENT_KEY_PREFIX + view.gameId;
  try {
    if (session?.getItem(key) === SENT_VALUE) return null;
    session?.setItem(key, SENT_VALUE);
  } catch {
    // Storage refused (a privacy mode): the page's own once-only guard
    // (`sawBefore`, which the caller clears) still holds.
  }
  const { config } = view.state;
  return {
    variant: config.variant,
    opponent: view.opponent,
    board: `${config.boardWidth}x${config.boardHeight}`,
  };
}
