/**
 * When the puzzle page is allowed to start a bot game.
 *
 * A tiny state machine rather than a ref and a flag, because the rule it
 * encodes is easy to state and easy to get wrong: STARTING A GAME IS A
 * ONE-SHOT PERMISSION, and only a person can hand it back.
 *
 * The bug that motivated it: on a failed launch the page used to re-arm itself
 * and merely show an error. Rendering an error card does not stop effects, and
 * the launch effect depends on values derived from live queries — so any later
 * render could see "armed" and quietly call the same rejected bot again, while
 * the error was still on screen. The user never asked for that second attempt
 * and never saw it happen.
 *
 * So a failure leaves the page DISARMED. Re-arming is an event with a name:
 * the player pressed Try again, or moved to a different puzzle. Choosing the
 * authored line deliberately does not re-arm — there is nothing to launch.
 */

export interface PuzzleLaunchState {
  /** May a launch be started right now? */
  armed: boolean;
  /** The message to show, or null. Never on its own the reason not to launch. */
  error: string | null;
}

export type PuzzleLaunchEvent =
  /** A different puzzle is on screen: a fresh one-shot permission. */
  | { type: "puzzle-changed" }
  /** A launch is going out. Spends the permission. */
  | { type: "launch-started" }
  /** The server refused, or the network did. Stays spent. */
  | { type: "launch-failed"; message: string }
  /** The player asked to try again — the ONLY way back to armed mid-puzzle. */
  | { type: "retry-requested" }
  /** The player chose the authored line; nothing will be launched. */
  | { type: "authored-chosen" };

export const initialPuzzleLaunchState: PuzzleLaunchState = {
  armed: true,
  error: null,
};

export const puzzleLaunchReducer = (
  _state: PuzzleLaunchState,
  event: PuzzleLaunchEvent,
): PuzzleLaunchState => {
  switch (event.type) {
    case "puzzle-changed":
      return initialPuzzleLaunchState;
    case "launch-started":
      return { armed: false, error: null };
    case "launch-failed":
      // Disarmed AND showing why. Re-arming here is exactly the bug.
      return { armed: false, error: event.message };
    case "retry-requested":
      return { armed: true, error: null };
    case "authored-chosen":
      return { armed: false, error: null };
  }
};
