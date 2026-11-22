import { z } from "zod";
import { ANONYMOUS_ID_PATTERN } from "../domain/anonymous-id";

export interface User {
  id: string;
  email?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  picture?: string | null;
}

export interface MeResponse {
  user: User | null;
}

/**
 * A sign-up links this browser's earlier guest games to the new account
 * (task B; Nil, 2026-11-22: all of this browser's guest games; on a shared
 * browser they go to whoever signs up there first).
 *
 * /api/register sets this cookie; the page sees it once the new account is
 * signed in and sends the browser's anonymous id. Only the page knows that id
 * (it lives in localStorage), so the link cannot happen in the callback.
 * A plain log-in clears the cookie: it links nothing.
 */
export const SIGNUP_GUEST_GAMES_COOKIE = "wg_signup_guest_games";

export const linkGuestGamesSchema = z.object({
  anonymousId: z.string().regex(ANONYMOUS_ID_PATTERN),
});

export interface LinkGuestGamesResponse {
  /** Seats newly linked to the account. */
  linked: number;
}
