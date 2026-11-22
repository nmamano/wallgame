import { useEffect, useState } from "react";
import {
  decideWinOffer,
  NUDGE_SHOWN_EVENT,
  NUDGE_SIGNUP_CLICK_EVENT,
  type WinOfferTrigger,
} from "@/lib/account-nudge";
import { browserSendEvent } from "@/lib/analytics";
import { authHref } from "@/lib/auth-links";
import { browserStorage } from "@/lib/browser-storage";
import { isEmbedded } from "@/lib/embedded-mode";

/** The offer the end panel shows, and what its button does. */
export interface WinOffer {
  trigger: WinOfferTrigger;
  handleSignUp: () => void;
}

/**
 * The account offer after a guest's win or solved video puzzle (task B).
 * The rules are `decideWinOffer` in lib/account-nudge.ts; this claims the
 * session's one offer, counts it, and keeps it on screen for this game until
 * the player leaves it. A new game (a rematch, Try again) hides it.
 */
export function useWinOffer({
  gameId,
  trigger,
  authSettled,
  isLoggedIn,
}: {
  gameId: string;
  trigger: WinOfferTrigger | null;
  authSettled: boolean;
  isLoggedIn: boolean;
}): WinOffer | null {
  const [shown, setShown] = useState<{
    gameId: string;
    trigger: WinOfferTrigger;
  } | null>(null);

  useEffect(() => {
    if (shown?.gameId === gameId) return;
    const decision = decideWinOffer({
      trigger,
      embedded: isEmbedded(),
      authSettled,
      isLoggedIn,
      session: browserStorage("session"),
    });
    if (!decision.show) return;
    // One event per offer actually made: the click rate's denominator.
    browserSendEvent(NUDGE_SHOWN_EVENT, { trigger: decision.trigger });
    setShown({ gameId, trigger: decision.trigger });
  }, [gameId, trigger, authSettled, isLoggedIn, shown]);

  if (shown?.gameId !== gameId || isLoggedIn) return null;
  const offerTrigger = shown.trigger;
  return {
    trigger: offerTrigger,
    handleSignUp: () => {
      // Before the navigation: assigning location.href can tear the page
      // down before a queued request leaves.
      browserSendEvent(NUDGE_SIGNUP_CLICK_EVENT, { trigger: offerTrigger });
      // Back to this game after the sign-up, where its guest games are
      // linked to the new account (B1).
      window.location.href = authHref("register");
    },
  };
}
