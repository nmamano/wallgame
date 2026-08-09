/**
 * Tests for saved puzzles (S-G1): seed-row construction from candidates +
 * committed verdicts, naming-namespace separation from the scripted
 * puzzles, boundary contract validation (fail closed on corrupted rows),
 * the route's row->response mapping (enabled/order), and the handshake
 * puzzle-metadata helpers used by launch/refresh/rematch/Retry.
 */

import { describe, it, expect } from "bun:test";
import { generateCustomSetupCandidates } from "../../shared/domain/generated-custom-setup-candidates";
import type { CandidateVerdictFile } from "../../shared/domain/custom-setup-verdicts";
import {
  buildSavedPuzzleSeedRows,
  generatedPuzzleDisplayName,
} from "../../shared/domain/saved-puzzles";
import { PUZZLES } from "../../shared/domain/puzzles";
import {
  savedPuzzleSeedRowSchema,
  savedPuzzleDbRowSchema,
  savedPuzzleSourceSchema,
  mapSavedPuzzleRows,
  type SavedPuzzleSource,
} from "../../shared/contracts/puzzles";
import {
  handshakesEqual,
  withPuzzleMetadataFrom,
  getPuzzleBannerName,
  type StoredGameHandshake,
} from "../../frontend/src/lib/game-session";
import committedVerdicts from "../../shared/domain/generated-custom-setup-verdicts.json";

const verdictFile = committedVerdicts as CandidateVerdictFile;
const candidates = generateCustomSetupCandidates();
const seedRows = buildSavedPuzzleSeedRows(candidates, verdictFile);

/**
 * `source` is nullable on the row type because a HANDCRAFTED puzzle has no
 * pipeline provenance. Every row in `seedRows` is generated, so it always has
 * one. This asserts that where the tests rely on it, rather than each call site
 * reading through a null.
 */
const sourceOf = (row: (typeof seedRows)[number]): SavedPuzzleSource => {
  if (!row.source) {
    throw new Error(`generated seed row ${row.displayName} has no source`);
  }
  return row.source;
};

describe("saved puzzle seed rows", () => {
  it("builds exactly the kept candidates, in order, with 1..N sort indices", () => {
    const keptCount = verdictFile.verdicts.filter((v) => v.keep).length;
    expect(seedRows.length).toBe(keptCount);
    expect(seedRows.length).toBe(36);
    seedRows.forEach((row, index) => {
      expect(row.sortIndex).toBe(index + 1);
      expect(row.displayName).toBe(generatedPuzzleDisplayName(index + 1));
      expect(row.enabled).toBe(true);
    });
    // Rejected candidates never become rows.
    const rejectedIds = new Set(
      verdictFile.verdicts.filter((v) => !v.keep).map((v) => v.candidateId),
    );
    for (const row of seedRows) {
      expect(rejectedIds.has(sourceOf(row).candidateId)).toBe(false);
    }
  });

  it("projects the exact launch config and full provenance", () => {
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const verdictById = new Map(
      verdictFile.verdicts.map((v) => [v.candidateId, v]),
    );
    for (const row of seedRows) {
      const source = sourceOf(row);
      const candidate = byId.get(source.candidateId)!;
      const verdict = verdictById.get(source.candidateId)!;
      expect(row.config).toEqual({
        variant: candidate.config.variant,
        boardWidth: candidate.config.boardWidth,
        boardHeight: candidate.config.boardHeight,
        variantConfig: candidate.config.variantConfig,
      });
      expect(source.fingerprint).toBe(verdict.fingerprint);
      expect(row.sourceFingerprint).toBe(verdict.fingerprint);
      expect(source.bestMove).toBe(verdict.bestMove);
      expect(source.delta).toBe(verdict.delta);
      // A row carries the evaluation its keep decision rested on, so the
      // provenance does not depend on finding the artifact of that day.
      expect(source.evaluation).toBe(verdict.evaluation);
      expect(source.evaluatedAt).toBe(verdictFile.evaluatedAt);
      expect(source.origin).toBe(verdictFile.origin);
      expect(source.engine).toBe(verdictFile.botName);
    }
  });

  it("still parses a source recorded before evaluations were kept", () => {
    // The 41 rows seeded before 2026-07-29 have no evaluation and are
    // deliberately not backfilled, so the field must stay optional: making it
    // required would fail every existing row closed at the read boundary.
    const firstSource = sourceOf(seedRows[0]);
    const legacySource: { evaluation?: number } = { ...firstSource };
    delete legacySource.evaluation;
    expect(savedPuzzleSourceSchema.parse(legacySource).evaluation).toBe(
      undefined,
    );
    expect(savedPuzzleSourceSchema.parse(firstSource).evaluation).toBe(
      firstSource.evaluation,
    );
    // Still range-checked when present.
    expect(() =>
      savedPuzzleSourceSchema.parse({ ...firstSource, evaluation: 1.5 }),
    ).toThrow();
  });

  it("shares display names with the scripted puzzles, and stays distinct by identity", () => {
    // The overlap is intentional (Nil, 2026-07-29: drop "Generated" from the
    // names). Pinned here so removing it is a deliberate act rather than a
    // silent regression back to the old namespace.
    const scriptedTitles = new Set(
      Object.values(PUZZLES).map((puzzle) => puzzle.title),
    );
    const overlapping = seedRows.filter((row) =>
      scriptedTitles.has(row.displayName),
    );
    expect(overlapping.length).toBe(scriptedTitles.size);

    // What actually keeps the two sets apart. This documents the contract;
    // it cannot by itself stop someone from adding a name-based lookup
    // later, which is why the naming helper says so in prose too.
    const fingerprints = seedRows.map((row) => row.sourceFingerprint);
    expect(new Set(fingerprints).size).toBe(seedRows.length);
  });

  it("every seed row passes the boundary contract", () => {
    for (const row of seedRows) {
      expect(() =>
        savedPuzzleSeedRowSchema.parse({ id: "test-id-123", ...row }),
      ).not.toThrow();
    }
  });

  it("rejects a missing or mismatched top-level sourceFingerprint", () => {
    const base = { id: "test-id-123", ...seedRows[0] };
    const missing: Partial<typeof base> = { ...base };
    delete missing.sourceFingerprint;
    expect(() => savedPuzzleSeedRowSchema.parse(missing)).toThrow();
    expect(() =>
      savedPuzzleSeedRowSchema.parse({
        ...base,
        sourceFingerprint: "some-other-position",
      }),
    ).toThrow(/sourceFingerprint/);
  });
});

describe("route row mapping (mapSavedPuzzleRows)", () => {
  const createdAt = new Date("2026-07-26T00:00:00.000Z");
  const validRow = { id: "row-1", createdAt, ...seedRows[0] };

  it("orders by sortIndex and excludes disabled rows", () => {
    const rows = [
      { id: "b", createdAt, ...seedRows[1] },
      { id: "a", createdAt, ...seedRows[0] },
      { id: "c", createdAt, ...seedRows[2], enabled: false },
    ];
    const mapped = mapSavedPuzzleRows(rows);
    expect(mapped.map((p) => p.id)).toEqual(["a", "b"]);
    expect(mapped[0].displayName).toBe(seedRows[0].displayName);
    // Only the public projection is exposed. `sortIndex` joined it in S-G4 so
    // the client can sort by likes with a deterministic tiebreak, and the rest
    // joined it when the authored puzzles became rows: author and difficulty
    // are shown on the card, legacyScriptedId is how the launcher knows a
    // puzzle is still playable with no bot around, and botLaunchReady is
    // whether a bot could be handed the row at all.
    // The provenance columns must STILL not leak — `source` and
    // `sourceFingerprint` are absent below, and that is the point of the test.
    // Note `leadIn` is absent too: it is server-only, which is exactly why
    // botLaunchReady is derived here rather than on the client.
    expect(Object.keys(mapped[0]).sort()).toEqual([
      "author",
      "botLaunchReady",
      "config",
      "difficulty",
      "dislikes",
      "displayName",
      "id",
      "legacyScriptedId",
      "likes",
      "myVote",
      "sortIndex",
    ]);
  });

  it("defaults the vote state of a puzzle nobody has voted on", () => {
    const mapped = mapSavedPuzzleRows([{ id: "a", createdAt, ...seedRows[0] }]);
    expect(mapped[0]).toMatchObject({ likes: 0, dislikes: 0, myVote: null });
  });

  it("merges vote counts by puzzle id", () => {
    const rows = [
      { id: "a", createdAt, ...seedRows[0] },
      { id: "b", createdAt, ...seedRows[1] },
    ];
    const mapped = mapSavedPuzzleRows(
      rows,
      new Map([["a", { likes: 3, dislikes: 1, myVote: -1 as const }]]),
    );
    expect(mapped[0]).toMatchObject({ likes: 3, dislikes: 1, myVote: -1 });
    // The puzzle absent from the map keeps the zero defaults rather than
    // inheriting its neighbour's counts.
    expect(mapped[1]).toMatchObject({ likes: 0, dislikes: 0, myVote: null });
  });

  it("fails closed on a corrupted config", () => {
    const corrupted = {
      ...validRow,
      config: { ...validRow.config, variant: "not-a-variant" },
    };
    expect(() => mapSavedPuzzleRows([corrupted])).toThrow();
  });

  it("fails closed on missing provenance", () => {
    const corrupted = { ...validRow, source: { candidateId: "x" } };
    expect(() => mapSavedPuzzleRows([corrupted])).toThrow();
  });

  it("fails closed on malformed createdAt", () => {
    expect(() =>
      mapSavedPuzzleRows([{ ...validRow, createdAt: "not-a-date" }]),
    ).toThrow();
    const withoutCreatedAt: Partial<typeof validRow> = { ...validRow };
    delete withoutCreatedAt.createdAt;
    expect(() => mapSavedPuzzleRows([withoutCreatedAt])).toThrow();
    expect(() => savedPuzzleDbRowSchema.parse(validRow)).not.toThrow();
  });
});

describe("handshake puzzle metadata", () => {
  const base: StoredGameHandshake = {
    gameId: "g1",
    token: "t",
    socketToken: "s",
    role: "host",
    playerId: 2,
    shareUrl: "https://example/game/g1",
    puzzleId: "pz1",
    puzzleName: "Puzzle 7",
  };

  it("withPuzzleMetadataFrom carries metadata onto rebuilt handshakes (refresh/Retry/rematch)", () => {
    const rebuilt: StoredGameHandshake = {
      gameId: "g2",
      token: "t2",
      socketToken: "s2",
      role: "host",
      playerId: 2,
    };
    const carried = withPuzzleMetadataFrom(rebuilt, base);
    expect(carried.puzzleId).toBe("pz1");
    expect(carried.puzzleName).toBe("Puzzle 7");
    // Non-puzzle games are untouched (spectator/shared-link fallback stays
    // generic because there is nothing to carry).
    const plain = withPuzzleMetadataFrom(rebuilt, {
      ...base,
      puzzleId: undefined,
      puzzleName: undefined,
    });
    expect(plain).toBe(rebuilt);
    expect(withPuzzleMetadataFrom(rebuilt, null)).toBe(rebuilt);
  });

  it("does not carry a lone malformed half-pair (metadata is atomic)", () => {
    const rebuilt: StoredGameHandshake = {
      gameId: "g3",
      token: "t3",
      socketToken: "s3",
      role: "host",
      playerId: 1,
    };
    expect(
      withPuzzleMetadataFrom(rebuilt, { ...base, puzzleName: undefined }),
    ).toBe(rebuilt);
    expect(
      withPuzzleMetadataFrom(rebuilt, { ...base, puzzleId: undefined }),
    ).toBe(rebuilt);
  });

  it("getPuzzleBannerName resolves the name, else the generic fallback", () => {
    expect(getPuzzleBannerName(base)).toBe("Puzzle 7");
    // Spectators/shared links have no handshake at all.
    expect(getPuzzleBannerName(null)).toBe(null);
    // Ordinary games carry no metadata.
    expect(
      getPuzzleBannerName({
        ...base,
        puzzleId: undefined,
        puzzleName: undefined,
      }),
    ).toBe(null);
    // A malformed half-pair is not trusted.
    expect(getPuzzleBannerName({ ...base, puzzleId: undefined })).toBe(null);
    expect(getPuzzleBannerName({ ...base, puzzleName: undefined })).toBe(null);
  });

  it("handshakesEqual detects dropped or changed puzzle metadata", () => {
    expect(handshakesEqual(base, { ...base })).toBe(true);
    expect(handshakesEqual(base, { ...base, puzzleName: undefined })).toBe(
      false,
    );
    expect(handshakesEqual(base, { ...base, puzzleId: "other" })).toBe(false);
    expect(handshakesEqual(null, base)).toBe(false);
    expect(handshakesEqual(null, null)).toBe(true);
  });
});
