/**
 * The post-game account nudge: whether to offer a guest an account after a
 * game, and the bookkeeping that makes "at most once" true.
 *
 * All of it lives here as pure functions over injected storage, for the same
 * reason `anonymous-id.ts` does: this project has no React test harness, so a
 * rule that decided this from inside an effect could only ever be checked by
 * reading it. Everything here is checked by running it.
 *
 * The order of operations is the part to preserve. RECORDING that a game was
 * played and DECIDING whether to nudge are separate steps, and recording comes
 * first: a player who finishes games while signed in has used up their first
 * game, so signing out later must not present them as brand new. Equally, a
 * finish nobody played - a spectator's, a replay's - must not consume it.
 */

import type { GameResult, GameStatus } from "../../../shared/domain/game-types";
import { isCountedResult } from "../../../shared/domain/game-utils";
import type { IdStorage } from "./anonymous-id";

/** Matches the existing `wall-game-theme` / `wall-game-anonymous-id` keys. */
const FIRST_GAME_KEY = "wall-game-first-finished-game";
const SHOWN_KEY = "wall-game-account-nudge-shown";
const SHOWN_VALUE = "1";

/**
 * A finish, described by everything that decides whether this viewer actually
 * played a real game - the question that comes before any nudging.
 */
export interface GameFinish {
  gameStatus: GameStatus | null;
  /** The finished game's result. Null until there is one. */
  result: GameResult | null;
  /** This viewer holds a seat, i.e. `primaryLocalPlayerId !== null`. */
  hasSeat: boolean;
  /** Spectating or watching a replay. */
  isReadOnly: boolean;
  isPuzzle: boolean;
}

/**
 * Whether this finish is a game this viewer played and that counts.
 *
 * `isCountedResult` is the existing rule, not a new one: a game that ended
 * before both players had a turn is an abort - no rating, no record, and never
 * written to past games. Offering to save the history of a game that was never
 * recorded would be a promise the site does not keep.
 *
 * Puzzles are excluded because /puzzles already tells anonymous solvers to log
 * in to keep their progress, and the puzzle endgame panel is already carrying
 * a retry button and a vote control.
 */
export function isPlayedGameFinish(finish: GameFinish): boolean {
  return (
    finish.gameStatus === "finished" &&
    isCountedResult(finish.result) &&
    finish.hasSeat &&
    !finish.isReadOnly &&
    !finish.isPuzzle
  );
}

/** Whether this browser had finished a game before this one. */
export type FirstGameOutcome = "first" | "not-first" | "unknown";

/**
 * Remembers the first game this browser finished, and reports whether the one
 * just handed in IS that game.
 *
 * The same id read back counts as "first" on purpose: reloading a finished
 * game does not make it a second game.
 */
export function recordPlayedGame(
  gameId: string,
  storage: IdStorage | undefined,
): FirstGameOutcome {
  if (!storage) return "unknown";

  try {
    const existing = storage.getItem(FIRST_GAME_KEY);
    if (existing) return existing === gameId ? "first" : "not-first";

    storage.setItem(FIRST_GAME_KEY, gameId);
    // Read back rather than trusting the write. A storage that accepts a write
    // and silently drops it would make every game look like the first one, and
    // turn a nudge shown once into one shown after every game a player ever
    // finishes - which is the exact intrusiveness this is supposed to avoid.
    return storage.getItem(FIRST_GAME_KEY) === gameId ? "first" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Whether the nudge has already been shown in this browsing session. */
export type SessionMark = "marked" | "already-shown" | "unavailable";

/**
 * Claims the one nudge this session is allowed, as a single read-then-write.
 *
 * Claiming BEFORE showing rather than after is what makes React's StrictMode
 * double-invoked effect harmless: the second invocation reads the mark the
 * first one wrote and stands down.
 */
export function markShownThisSession(
  storage: IdStorage | undefined,
): SessionMark {
  if (!storage) return "unavailable";

  try {
    if (storage.getItem(SHOWN_KEY) === SHOWN_VALUE) return "already-shown";
    storage.setItem(SHOWN_KEY, SHOWN_VALUE);
    return storage.getItem(SHOWN_KEY) === SHOWN_VALUE
      ? "marked"
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * Why a nudge was not shown. These exist so the tests can say which rule
 * fired rather than only that nothing happened - two rules that both suppress
 * are indistinguishable from a boolean, and one of them silently not working
 * would go unnoticed.
 */
export type NudgeSuppression =
  | "not-a-played-game"
  | "auth-unsettled"
  | "signed-in"
  | "not-first-game"
  | "already-shown-this-session"
  | "storage-unavailable";

export type NudgeDecision =
  | { show: true }
  | { show: false; because: NudgeSuppression };

export interface AccountNudgeInput {
  gameId: string;
  finish: GameFinish;
  /**
   * The signed-in check has finished loading. Required, because
   * `isLoggedIn` is false while the user query is still pending, and a
   * signed-in player opening a finished game would otherwise be told to make
   * the account they already have.
   */
  authSettled: boolean;
  isLoggedIn: boolean;
  /** Where the first-game marker lives. `localStorage` in a browser. */
  durable: IdStorage | undefined;
  /** Where the once-per-session mark lives. `sessionStorage` in a browser. */
  session: IdStorage | undefined;
}

/**
 * Records the finish if it was a played game, then decides whether to nudge.
 *
 * Nothing is shown when storage cannot be used. That is deliberate: without
 * storage we can tell neither first from second game nor shown from not-shown,
 * so the alternative to showing nothing is showing this after every single
 * game. A nudge is optional; nagging is not.
 */
export function recordFinishAndDecide(input: AccountNudgeInput): NudgeDecision {
  if (!isPlayedGameFinish(input.finish)) {
    return { show: false, because: "not-a-played-game" };
  }

  // Before any question about who is watching: this game happened, and it was
  // this browser's first or it was not.
  const outcome = recordPlayedGame(input.gameId, input.durable);

  if (!input.authSettled) return { show: false, because: "auth-unsettled" };
  if (input.isLoggedIn) return { show: false, because: "signed-in" };
  if (outcome === "unknown") {
    return { show: false, because: "storage-unavailable" };
  }
  if (outcome === "not-first")
    return { show: false, because: "not-first-game" };

  const mark = markShownThisSession(input.session);
  if (mark === "already-shown") {
    return { show: false, because: "already-shown-this-session" };
  }
  if (mark === "unavailable") {
    return { show: false, because: "storage-unavailable" };
  }
  return { show: true };
}
