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
  mapSavedPuzzleRows,
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

describe("saved puzzle seed rows", () => {
  it("builds exactly the kept candidates, in order, with 1..N sort indices", () => {
    const keptCount = verdictFile.verdicts.filter((v) => v.keep).length;
    expect(seedRows.length).toBe(keptCount);
    expect(seedRows.length).toBe(41);
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
      expect(rejectedIds.has(row.source.candidateId)).toBe(false);
    }
  });

  it("projects the exact launch config and full provenance", () => {
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const verdictById = new Map(
      verdictFile.verdicts.map((v) => [v.candidateId, v]),
    );
    for (const row of seedRows) {
      const candidate = byId.get(row.source.candidateId)!;
      const verdict = verdictById.get(row.source.candidateId)!;
      expect(row.config).toEqual({
        variant: candidate.config.variant,
        boardWidth: candidate.config.boardWidth,
        boardHeight: candidate.config.boardHeight,
        variantConfig: candidate.config.variantConfig,
      });
      expect(row.source.fingerprint).toBe(verdict.fingerprint);
      expect(row.sourceFingerprint).toBe(verdict.fingerprint);
      expect(row.source.bestMove).toBe(verdict.bestMove);
      expect(row.source.delta).toBe(verdict.delta);
      expect(row.source.evaluatedAt).toBe(verdictFile.evaluatedAt);
      expect(row.source.origin).toBe(verdictFile.origin);
      expect(row.source.engine).toBe(verdictFile.botName);
    }
  });

  it("never collides with the scripted puzzle titles", () => {
    const scriptedTitles = new Set(
      Object.values(PUZZLES).map((puzzle) => puzzle.title),
    );
    for (const row of seedRows) {
      expect(scriptedTitles.has(row.displayName)).toBe(false);
    }
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
    // Only the public projection is exposed. `sortIndex` joined it in S-G4
    // so the client can sort by likes with a deterministic tiebreak; the
    // provenance columns still must not leak.
    expect(Object.keys(mapped[0]).sort()).toEqual([
      "config",
      "dislikes",
      "displayName",
      "id",
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
    puzzleName: "Generated Puzzle 7",
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
    expect(carried.puzzleName).toBe("Generated Puzzle 7");
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
    expect(getPuzzleBannerName(base)).toBe("Generated Puzzle 7");
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
