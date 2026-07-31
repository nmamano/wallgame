import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./index";
import { ratingsTable } from "./schema/ratings";
import { globalRatingsTable } from "./schema/global-ratings";
import { ratingEventsTable } from "./schema/rating-events";
import { usersTable, userAuthTable } from "./schema/users";
import { applyRatedGame } from "../games/rated-game";
import { initialRating, type RatingState } from "../games/rating-system";
import type { Outcome } from "../games/rating-system";
import type { RecordDelta } from "../games/rated-game";

/**
 * Applies one finished game to both rating chains, atomically and at most once.
 *
 * This replaces a write path with two defects that adding a second chain would
 * have doubled:
 *
 * 1. The two per-bucket upserts used to run as an unguarded `Promise.all`, so a
 *    failure between them left one player's rating moved and the other's not.
 *    Four independently committing writes would have been worse.
 * 2. Nothing recorded that a game had been rated. `processRatingUpdate` re-reads
 *    `status === "finished"`, which stays true forever, so two finish paths
 *    interleaving would rate the same game twice.
 *
 * Both are fixed here rather than worked around: one transaction, deterministic
 * locking, and a ledger row that makes a second attempt a no-op.
 */

export interface AppliedRatings {
  oldBucketA: number;
  oldBucketB: number;
  bucketA: number;
  bucketB: number;
  globalA: number;
  globalB: number;
}

interface Args {
  gameId: string;
  authUserIdA: string;
  authUserIdB: string;
  variant: string;
  timeControl: string;
  outcomeForA: Outcome;
}

/**
 * Returns undefined when the game was already rated, when either player is not
 * a known user, or when both seats are the same user - never a partial write,
 * and never by throwing.
 *
 * The order inside the transaction is deliberate: resolve and lock the players
 * FIRST, claim the ledger row only once the game is known to be ratable. An
 * earlier version claimed the ledger first and called `tx.rollback()` when the
 * users did not resolve - but drizzle types that `rollback(): never` and it
 * throws, which would have propagated out through `processRatingUpdate` on
 * every finish path, ahead of the try/catch that guards persistence. A game
 * with an unresolvable account would have failed to persist and to broadcast.
 */
export const applyRatingsForFinishedGame = async (
  args: Args,
): Promise<AppliedRatings | undefined> => {
  return db.transaction(async (tx) => {
    const ids = await tx
      .select({
        userId: userAuthTable.userId,
        authUserId: userAuthTable.authUserId,
      })
      .from(userAuthTable)
      .where(
        inArray(userAuthTable.authUserId, [args.authUserIdA, args.authUserIdB]),
      );

    const userIdA = ids.find((r) => r.authUserId === args.authUserIdA)?.userId;
    const userIdB = ids.find((r) => r.authUserId === args.authUserIdB)?.userId;
    if (userIdA == null || userIdB == null || userIdA === userIdB) {
      // Nothing has been written, so there is nothing to roll back. The ledger
      // is deliberately left unclaimed: a transiently unresolved account should
      // stay ratable, and a same-user game was never a rating event at all.
      console.info("[ratings] not a ratable pairing, skipping", {
        gameId: args.gameId,
      });
      return undefined;
    }

    /*
    Lock the USER rows, not the rating rows.

    `SELECT ... FOR UPDATE` locks rows that exist, and a player's first ever
    rated game has no rating row to lock - so two concurrent transactions would
    both read "no rating", both compute from 1500, and the second upsert would
    quietly discard the first game. Users always exist. Ordering by user_id
    means two games sharing a player queue up instead of deadlocking.
    */
    const locked = await tx
      .select({ userId: usersTable.userId })
      .from(usersTable)
      .where(inArray(usersTable.userId, [userIdA, userIdB]))
      .orderBy(usersTable.userId)
      .for("update");

    // An auth mapping can outlive the user row it points at. Check rather than
    // assume, or the game would be rated against a player who no longer exists.
    if (locked.length !== 2) {
      console.warn("[ratings] expected two user rows, skipping", {
        gameId: args.gameId,
        found: locked.length,
      });
      return undefined;
    }

    // The ledger last: by here the game is known to be ratable, so claiming it
    // and finding it already claimed genuinely means "already applied".
    const claimed = await tx
      .insert(ratingEventsTable)
      .values({ gameId: args.gameId })
      .onConflictDoNothing()
      .returning({ gameId: ratingEventsTable.gameId });

    if (claimed.length === 0) {
      console.info("[ratings] already applied, skipping", {
        gameId: args.gameId,
      });
      return undefined;
    }

    const bucket = await readStates(tx, ratingsTable, {
      userIdA,
      userIdB,
      variant: args.variant,
      timeControl: args.timeControl,
    });
    const bucketResult = applyRatedGame(bucket, args.outcomeForA);

    const now = new Date();
    await upsertBucket(tx, {
      userId: userIdA,
      variant: args.variant,
      timeControl: args.timeControl,
      state: bucketResult.a,
      record: bucketResult.recordA,
      now,
    });
    await upsertBucket(tx, {
      userId: userIdB,
      variant: args.variant,
      timeControl: args.timeControl,
      state: bucketResult.b,
      record: bucketResult.recordB,
      now,
    });

    // Each player's global rating is updated against the opponent's GLOBAL
    // rating. Reading a per-bucket rating here would make the result depend on
    // whichever variant the opponent happened to play most, and it would not be
    // a Glicko-2 rating of anything.
    const global = await readStates(tx, globalRatingsTable, {
      userIdA,
      userIdB,
    });
    const globalResult = applyRatedGame(global, args.outcomeForA);

    await upsertGlobal(tx, {
      userId: userIdA,
      state: globalResult.a,
      record: globalResult.recordA,
      now,
    });
    await upsertGlobal(tx, {
      userId: userIdB,
      state: globalResult.b,
      record: globalResult.recordB,
      now,
    });

    return {
      oldBucketA: bucket.a.rating,
      oldBucketB: bucket.b.rating,
      bucketA: bucketResult.a.rating,
      bucketB: bucketResult.b.rating,
      globalA: globalResult.a.rating,
      globalB: globalResult.b.rating,
    };
  });
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Reads both players' state from either chain; missing rows start at 1500. */
const readStates = async (
  tx: Tx,
  table: typeof ratingsTable | typeof globalRatingsTable,
  args: {
    userIdA: number;
    userIdB: number;
    variant?: string;
    timeControl?: string;
  },
): Promise<{ a: RatingState; b: RatingState }> => {
  const scoped =
    table === ratingsTable && args.variant != null && args.timeControl != null
      ? and(
          inArray(ratingsTable.userId, [args.userIdA, args.userIdB]),
          eq(ratingsTable.variant, args.variant),
          eq(ratingsTable.timeControl, args.timeControl),
        )
      : inArray(table.userId, [args.userIdA, args.userIdB]);

  const rows = await tx
    .select({
      userId: table.userId,
      rating: table.rating,
      deviation: table.ratingDeviation,
      volatility: table.volatility,
    })
    .from(table)
    .where(scoped);

  const stateFor = (userId: number): RatingState => {
    const row = rows.find((r) => r.userId === userId);
    return row
      ? {
          rating: row.rating,
          deviation: row.deviation,
          volatility: row.volatility,
        }
      : initialRating();
  };

  return { a: stateFor(args.userIdA), b: stateFor(args.userIdB) };
};

const upsertBucket = async (
  tx: Tx,
  args: {
    userId: number;
    variant: string;
    timeControl: string;
    state: RatingState;
    record: RecordDelta;
    now: Date;
  },
): Promise<void> => {
  await tx
    .insert(ratingsTable)
    .values({
      userId: args.userId,
      variant: args.variant,
      timeControl: args.timeControl,
      rating: args.state.rating,
      ratingDeviation: args.state.deviation,
      volatility: args.state.volatility,
      peakRating: args.state.rating,
      recordWins: args.record.wins,
      recordLosses: args.record.losses,
      lastGameAt: args.now,
    })
    .onConflictDoUpdate({
      target: [
        ratingsTable.userId,
        ratingsTable.variant,
        ratingsTable.timeControl,
      ],
      set: {
        rating: args.state.rating,
        ratingDeviation: args.state.deviation,
        volatility: args.state.volatility,
        peakRating: sql`GREATEST(${ratingsTable.peakRating}, ${args.state.rating})`,
        recordWins: sql`${ratingsTable.recordWins} + ${args.record.wins}`,
        recordLosses: sql`${ratingsTable.recordLosses} + ${args.record.losses}`,
        lastGameAt: args.now,
      },
    });
};

const upsertGlobal = async (
  tx: Tx,
  args: {
    userId: number;
    state: RatingState;
    record: RecordDelta;
    now: Date;
  },
): Promise<void> => {
  await tx
    .insert(globalRatingsTable)
    .values({
      userId: args.userId,
      rating: args.state.rating,
      ratingDeviation: args.state.deviation,
      volatility: args.state.volatility,
      peakRating: args.state.rating,
      recordWins: args.record.wins,
      recordLosses: args.record.losses,
      lastGameAt: args.now,
    })
    .onConflictDoUpdate({
      target: globalRatingsTable.userId,
      set: {
        rating: args.state.rating,
        ratingDeviation: args.state.deviation,
        volatility: args.state.volatility,
        peakRating: sql`GREATEST(${globalRatingsTable.peakRating}, ${args.state.rating})`,
        recordWins: sql`${globalRatingsTable.recordWins} + ${args.record.wins}`,
        recordLosses: sql`${globalRatingsTable.recordLosses} + ${args.record.losses}`,
        lastGameAt: args.now,
      },
    });
};
