import { and, count, eq, sql } from "drizzle-orm";

import { db } from "../db";
import { puzzleVotesTable } from "../db/schema/puzzle-votes";
import type { PuzzleVoteState } from "../../shared/contracts/puzzles";

/**
 * Puzzle likes and dislikes (S-G4).
 *
 * Owns eligibility reuse, vote persistence, and the aggregate reads. It knows
 * nothing about HTTP or about how the puzzle listing is shaped — the route
 * composes that.
 *
 * Reads are deliberately NOT per puzzle: the listing needs counts for every
 * puzzle, so it takes ONE grouped aggregate plus at most ONE query for the
 * caller's own votes, never a query per card.
 */

/** Counts with no votes yet, so a puzzle absent from the aggregate still answers. */
const NO_VOTES: PuzzleVoteState = { likes: 0, dislikes: 0, myVote: null };

const toMyVote = (value: number | undefined): 1 | -1 | null =>
  value === 1 ? 1 : value === -1 ? -1 : null;

/**
 * Counts for every puzzle that has any votes, keyed by puzzle id, plus the
 * caller's own vote where they cast one. Puzzles with no votes are simply
 * absent — callers default them through `voteStateFor`.
 */
export const readVoteStates = async (
  userId?: number,
): Promise<Map<string, PuzzleVoteState>> => {
  const [aggregates, mine] = await Promise.all([
    db
      .select({
        puzzleId: puzzleVotesTable.puzzleId,
        likes: count(sql`case when ${puzzleVotesTable.value} = 1 then 1 end`),
        dislikes: count(
          sql`case when ${puzzleVotesTable.value} = -1 then 1 end`,
        ),
      })
      .from(puzzleVotesTable)
      .groupBy(puzzleVotesTable.puzzleId),
    userId === undefined
      ? Promise.resolve([])
      : db
          .select({
            puzzleId: puzzleVotesTable.puzzleId,
            value: puzzleVotesTable.value,
          })
          .from(puzzleVotesTable)
          .where(eq(puzzleVotesTable.userId, userId)),
  ]);

  const myVotes = new Map(mine.map((row) => [row.puzzleId, row.value]));
  const states = new Map<string, PuzzleVoteState>();
  for (const row of aggregates) {
    states.set(row.puzzleId, {
      likes: row.likes,
      dislikes: row.dislikes,
      myVote: toMyVote(myVotes.get(row.puzzleId)),
    });
  }
  // A caller's own vote implies a row, so this loop cannot add puzzles the
  // aggregate missed — it is here only if the two reads ever disagree.
  for (const [puzzleId, value] of myVotes) {
    if (!states.has(puzzleId)) {
      states.set(puzzleId, { ...NO_VOTES, myVote: toMyVote(value) });
    }
  }
  return states;
};

/** The state of one puzzle, defaulting a puzzle nobody has voted on. */
export const voteStateFor = (
  states: Map<string, PuzzleVoteState>,
  puzzleId: string,
): PuzzleVoteState => states.get(puzzleId) ?? NO_VOTES;

/**
 * One puzzle's counts and the caller's own vote. Used by the game page,
 * which must be able to recover an existing vote on a refresh without having
 * fetched the whole listing.
 */
export const readVoteState = async (
  puzzleId: string,
  userId?: number,
): Promise<PuzzleVoteState> => {
  const [aggregate, mine] = await Promise.all([
    db
      .select({
        likes: count(sql`case when ${puzzleVotesTable.value} = 1 then 1 end`),
        dislikes: count(
          sql`case when ${puzzleVotesTable.value} = -1 then 1 end`,
        ),
      })
      .from(puzzleVotesTable)
      .where(eq(puzzleVotesTable.puzzleId, puzzleId)),
    userId === undefined
      ? Promise.resolve([])
      : db
          .select({ value: puzzleVotesTable.value })
          .from(puzzleVotesTable)
          .where(
            and(
              eq(puzzleVotesTable.puzzleId, puzzleId),
              eq(puzzleVotesTable.userId, userId),
            ),
          ),
  ]);

  return {
    likes: aggregate[0]?.likes ?? 0,
    dislikes: aggregate[0]?.dislikes ?? 0,
    myVote: toMyVote(mine[0]?.value),
  };
};

/**
 * Cast or change a vote. One row per user and puzzle, so a second vote
 * updates the existing row rather than adding another; `updatedAt` moves,
 * `createdAt` keeps saying when this player first had an opinion.
 */
export const setVote = async (args: {
  userId: number;
  puzzleId: string;
  value: 1 | -1;
}): Promise<void> => {
  await db
    .insert(puzzleVotesTable)
    .values({
      userId: args.userId,
      puzzleId: args.puzzleId,
      value: args.value,
    })
    .onConflictDoUpdate({
      target: [puzzleVotesTable.userId, puzzleVotesTable.puzzleId],
      set: { value: args.value, updatedAt: new Date() },
    });
};

/** Withdraw a vote entirely — the way back from a misclick. */
export const clearVote = async (args: {
  userId: number;
  puzzleId: string;
}): Promise<void> => {
  await db
    .delete(puzzleVotesTable)
    .where(
      and(
        eq(puzzleVotesTable.userId, args.userId),
        eq(puzzleVotesTable.puzzleId, args.puzzleId),
      ),
    );
};
