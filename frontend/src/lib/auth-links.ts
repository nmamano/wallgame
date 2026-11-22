/**
 * The links that start a log-in or a sign-up. Each one carries the page to
 * come back to, so the server's callback returns the player there and not to
 * the home page (task B; the server's rule is in server/routes/auth-return.ts).
 *
 * Build the link when it is followed or rendered, from the page the player is
 * on at that moment.
 */

export type AuthAction = "login" | "register";

/** The page the player is on, as a site path with its query. */
export const currentSitePath = (): string =>
  typeof window === "undefined"
    ? "/"
    : `${window.location.pathname}${window.location.search}`;

export const authHref = (
  action: AuthAction,
  returnPath: string = currentSitePath(),
): string => `/api/${action}?return=${encodeURIComponent(returnPath)}`;
