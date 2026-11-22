import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, userQueryOptions } from "@/lib/api";
import { getAnonymousId } from "@/lib/anonymous-id";
import { SIGNUP_GUEST_GAMES_COOKIE } from "../../../shared/contracts/user";

/** One request per page load is enough; the server clears the mark. */
let linkRequested = false;

const hasSignupMark = (): boolean =>
  typeof document !== "undefined" &&
  document.cookie
    .split(";")
    .some((part) => part.trim() === `${SIGNUP_GUEST_GAMES_COOKIE}=1`);

/**
 * After a sign-up, sends this browser's anonymous id once the new account is
 * signed in, so its guest games move to the account (task B). The rule and
 * the write are on the server (POST /api/me/guest-games); this only supplies
 * the id, which lives in localStorage and so cannot reach the callback.
 */
export function useLinkGuestGamesAfterSignup(): void {
  const { data } = useQuery(userQueryOptions);
  const signedIn = Boolean(data?.user);

  useEffect(() => {
    if (!signedIn || linkRequested || !hasSignupMark()) return;
    const anonymousId = getAnonymousId();
    if (!anonymousId) return;
    linkRequested = true;
    // Best effort: a failed link leaves the guest games as they were, which
    // is what happened before this existed.
    void api.me["guest-games"]
      .$post({ json: { anonymousId } })
      .catch(() => undefined);
  }, [signedIn]);
}
