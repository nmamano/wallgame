/**
 * Copies the legacy `campaign_progress` rows into
 * `campaign_level_completions` (S-CAMP). Runs INSIDE the deployed Fly machine
 * (which has DATABASE_URL); it is NOT part of release_command — data moves
 * are a deliberate manual step run right after the migration deploy:
 *
 *   fly ssh console -a wallgame -C "bun scripts/backfill-campaign-completions.ts"
 *
 * This preserves progress that is ALREADY authoritative server-side; it does
 * not infer historical completions from anything. Until it has run and been
 * verified, `readCampaignProgress` unions both tables, so a player's markers
 * survive the window either way.
 *
 * Fail-closed and idempotent, in one transaction: the legacy snapshot must be
 * non-empty and every legacy level id must belong to the known level set;
 * each legacy key is upserted with the LEGACY timestamp winning on conflict
 * (legacy is canonical for pre-migration state); then every captured legacy
 * triple is read back and proven present, or the whole thing rolls back.
 *
 * It deliberately does NOT require the target table to equal the legacy
 * table: anonymous telemetry rows and completions written after the deploy
 * are valid target rows. Those extras are reported, not treated as drift.
 *
 * Safe to re-run, and MEANT to be re-run before the legacy read is removed.
 */

import { isNotNull } from "drizzle-orm";
import { db } from "../server/db";
import { campaignProgressTable } from "../server/db/schema/campaign-progress";
import { campaignLevelCompletionsTable } from "../server/db/schema/campaign-level-completions";
import { SOLO_CAMPAIGN_LEVELS } from "../shared/domain/solo-campaign-levels";

const key = (row: { userId: number; levelId: string }) =>
  `${row.userId}:${row.levelId}`;

const main = async () => {
  await db.transaction(async (tx) => {
    const legacy = await tx
      .select({
        userId: campaignProgressTable.userId,
        levelId: campaignProgressTable.levelId,
        completedAt: campaignProgressTable.completedAt,
      })
      .from(campaignProgressTable);

    if (legacy.length === 0) {
      throw new Error(
        "abort: campaign_progress is empty — refusing to 'backfill' nothing, since that would silently look like success",
      );
    }

    const unknown = legacy.filter((row) => !SOLO_CAMPAIGN_LEVELS[row.levelId]);
    if (unknown.length > 0) {
      throw new Error(
        `abort: ${unknown.length} legacy row(s) name levels outside the known set: ${[
          ...new Set(unknown.map((row) => row.levelId)),
        ].join(", ")}`,
      );
    }

    const users = new Set(legacy.map((row) => row.userId)).size;
    const levels = new Set(legacy.map((row) => row.levelId)).size;
    console.log(
      `preflight: ${legacy.length} legacy rows, ${users} users, ${levels} levels, all level ids known`,
    );

    for (const row of legacy) {
      await tx
        .insert(campaignLevelCompletionsTable)
        .values({
          userId: row.userId,
          levelId: row.levelId,
          completedAt: row.completedAt,
        })
        .onConflictDoUpdate({
          target: [
            campaignLevelCompletionsTable.userId,
            campaignLevelCompletionsTable.levelId,
          ],
          // The legacy value is the authoritative pre-migration record for
          // this level — what campaign_progress last stored, since the old
          // route restamped on every repeat completion. A row written after
          // the deploy carries a post-migration timestamp that would
          // otherwise replace it.
          set: { completedAt: row.completedAt },
        });
    }

    // Read back INSIDE the transaction: every captured legacy triple must be
    // present, with its timestamp intact. Anything missing rolls the batch
    // back rather than reporting a success nobody checked.
    const targetRows = await tx
      .select({
        userId: campaignLevelCompletionsTable.userId,
        levelId: campaignLevelCompletionsTable.levelId,
        completedAt: campaignLevelCompletionsTable.completedAt,
      })
      .from(campaignLevelCompletionsTable)
      .where(isNotNull(campaignLevelCompletionsTable.userId));

    // The isNotNull filter above is a SQL predicate, which the column type
    // does not know about; this narrows it for the comparisons below.
    const target = targetRows.flatMap((row) =>
      row.userId === null ? [] : [{ ...row, userId: row.userId }],
    );
    const targetByKey = new Map(target.map((row) => [key(row), row]));

    const missing = legacy.filter((row) => !targetByKey.has(key(row)));
    if (missing.length > 0) {
      throw new Error(
        `abort: ${missing.length} legacy row(s) absent after the write — rolled back`,
      );
    }

    const wrongTimestamp = legacy.filter((row) => {
      const found = targetByKey.get(key(row))!;
      return found.completedAt.getTime() !== row.completedAt.getTime();
    });
    if (wrongTimestamp.length > 0) {
      throw new Error(
        `abort: ${wrongTimestamp.length} row(s) read back with a different completed_at — rolled back`,
      );
    }

    const legacyKeys = new Set(legacy.map(key));
    const extras = target.filter((row) => !legacyKeys.has(key(row)));
    console.log(
      `read-back: all ${legacy.length} legacy rows present with matching timestamps; ` +
        `${extras.length} additional authenticated row(s) in the target (completions written after the deploy — expected, not drift)`,
    );
  });

  // Read after the transaction commits, so the summary describes the state
  // that actually landed.
  const committed = await db
    .select({ userId: campaignLevelCompletionsTable.userId })
    .from(campaignLevelCompletionsTable);
  const anonymous = committed.filter((row) => row.userId === null).length;
  console.log(
    `backfill complete: campaign_level_completions holds ${committed.length} rows ` +
      `(${committed.length - anonymous} authenticated, ${anonymous} anonymous telemetry)`,
  );
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
