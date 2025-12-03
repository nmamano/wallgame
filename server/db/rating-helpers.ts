import { db } from "./index";
import { ratingsTable } from "./schema/ratings";
import { userAuthTable } from "./schema/users";
import { eq, and } from "drizzle-orm";

/**
 * Looks up a user's rating from the database based on their auth ID.
 *
 * @param authUserId - The auth provider's user ID (e.g., Kinde ID or test header ID)
 * @param variant - The game variant ("standard" or "classic")
 * @param timeControl - The time control preset ("bullet", "blitz", "rapid", "classical")
 * @returns The user's rating, or undefined if not found
 */
export async function getRatingForAuthUser(
  authUserId: string,
  variant: string,
  timeControl: string,
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

  const userId = authMapping[0].userId;

  // Then get their rating for this variant/time control
  const rating = await db
    .select({ rating: ratingsTable.rating })
    .from(ratingsTable)
    .where(
      and(
        eq(ratingsTable.userId, userId),
        eq(ratingsTable.variant, variant),
        eq(ratingsTable.timeControl, timeControl),
      ),
    )
    .limit(1);

  return rating[0]?.rating; // undefined if no rating exists
}
