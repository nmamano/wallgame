import { and, eq, isNotNull, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "../db";
import { gamesTable } from "../db/schema/games";
import { gamePlayersTable } from "../db/schema/game-players";
import { scriptedPuzzleCompletionsTable } from "../db/schema/scripted-puzzle-completions";
import type { PuzzleProgressResponse } from "../../shared/contracts/puzzles";

/**
 * Which puzzles a user has solved (S-G3).
 *
 * Lives apart from the route so the rule below can be exercised against a
 * real database without standing up authentication: the route is auth plus
 * delegation, this is the whole of the logic.
 *
 * GENERATED puzzles are SERVER-VERIFIED and derived rather than stored: a
 * solve is a persisted game that the server itself launched as a puzzle
 * (`games.puzzle_id`) and that the user won DECISIVELY.
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
 * SCRIPTED puzzles are client-asserted and simply read back.
 */
export const readPuzzleProgress = async (
  userId: number,
): Promise<PuzzleProgressResponse> => {
  const opponent = alias(gamePlayersTable, "opponent");

  const [generated, scripted] = await Promise.all([
    db
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
      .where(isNotNull(gamesTable.puzzleId)),
    db
      .selectDistinct({ puzzleId: scriptedPuzzleCompletionsTable.puzzleId })
      .from(scriptedPuzzleCompletionsTable)
      .where(eq(scriptedPuzzleCompletionsTable.userId, userId)),
  ]);

  // Sorted so responses are deterministic for caching and assertions.
  return {
    solvedGeneratedIds: generated
      .map((row) => row.puzzleId)
      .filter((id): id is string => id != null)
      .sort(),
    solvedScriptedIds: scripted.map((row) => row.puzzleId).sort(),
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
