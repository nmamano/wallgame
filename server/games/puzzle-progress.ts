import { and, eq, isNotNull, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "../db";
import { gamesTable } from "../db/schema/games";
import { gamePlayersTable } from "../db/schema/game-players";
import { scriptedPuzzleCompletionsTable } from "../db/schema/scripted-puzzle-completions";
import { readCampaignProgress } from "./campaign-progress";
import type { PuzzleProgressResponse } from "../../shared/contracts/puzzles";

/**
 * Which puzzles a user has finished (S-G3), and the eligibility check that
 * voting is built on (S-G4).
 *
 * Lives apart from the routes so the rules below can be exercised against a
 * real database without standing up authentication: the routes are auth plus
 * delegation, this is the whole of the logic.
 *
 * TWO KINDS OF EVIDENCE, and the difference is the point of this file:
 *
 * VERIFIED — the server watched it happen. A solve is a persisted game that
 * the server itself launched as a puzzle (`games.puzzle_id`) and that the user
 * won DECISIVELY. Unforgeable, and the only thing voting will accept.
 *
 * "Decisively" is the load-bearing word. `buildOutcomeRank` awards rank 1 to
 * BOTH players when a game has no winner, so "my row is rank 1" also matches
 * every draw — and production holds real drawn puzzle games. Requiring the
 * opponent's row to be rank 2 is what excludes them.
 *
 * A further consequence of how games are persisted: a game that ends before
 * both players have moved is treated as aborted and never stored at all
 * (`MIN_MOVES_FOR_A_COUNTED_GAME`), so an unwinnable-in-one-ply assumption is
 * baked in here. `tests/game/generated-puzzle-counted-game.test.ts` pins it.
 *
 * ASSERTED — the client said so. A puzzle played against its authored line
 * produces no game record to check, so its completion is simply read back.
 * These mark a card solved and buy nothing else.
 *
 * Both now name saved_puzzles rows: the handcrafted set moved into that table,
 * so the old "1".."10" ids are gone and the split is purely about evidence.
 */
/**
 * THE decisive-win query. Every caller that asks "did the server watch this
 * user win this puzzle" goes through here, so the rule — and its rank-2
 * subtlety — exists exactly once. `puzzleId` narrows it to a single puzzle;
 * omitting it returns every puzzle the user has solved.
 */
const decisiveSavedPuzzleSolves = (userId: number, puzzleId?: string) => {
  const opponent = alias(gamePlayersTable, "opponent");

  return db
    .selectDistinct({ puzzleId: gamesTable.puzzleId })
    .from(gamesTable)
    .innerJoin(
      gamePlayersTable,
      and(
        eq(gamePlayersTable.gameId, gamesTable.gameId),
        eq(gamePlayersTable.userId, userId),
        eq(gamePlayersTable.outcomeRank, 1),
      ),
    )
    .innerJoin(
      opponent,
      and(
        eq(opponent.gameId, gamesTable.gameId),
        ne(opponent.playerOrder, gamePlayersTable.playerOrder),
        eq(opponent.outcomeRank, 2),
      ),
    )
    .where(
      puzzleId === undefined
        ? isNotNull(gamesTable.puzzleId)
        : eq(gamesTable.puzzleId, puzzleId),
    );
};

/**
 * Which saved puzzles the server watched the user win. Sorted, so callers
 * and their tests see a deterministic list.
 */
export const readVerifiedSolvedSavedPuzzleIds = async (
  userId: number,
): Promise<string[]> =>
  (await decisiveSavedPuzzleSolves(userId))
    .map((row) => row.puzzleId)
    .filter((id): id is string => id != null)
    .sort();

/**
 * Whether the server watched the user win ONE puzzle — the eligibility check
 * behind voting (S-G4). Deliberately not "read all progress and look inside
 * it": a vote is earned by BEATING a puzzle, so a client-asserted completion
 * must never reach this answer, and asking the database one narrow question is
 * what guarantees it cannot.
 */
export const hasVerifiedSavedPuzzleSolve = async (
  userId: number,
  puzzleId: string,
): Promise<boolean> =>
  (await decisiveSavedPuzzleSolves(userId, puzzleId).limit(1)).length > 0;

export const readPuzzleProgress = async (
  userId: number,
): Promise<PuzzleProgressResponse> => {
  const [verified, asserted, campaign] = await Promise.all([
    readVerifiedSolvedSavedPuzzleIds(userId),
    db
      .selectDistinct({ puzzleId: scriptedPuzzleCompletionsTable.puzzleId })
      .from(scriptedPuzzleCompletionsTable)
      .where(eq(scriptedPuzzleCompletionsTable.userId, userId)),
    // Campaign levels live on the /puzzles page since S-FOLD, so they are part
    // of this one read. `readCampaignProgress` is CALLED rather than
    // reimplemented: it contains the deliberate transitional union over
    // campaign_progress and campaign_level_completions, and a second copy of
    // that SQL would be a second thing to remember when the legacy half is
    // finally dropped.
    readCampaignProgress(userId),
  ]);

  // Sorted so responses are deterministic for caching and assertions.
  return {
    verifiedSolvedSavedPuzzleIds: verified,
    assertedCompletedSavedPuzzleIds: asserted.map((row) => row.puzzleId).sort(),
    completedCampaignLevelIds: campaign.completedLevels,
  };
};

/**
 * Record a scripted-puzzle completion.
 *
 * `userId` null means an anonymous completion, kept as usage telemetry. The
 * table's UNIQUE (user_id, puzzle_id) makes the logged-in write idempotent
 * while letting anonymous rows accumulate, because PostgreSQL treats NULLs as
 * distinct in a unique constraint.
 */
export const recordScriptedCompletion = async (args: {
  userId: number | null;
  puzzleId: string;
}): Promise<void> => {
  if (args.userId == null) {
    await db
      .insert(scriptedPuzzleCompletionsTable)
      .values({ puzzleId: args.puzzleId });
    return;
  }

  await db
    .insert(scriptedPuzzleCompletionsTable)
    .values({ userId: args.userId, puzzleId: args.puzzleId })
    .onConflictDoNothing({
      target: [
        scriptedPuzzleCompletionsTable.userId,
        scriptedPuzzleCompletionsTable.puzzleId,
      ],
    });
};
