import { db } from "./index";
import { globalRatingsTable } from "./schema/global-ratings";
import { userAuthTable } from "./schema/users";
import { eq } from "drizzle-orm";

/**
 * What a logged-in player is shown before they have a rated result.
 *
 * Matches the rating writer, which already treats a missing row as this
 * number, so the rating on screen is the one their first result is computed
 * from rather than a display-only placeholder.
 */
export const PROVISIONAL_RATING = 1500;

/**
 * Looks up the rating to show beside a player's name in a game.
 *
 * This is the GLOBAL rating - one number per player over every rated game they
 * have played - and not the per-variant, per-time-control one. A player sees
 * one rating while they play, the same number the global leaderboard shows,
 * rather than a different one per lobby they happen to be sitting in. The
 * per-bucket chains still exist and are still updated; they are what the
 * scoped rankings are built from, and nothing in a game reads them.
 *
 * The value reaches the seat as `elo` and `ratingAtStart`, so the rating shown
 * during the game, the change shown when it ends, and the number recorded
 * against the game afterwards are all the same chain.
 *
 * A LOGGED-IN PLAYER ALWAYS HAS A RATING; a guest never does (Nil, 2026-08-02).
 * That boundary was already the rule for playing — a guest cannot take a seat
 * in a rated game at all (`RATED_REQUIRES_LOGIN_MESSAGE`) — and this is the
 * display catching up with it. So this function is total: every caller here
 * has already established that someone is logged in, and the return type says
 * they get a number rather than leaving each caller to invent a fallback.
 *
 * It used to answer `undefined` in two places — no auth mapping yet, and no
 * global-ratings row yet — which left `rating_at_start` NULL for that game and
 * meant a player got no +/- on the first rated game they ever played. Both now
 * answer PROVISIONAL_RATING, which is not a new invention: the rating writer
 * already treats a missing row as exactly this number, so the value shown
 * before the first result is the one it is actually computed from.
 *
 * @param authUserId - The auth provider's user ID (e.g., Kinde ID or test header ID)
 * @returns The user's global rating, or PROVISIONAL_RATING if not yet rated
 */
export async function getGlobalRatingForAuthUser(
  authUserId: string,
): Promise<number> {
  // First get the internal userId from auth mapping
  const authMapping = await db
    .select({ userId: userAuthTable.userId })
    .from(userAuthTable)
    .where(eq(userAuthTable.authUserId, authUserId))
    .limit(1);

  if (authMapping.length === 0) {
    // Logged in, but no row provisioned for them yet. Still a logged-in
    // player, so still a rating.
    return PROVISIONAL_RATING;
  }

  const rating = await db
    .select({ rating: globalRatingsTable.rating })
    .from(globalRatingsTable)
    .where(eq(globalRatingsTable.userId, authMapping[0].userId))
    .limit(1);

  return rating[0]?.rating ?? PROVISIONAL_RATING;
}
