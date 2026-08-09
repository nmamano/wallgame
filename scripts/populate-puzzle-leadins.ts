/**
 * Populates saved_puzzles.lead_in for every human-as-P2 row (S-P1). Runs
 * INSIDE the deployed Fly machine (which has DATABASE_URL); it is NOT part
 * of release_command — population is a deliberate manual step run right
 * after the migration deploy:
 *
 *   fly ssh console -a wallgame -C "bun scripts/populate-puzzle-leadins.ts"
 *
 * Covers ALL rows including disabled ones (re-enabling a puzzle later must
 * never resurrect un-populated behavior). Fail-closed: every row is parsed
 * through the DB contract; each P2 row's lead-in is computed by the
 * heuristic and proven by replay to land exactly on the curated position
 * BEFORE any write; P1 rows are asserted to stay null; the update runs in
 * one transaction asserting the exact affected-row count; all rows are read
 * back and re-asserted. Idempotent: rows already carrying the expected
 * lead-in are skipped; any OTHER pre-existing lead-in aborts.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../server/db";
import { savedPuzzlesTable } from "../server/db/schema/saved-puzzles";
import { savedPuzzleDbRowSchema } from "../shared/contracts/puzzles";
import {
  computeLeadIn,
  validateLeadInReplay,
} from "../shared/domain/puzzle-lead-in";
import {
  buildSavedPuzzleSeedRows,
  rowMatchesSeedIdentity,
} from "../shared/domain/saved-puzzles";
import { generateCustomSetupCandidates } from "../shared/domain/generated-custom-setup-candidates";
import verdictFile from "../shared/domain/generated-custom-setup-verdicts.json";
import type { CandidateVerdictFile } from "../shared/domain/custom-setup-verdicts";

/** The committed batch this one-time write is allowed to touch. */
const EXPECTED_CENSUS = { total: 41, p1: 22, p2: 19, cat: 11, mouse: 8 };

const main = async () => {
  const rawRows = await db.select().from(savedPuzzlesTable);
  const rows = rawRows.map((raw) => savedPuzzleDbRowSchema.parse(raw));
  const enabledCount = rows.filter((row) => row.enabled).length;
  console.log(`pre-write: ${rows.length} rows total, ${enabledCount} enabled`);

  // Exact-set preflight against the committed source batch: the DB must hold
  // EXACTLY the seed rows (by identity fingerprint) with matching name,
  // config, and expected lead-in, and the batch census must be the known
  // 41/22/19/11/8. A missing, extra, or drifted row aborts before any write.
  const seedRows = buildSavedPuzzleSeedRows(
    generateCustomSetupCandidates(),
    verdictFile as CandidateVerdictFile,
  );
  const seedByFingerprint = new Map(
    seedRows.map((seed) => [seed.sourceFingerprint, seed]),
  );
  const dbFingerprints = new Set(rows.map((row) => row.sourceFingerprint));
  const missing = seedRows.filter(
    (seed) => !dbFingerprints.has(seed.sourceFingerprint),
  );
  const extra = rows.filter(
    (row) => !seedByFingerprint.has(row.sourceFingerprint),
  );
  if (missing.length > 0 || extra.length > 0) {
    console.error(
      `abort: DB/seed set mismatch — missing [${missing
        .map((seed) => seed.displayName)
        .join(
          ", ",
        )}], extra [${extra.map((row) => row.displayName).join(", ")}]`,
    );
    process.exit(1);
  }
  for (const row of rows) {
    const seed = seedByFingerprint.get(row.sourceFingerprint)!;
    // Identity is fingerprint + config, deliberately NAME-FREE: display
    // names renumber on retirement (S-P2) and must not fail this preflight.
    if (!rowMatchesSeedIdentity(row, seed)) {
      console.error(
        `abort: row ${row.displayName} (${row.id}) drifted from its committed seed row (config mismatch for fingerprint ${row.sourceFingerprint})`,
      );
      process.exit(1);
    }
  }
  const seedCensus = {
    total: seedRows.length,
    p1: seedRows.filter((seed) => seed.leadIn === null).length,
    p2: seedRows.filter((seed) => seed.leadIn !== null).length,
    cat: seedRows.filter((seed) => seed.leadIn?.piece === "cat").length,
    mouse: seedRows.filter((seed) => seed.leadIn?.piece === "mouse").length,
  };
  if (JSON.stringify(seedCensus) !== JSON.stringify(EXPECTED_CENSUS)) {
    console.error(
      `abort: census ${JSON.stringify(seedCensus)} != expected ${JSON.stringify(EXPECTED_CENSUS)}`,
    );
    process.exit(1);
  }
  console.log(
    `preflight: exact set match with committed batch, census ${JSON.stringify(seedCensus)}`,
  );

  const updates: { id: string; displayName: string; leadIn: unknown }[] = [];
  let p1Count = 0;
  let alreadyPopulated = 0;

  for (const row of rows) {
    const expected = computeLeadIn(row.config);
    const humanPlaysAs = row.config.variantConfig.turn.playerId;
    if (humanPlaysAs === 1) {
      p1Count++;
      if (row.leadIn !== null) {
        console.error(
          `abort: P1 row ${row.displayName} (${row.id}) unexpectedly has a lead-in`,
        );
        process.exit(1);
      }
      continue;
    }
    if (!expected) {
      console.error(
        `abort: no pawn lead-in heuristic applies to P2 row ${row.displayName} (${row.id})`,
      );
      process.exit(1);
    }
    const seedLeadIn = seedByFingerprint.get(row.sourceFingerprint)!.leadIn;
    if (JSON.stringify(expected) !== JSON.stringify(seedLeadIn)) {
      console.error(
        `abort: computed lead-in for ${row.displayName} differs from the committed seed row's`,
      );
      process.exit(1);
    }
    validateLeadInReplay(row.config, expected); // throws on any mismatch
    if (row.leadIn !== null) {
      if (JSON.stringify(row.leadIn) === JSON.stringify(expected)) {
        alreadyPopulated++;
        continue;
      }
      console.error(
        `abort: P2 row ${row.displayName} (${row.id}) has an unexpected existing lead-in`,
      );
      process.exit(1);
    }
    console.log(
      `will populate: ${row.displayName} (${row.id}, enabled=${row.enabled}) — ${expected.piece} from [${expected.from.join(",")}]`,
    );
    updates.push({
      id: row.id,
      displayName: row.displayName,
      leadIn: expected,
    });
  }

  console.log(
    `plan: ${updates.length} to populate, ${alreadyPopulated} already populated, ${p1Count} P1 rows stay null`,
  );

  if (updates.length > 0) {
    await db.transaction(async (tx) => {
      let updatedTotal = 0;
      for (const update of updates) {
        // isNull guard: if anything else wrote a lead-in between preflight
        // and here, the count assertion below rolls the whole batch back.
        const updated = await tx
          .update(savedPuzzlesTable)
          .set({ leadIn: update.leadIn })
          .where(
            and(
              eq(savedPuzzlesTable.id, update.id),
              isNull(savedPuzzlesTable.leadIn),
            ),
          )
          .returning({ id: savedPuzzlesTable.id });
        updatedTotal += updated.length;
      }
      if (updatedTotal !== updates.length) {
        throw new Error(
          `update affected ${updatedTotal} rows, expected ${updates.length} — rolled back`,
        );
      }
    });
  }

  // Read back EVERY row and re-assert the invariant end-to-end.
  const readBack = (await db.select().from(savedPuzzlesTable)).map((raw) =>
    savedPuzzleDbRowSchema.parse(raw),
  );
  for (const row of readBack) {
    const isP2 = row.config.variantConfig.turn.playerId === 2;
    if (isP2 === (row.leadIn === null)) {
      console.error(
        `abort: read-back invariant violated for ${row.displayName} (${row.id})`,
      );
      process.exit(1);
    }
    if (row.leadIn) {
      validateLeadInReplay(row.config, row.leadIn);
    }
  }
  const populated = readBack.filter((row) => row.leadIn !== null);
  console.log(
    `populate complete: ${populated.length} P2 rows carry a replay-proven lead-in, ${readBack.length - populated.length} P1 rows null`,
  );
  process.exit(0);
};

await main();
