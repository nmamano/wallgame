import { eq } from "drizzle-orm";

import { db } from "../db";
import { campaignLevelCompletionsTable } from "../db/schema/campaign-level-completions";
import { campaignProgressTable } from "../db/schema/campaign-progress";
import type { CampaignProgressResponse } from "../../shared/contracts/campaign";

/**
 * Solo-campaign completion (S-CAMP).
 *
 * Lives apart from the route for the same reason `puzzle-progress.ts` does:
 * the route is auth plus delegation, this is the whole of the logic, and a
 * container-backed test can exercise the real SQL here without standing up
 * authentication.
 *
 * Campaign levels run entirely client-side against a local AI, so there is no
 * game for the server to verify. Completion is CLIENT-ASSERTED — the same
 * trust model as the scripted puzzles, and the same one campaign progress has
 * always had.
 *
 * TRANSITIONAL DUAL READ — do not "simplify" this away.
 * Writes go only to `campaign_level_completions`. Reads union it with the
 * legacy `campaign_progress` table, which holds real progress written before
 * this slice (15 rows / 10 users in production at the time of writing). The
 * legacy read covers the window between deploying and running
 * `scripts/backfill-campaign-completions.ts`, a machine still finishing an
 * in-flight legacy write during rollout, and a backfill that fails — in none
 * of those cases may a player's markers disappear. It is removed in the
 * contract step of the migration, once the backfill has been re-run and
 * verified; the legacy table is dropped later still. See
 * `plans/puzzle-loop-4.md`.
 */
export const readCampaignProgress = async (
  userId: number,
): Promise<CampaignProgressResponse> => {
  const [current, legacy] = await Promise.all([
    db
      .selectDistinct({ levelId: campaignLevelCompletionsTable.levelId })
      .from(campaignLevelCompletionsTable)
      .where(eq(campaignLevelCompletionsTable.userId, userId)),
    db
      .selectDistinct({ levelId: campaignProgressTable.levelId })
      .from(campaignProgressTable)
      .where(eq(campaignProgressTable.userId, userId)),
  ]);

  // Distinct across both sources, and sorted, so the response is
  // deterministic for caching and assertions regardless of which table a
  // level was recorded in.
  const completedLevels = [
    ...new Set([...current, ...legacy].map((row) => row.levelId)),
  ].sort();

  return { completedLevels };
};

/**
 * Record a campaign-level completion.
 *
 * `userId` null means an anonymous completion, kept as usage telemetry. The
 * table's UNIQUE (user_id, level_id) makes the logged-in write idempotent
 * while letting anonymous rows accumulate, because PostgreSQL treats NULLs as
 * distinct in a unique constraint.
 *
 * A repeat completion by a logged-in player leaves the existing row alone
 * rather than restamping it: nothing reads the timestamp for progress, and
 * leaving it alone means a backfilled row keeps the legacy-recorded value —
 * which is what `campaign_progress` last recorded for that level, since the
 * old route restamped on every repeat. That value is the authoritative
 * pre-migration record; it is not a claim about when the level was first
 * beaten.
 */
export const recordCampaignCompletion = async (args: {
  userId: number | null;
  levelId: string;
}): Promise<void> => {
  if (args.userId == null) {
    await db
      .insert(campaignLevelCompletionsTable)
      .values({ levelId: args.levelId });
    return;
  }

  await db
    .insert(campaignLevelCompletionsTable)
    .values({ userId: args.userId, levelId: args.levelId })
    .onConflictDoNothing({
      target: [
        campaignLevelCompletionsTable.userId,
        campaignLevelCompletionsTable.levelId,
      ],
    });
};
