import { db } from "./index";
import { ratingsTable } from "./schema/ratings";
import { userAuthTable } from "./schema/users";
import { eq, and, sql } from "drizzle-orm";
import type { RatingState } from "../games/rating-system";

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

/**
 * Looks up a user's full Glicko-2 rating state from the database based on their auth ID.
 *
 * @param authUserId - The auth provider's user ID (e.g., Kinde ID or test header ID)
 * @param variant - The game variant ("standard" or "classic")
 * @param timeControl - The time control preset ("bullet", "blitz", "rapid", "classical")
 * @returns The user's full rating state, or undefined if not found
 */
export async function getRatingStateForAuthUser(
  authUserId: string,
  variant: string,
  timeControl: string,
): Promise<RatingState | undefined> {
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

  // Then get their full rating state for this variant/time control
  const result = await db
    .select({
      rating: ratingsTable.rating,
      deviation: ratingsTable.ratingDeviation,
      volatility: ratingsTable.volatility,
    })
    .from(ratingsTable)
    .where(
      and(
        eq(ratingsTable.userId, userId),
        eq(ratingsTable.variant, variant),
        eq(ratingsTable.timeControl, timeControl),
      ),
    )
    .limit(1);

  return result[0]; // undefined if no rating exists
}

/**
 * Updates a user's Glicko-2 rating state in the database.
 *
 * @param authUserId - The auth provider's user ID
 * @param variant - The game variant
 * @param timeControl - The time control preset
 * @param newState - The new rating state to save
 * @returns The updated rating value, or undefined if user not found
 */
export async function updateRatingStateForAuthUser(
  authUserId: string,
  variant: string,
  timeControl: string,
  newState: RatingState,
  recordDelta: { wins: number; losses: number },
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

  const winsDelta = recordDelta.wins;
  const lossesDelta = recordDelta.losses;
  const now = new Date();

  // Upsert rating state and record totals.
  await db
    .insert(ratingsTable)
    .values({
      userId,
      variant,
      timeControl,
      rating: newState.rating,
      ratingDeviation: newState.deviation,
      volatility: newState.volatility,
      peakRating: newState.rating,
      recordWins: winsDelta,
      recordLosses: lossesDelta,
      lastGameAt: now,
    })
    .onConflictDoUpdate({
      target: [
        ratingsTable.userId,
        ratingsTable.variant,
        ratingsTable.timeControl,
      ],
      set: {
        rating: newState.rating,
        ratingDeviation: newState.deviation,
        volatility: newState.volatility,
        peakRating: sql`GREATEST(${ratingsTable.peakRating}, ${newState.rating})`,
        recordWins: sql`${ratingsTable.recordWins} + ${winsDelta}`,
        recordLosses: sql`${ratingsTable.recordLosses} + ${lossesDelta}`,
        lastGameAt: now,
      },
    });

  return newState.rating;
}
