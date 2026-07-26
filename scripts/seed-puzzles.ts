/**
 * Seeds the saved_puzzles table from the generated candidates and their
 * committed engine verdicts (S-G1). Runs INSIDE the deployed Fly machine
 * (which has DATABASE_URL); it is NOT part of release_command — seeding is
 * a deliberate manual step:
 *
 *   fly ssh console -a wallgame -C "bun scripts/seed-puzzles.ts"
 *
 * Idempotency is a DB invariant: source_fingerprint is UNIQUE and the
 * insert uses onConflictDoNothing on it, so re-runs skip existing puzzles.
 * All rows are built and validated BEFORE a single transactional insert;
 * inserted/skipped counts are reported.
 */

import { nanoid } from "nanoid";
import { db } from "../server/db";
import { savedPuzzlesTable } from "../server/db/schema/saved-puzzles";
import { generateCustomSetupCandidates } from "../shared/domain/generated-custom-setup-candidates";
import { buildSavedPuzzleSeedRows } from "../shared/domain/saved-puzzles";
import { savedPuzzleSeedRowSchema } from "../shared/contracts/puzzles";
import verdictFile from "../shared/domain/generated-custom-setup-verdicts.json";
import type { CandidateVerdictFile } from "../shared/domain/custom-setup-verdicts";

const main = async () => {
  const seedRows = buildSavedPuzzleSeedRows(
    generateCustomSetupCandidates(),
    verdictFile as CandidateVerdictFile,
  );

  // Validate every row against the boundary contract BEFORE touching the DB.
  const rows = seedRows.map((row) => {
    const withId = { id: nanoid(10), ...row };
    savedPuzzleSeedRowSchema.parse(withId); // throws on any mismatch
    return withId;
  });

  console.log(`built and validated ${rows.length} seed rows`);

  const inserted = await db.transaction(async (tx) => {
    const result = await tx
      .insert(savedPuzzlesTable)
      .values(rows)
      .onConflictDoNothing({ target: savedPuzzlesTable.sourceFingerprint })
      .returning({ id: savedPuzzlesTable.id });
    return result.length;
  });

  console.log(
    `seed complete: ${inserted} inserted, ${rows.length - inserted} skipped (already present)`,
  );
  process.exit(0);
};

await main();
