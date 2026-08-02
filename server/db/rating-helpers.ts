import { db } from "./index";
import { globalRatingsTable } from "./schema/global-ratings";
import { userAuthTable } from "./schema/users";
import { eq } from "drizzle-orm";

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
 * @param authUserId - The auth provider's user ID (e.g., Kinde ID or test header ID)
 * @returns The user's global rating, or undefined if they have no rating yet
 */
export async function getGlobalRatingForAuthUser(
  authUserId: string,
): Promise<number | undefined> {
  // First get the internal userId from auth mapping
  const authMapping = await db
    .select({ userId: userAuthTable.userId })
    .from(userAuthTable)
    .where(eq(userAuthTable.authUserId, authUserId))
    .limit(1);

  if (authMapping.length === 0) {
    return undefined; // User doesn't exist in DB yet
  }

  const rating = await db
    .select({ rating: globalRatingsTable.rating })
    .from(globalRatingsTable)
    .where(eq(globalRatingsTable.userId, authMapping[0].userId))
    .limit(1);

  return rating[0]?.rating; // undefined if they have not been rated yet
}
