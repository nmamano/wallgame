import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";

import { db } from "../db";
import { savedPuzzlesTable } from "../db/schema/saved-puzzles";
import { getUserMiddleware, getOptionalUserMiddleware } from "../kinde";
import { getUserIdFromKinde } from "../db/user-helpers";
import {
  readPuzzleProgress,
  recordScriptedCompletion,
} from "../games/puzzle-progress";
import {
  mapSavedPuzzleRows,
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

export const puzzlesRoute = new Hono()
  .get("/", async (c) => {
    try {
      const rows = await db
        .select()
        .from(savedPuzzlesTable)
        .where(eq(savedPuzzlesTable.enabled, true))
        .orderBy(asc(savedPuzzlesTable.sortIndex));
      const puzzles = mapSavedPuzzleRows(rows);
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
  );
