import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const sha256File = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Capture the initial board and each committed replay ply in order.
 *
 * The caller supplies navigation because the real page and the deterministic
 * fixture expose different controls. This function owns the ordering, capture,
 * and value-level checks for both.
 */
export async function captureReplayFrames({
  moveCount,
  selectInitial,
  selectPly,
  readCommittedPly,
  capture,
}) {
  const records = [];

  const take = async (expectedPly) => {
    const committedPly = await readCommittedPly();
    const file = await capture(expectedPly);
    records.push({
      expectedPly,
      committedPly,
      file,
      sha256: file ? sha256File(file) : null,
    });
  };

  await selectInitial();
  await take(-1);
  for (let ply = 0; ply < moveCount; ply += 1) {
    await selectPly(ply);
    await take(ply);
  }

  const committed = records.map((record) => record.committedPly);
  const expected = records.map((record) => record.expectedPly);
  const omissions = expected.filter((ply) => !committed.includes(ply));
  const duplicates = committed.filter(
    (ply, index) => index > 0 && committed[index - 1] === ply,
  );
  const reordered = committed.some(
    (ply, index) => index > 0 && ply <= committed[index - 1],
  );
  const mismatches = records.filter(
    (record) => record.expectedPly !== record.committedPly,
  );

  return {
    records,
    expected,
    committed,
    omissions,
    duplicates,
    reordered,
    mismatches,
  };
}

export function assertCompleteCapture(result) {
  if (
    result.omissions.length ||
    result.duplicates.length ||
    result.reordered ||
    result.mismatches.length
  ) {
    throw new Error(
      `replay capture mismatch: expected ${JSON.stringify(result.expected)}, ` +
        `captured ${JSON.stringify(result.committed)}, omissions ${JSON.stringify(result.omissions)}, ` +
        `duplicates ${JSON.stringify(result.duplicates)}, reordered ${result.reordered}`,
    );
  }
}
