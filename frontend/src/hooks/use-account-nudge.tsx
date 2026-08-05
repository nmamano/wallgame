import { useEffect } from "react";
import { ToastAction } from "@/components/ui/toast";
import { toast } from "@/hooks/use-toast";
import { recordFinishAndDecide, type GameFinish } from "@/lib/account-nudge";
import type { IdStorage } from "@/lib/anonymous-id";

/**
 * Offers a guest an account once they have actually played a game.
 *
 * A toast rather than anything in the endgame panel, deliberately. That panel
 * is three fixed-height blocks and the rematch button is one of them - a
 * rematch is where most games come from, so it is the last thing a growth
 * prompt may push around. A fixed-position toast is outside layout entirely,
 * which also lets one call site serve the mobile and desktop trees without
 * forking either.
 *
 * The rules and the bookkeeping live in `@/lib/account-nudge`, over injected
 * storage, so they are tested by running them. What is left here is the part
 * that can only be seen in a browser: the words, and the toast.
 */

/**
 * Draft wording. The mechanism ships with a best draft and Nil edits the
 * words - this file is where they are.
 *
 * It promises what an account gives from here on rather than claiming this
 * particular game was saved. A local game is never recorded server-side, and
 * a sentence that is true in one mode and false in another is worse than a
 * plainer one that holds everywhere.
 */
const NUDGE_TITLE = "Playing as a guest";
const NUDGE_DESCRIPTION =
  "Create a free account to pick a name, play rated games, and keep your game history.";
const NUDGE_ACTION_LABEL = "Sign up";
/** Where the site already sends people who want an account. */
const REGISTER_URL = "/api/register";

/**
 * Long enough to read and click, short enough that it does not camp on top of
 * the post-game chat. Radix's own default is 5s, which is not long enough to
 * read a sentence and decide; the toast hook's removal delay is 16 minutes,
 * which is another way of saying "until you close it".
 */
const NUDGE_DURATION_MS = 20_000;

/**
 * Reading `window.localStorage` can itself throw - some privacy modes make the
 * property access fail, not just the read - so even obtaining it is guarded.
 * These live here rather than in the rules module so that module never touches
 * `window` at all and runs anywhere.
 */
function browserStorage(kind: "local" | "session"): IdStorage | undefined {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return undefined;
  }
}

export interface UseAccountNudgeInput extends GameFinish {
  gameId: string;
  /** The signed-in check has finished loading, i.e. `!userPending`. */
  authSettled: boolean;
  isLoggedIn: boolean;
}

export function useAccountNudge({
  gameId,
  gameStatus,
  result,
  hasSeat,
  isReadOnly,
  isPuzzle,
  authSettled,
  isLoggedIn,
}: UseAccountNudgeInput): void {
  useEffect(() => {
    const decision = recordFinishAndDecide({
      gameId,
      finish: { gameStatus, result, hasSeat, isReadOnly, isPuzzle },
      authSettled,
      isLoggedIn,
      durable: browserStorage("local"),
      session: browserStorage("session"),
    });
    if (!decision.show) return;

    toast({
      title: NUDGE_TITLE,
      description: NUDGE_DESCRIPTION,
      duration: NUDGE_DURATION_MS,
      action: (
        <ToastAction
          altText="Sign up for a free account"
          onClick={() => {
            window.location.href = REGISTER_URL;
          }}
        >
          {NUDGE_ACTION_LABEL}
        </ToastAction>
      ),
    });
  }, [
    gameId,
    gameStatus,
    result,
    hasSeat,
    isReadOnly,
    isPuzzle,
    authSettled,
    isLoggedIn,
  ]);
}
