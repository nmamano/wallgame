import { describe, expect, it } from "bun:test";
import {
  buildSavedPuzzleSeedRows,
  computeContiguousRenames,
  generatedPuzzleDisplayName,
  rowMatchesSeedIdentity,
} from "../../shared/domain/saved-puzzles";
import { generateCustomSetupCandidates } from "../../shared/domain/generated-custom-setup-candidates";
import verdictFile from "../../shared/domain/generated-custom-setup-verdicts.json";
import type { CandidateVerdictFile } from "../../shared/domain/custom-setup-verdicts";

/**
 * S-P2 continuous-numbering tooling: display names are presentation only
 * (identity = sourceFingerprint), enabled rows renumber positionally by
 * sortIndex, and no identity preflight may depend on names.
 */

const seedRows = buildSavedPuzzleSeedRows(
  generateCustomSetupCandidates(),
  verdictFile as CandidateVerdictFile,
);

/**
 * A standalone row set, NOT the current seed rows: renumbering is arithmetic
 * over enabled rows and has nothing to do with how many candidates the
 * generator happens to keep. Deriving this from the seed rows once made a
 * regenerated verdict artifact fail a renumbering test.
 *
 * 41 rows with 1 and 6 retired is the historical production state these
 * assertions describe.
 */
const rowsFixture = (retiredSortIndices: number[], count = 41) =>
  Array.from({ length: count }, (_, index) => ({
    id: `id-${index + 1}`,
    displayName: generatedPuzzleDisplayName(index + 1),
    sortIndex: index + 1,
    enabled: !retiredSortIndices.includes(index + 1),
  }));

describe("computeContiguousRenames", () => {
  it("renumbers enabled rows contiguously by sortIndex, skipping disabled", () => {
    // The real production state: sortIndex 1 and 6 retired.
    const renames = computeContiguousRenames(rowsFixture([1, 6]));
    // Rows 2..5 shift down by one; 7..41 shift down by two.
    expect(renames.find((r) => r.from === "Puzzle 2")?.to).toBe("Puzzle 1");
    expect(renames.find((r) => r.from === "Puzzle 5")?.to).toBe("Puzzle 4");
    expect(renames.find((r) => r.from === "Puzzle 7")?.to).toBe("Puzzle 5");
    expect(renames.find((r) => r.from === "Puzzle 41")?.to).toBe("Puzzle 39");
    // Disabled rows never appear.
    expect(renames.some((r) => r.from === "Puzzle 1")).toBe(false);
    expect(renames.some((r) => r.from === "Puzzle 6")).toBe(false);
    // Resulting names are unique.
    const targets = renames.map((r) => r.to);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("is a no-op when names are already contiguous", () => {
    expect(computeContiguousRenames(rowsFixture([]))).toHaveLength(0);
  });

  it("is idempotent: renaming twice changes nothing the second time", () => {
    const rows = rowsFixture([1, 6]);
    const first = computeContiguousRenames(rows);
    const renamed = rows.map((row) => {
      const rename = first.find((r) => r.id === row.id);
      return rename ? { ...row, displayName: rename.to } : row;
    });
    expect(computeContiguousRenames(renamed)).toHaveLength(0);
  });
});

describe("rowMatchesSeedIdentity (name-free identity preflight)", () => {
  const seed = seedRows[0];
  const storedRow = {
    sourceFingerprint: seed.sourceFingerprint,
    config: JSON.parse(JSON.stringify(seed.config)) as unknown,
  };

  it("accepts a row whose display name was renumbered", () => {
    // The populate script's preflight must survive contiguous renumbering:
    // identity is fingerprint + config, never the label.
    expect(rowMatchesSeedIdentity(storedRow, seed)).toBe(true);
  });

  it("rejects a config drift", () => {
    const drifted = {
      ...storedRow,
      config: { ...(storedRow.config as object), boardWidth: 7 },
    };
    expect(rowMatchesSeedIdentity(drifted, seed)).toBe(false);
  });

  it("rejects a fingerprint mismatch", () => {
    expect(
      rowMatchesSeedIdentity(
        { ...storedRow, sourceFingerprint: "other" },
        seed,
      ),
    ).toBe(false);
  });
});
