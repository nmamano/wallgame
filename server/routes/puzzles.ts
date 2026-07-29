import { Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";

import { db } from "../db";
import { savedPuzzlesTable } from "../db/schema/saved-puzzles";
import { getUserMiddleware, getOptionalUserMiddleware } from "../kinde";
import { getUserIdFromKinde } from "../db/user-helpers";
import {
  hasSolvedGeneratedPuzzle,
  readPuzzleProgress,
  recordScriptedCompletion,
} from "../games/puzzle-progress";
import {
  clearVote,
  readVoteState,
  readVoteStates,
  setVote,
} from "../games/puzzle-votes";
import {
  mapSavedPuzzleRows,
  puzzleVoteRequestSchema,
  scriptedCompletionRequestSchema,
} from "../../shared/contracts/puzzles";
import { PUZZLES } from "../../shared/domain/puzzles";
import {
  createAnonymousWriteLimiter,
  clientIpKey,
} from "./anonymous-write-limiter";

/**
 * Saved puzzles (S-G1): read-only listing of the named persisted puzzles.
 *
 * DB JSONB is untrusted: every row is validated through the shared contract
 * before it is returned; a corrupted enabled row fails the request closed
 * (500) rather than reaching a client's launch flow.
 *
 * This replaces the legacy tutorial-era CRUD route (unauthenticated
 * POST/DELETE on the old `puzzles` table) — that surface is intentionally
 * gone. Seeding/curation happen server-side (scripts/seed-puzzles.ts), not
 * over HTTP.
 *
 * Completion tracking (S-G3) lives here too, in two halves that deliberately
 * do NOT share a trust model — see `/progress` and `/scripted-completions`.
 */

/**
 * Anonymous scripted completions are telemetry, so the cap is generous enough
 * never to trouble a real player (the whole scripted set is 10 puzzles) while
 * bounding abuse of an open write.
 */
const anonymousCompletionLimiter = createAnonymousWriteLimiter({
  limit: 30,
  windowMs: 60 * 60 * 1000,
  maxKeys: 10_000,
});

/**
 * Resolves the target of a vote. Only an ENABLED puzzle may be voted on,
 * matching launch semantics: a retired puzzle is not something a player can
 * be looking at. Existing votes on a retired puzzle stay in the table and
 * come back if it is re-enabled.
 */
const findVotablePuzzle = async (puzzleId: string) => {
  const rows = await db
    .select({ id: savedPuzzlesTable.id })
    .from(savedPuzzlesTable)
    .where(
      and(
        eq(savedPuzzlesTable.id, puzzleId),
        eq(savedPuzzlesTable.enabled, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
};

export const puzzlesRoute = new Hono()
  /**
   * The listing stays PUBLIC. Optional auth adds the caller's own votes when
   * there is a caller; it must never turn this into an authenticated
   * endpoint, because anonymous visitors browse the puzzle list.
   */
  .get("/", getOptionalUserMiddleware, async (c) => {
    try {
      const user = c.get("user");
      const userId = user ? await getUserIdFromKinde(c) : undefined;
      const [rows, voteStates] = await Promise.all([
        db
          .select()
          .from(savedPuzzlesTable)
          .where(eq(savedPuzzlesTable.enabled, true))
          .orderBy(asc(savedPuzzlesTable.sortIndex)),
        readVoteStates(userId),
      ]);
      const puzzles = mapSavedPuzzleRows(rows, voteStates);
      return c.json({ puzzles });
    } catch (error) {
      console.error("[puzzles] failed to list saved puzzles", { error });
      return c.json({ error: "Failed to load puzzles" }, 500);
    }
  })

  /**
   * Which puzzles the logged-in caller has solved. The rule itself lives in
   * `server/games/puzzle-progress.ts`, which is where its reasoning — and its
   * database test — belong.
   *
   * Anonymous callers get 401 rather than empty arrays, so "no identity" is
   * never confused with "authenticated, nothing solved".
   */
  .get("/progress", getUserMiddleware, async (c) => {
    try {
      const userId = await getUserIdFromKinde(c);
      return c.json(await readPuzzleProgress(userId));
    } catch (error) {
      console.error("[puzzles] failed to read progress", { error });
      return c.json({ error: "Failed to load progress" }, 500);
    }
  })

  /**
   * Record a scripted-puzzle completion. Client-asserted by nature — a
   * scripted puzzle is a guided walkthrough with no game to verify — and the
   * id is validated against the known scripted set, so this open path cannot
   * write arbitrary rows.
   *
   * Anonymous writes are accepted because Nil wants usage data, and are rate
   * limited per client IP. They are best-effort telemetry, not unique-user
   * statistics. Authenticated writes are idempotent (one row per user and
   * puzzle) and do not share the anonymous cap.
   */
  .post(
    "/scripted-completions",
    getOptionalUserMiddleware,
    zValidator("json", scriptedCompletionRequestSchema),
    async (c) => {
      const { puzzleId } = c.req.valid("json");
      if (!PUZZLES[puzzleId]) {
        return c.json({ error: "Unknown puzzle" }, 400);
      }

      const user = c.get("user");
      try {
        if (!user) {
          const key = clientIpKey(c.req.raw.headers);
          if (!anonymousCompletionLimiter.tryConsume(key)) {
            return c.json({ error: "Too many requests" }, 429);
          }
          await recordScriptedCompletion({ userId: null, puzzleId });
          return c.json({ success: true });
        }

        const userId = await getUserIdFromKinde(c);
        await recordScriptedCompletion({ userId, puzzleId });
        return c.json({ success: true });
      } catch (error) {
        console.error("[puzzles] failed to record scripted completion", {
          error,
          puzzleId,
        });
        return c.json({ error: "Failed to save progress" }, 500);
      }
    },
  )

  /**
   * One puzzle's vote state for the caller (S-G4). The game page reads this
   * so a vote survives a refresh or a direct revisit, rather than depending
   * on the listing having been fetched or on navigation state.
   */
  .get("/:id/vote", getUserMiddleware, async (c) => {
    const puzzleId = c.req.param("id");
    try {
      if (!(await findVotablePuzzle(puzzleId))) {
        return c.json({ error: "Unknown puzzle" }, 404);
      }
      const userId = await getUserIdFromKinde(c);
      return c.json(await readVoteState(puzzleId, userId));
    } catch (error) {
      console.error("[puzzles] failed to read vote", { error, puzzleId });
      return c.json({ error: "Failed to load vote" }, 500);
    }
  })

  /**
   * Cast, change, or withdraw a vote. A vote is EARNED: the caller must have
   * decisively beaten this puzzle, which is checked with the same query that
   * answers "have I solved it" — see
   * `hasSolvedGeneratedPuzzle` in `server/games/puzzle-progress.ts`. Voting
   * never retires anything; the counts are for Nil to read.
   *
   * Returns the updated state, so the game page and the puzzle card can
   * refresh from one round trip.
   */
  .post(
    "/:id/vote",
    getUserMiddleware,
    zValidator("json", puzzleVoteRequestSchema),
    async (c) => {
      const puzzleId = c.req.param("id");
      const { value } = c.req.valid("json");
      try {
        if (!(await findVotablePuzzle(puzzleId))) {
          return c.json({ error: "Unknown puzzle" }, 404);
        }

        const userId = await getUserIdFromKinde(c);
        if (!(await hasSolvedGeneratedPuzzle(userId, puzzleId))) {
          return c.json({ error: "Beat the puzzle first" }, 403);
        }

        if (value === null) {
          await clearVote({ userId, puzzleId });
        } else {
          await setVote({ userId, puzzleId, value });
        }
        return c.json(await readVoteState(puzzleId, userId));
      } catch (error) {
        console.error("[puzzles] failed to record vote", { error, puzzleId });
        return c.json({ error: "Failed to save vote" }, 500);
      }
    },
  );
