/**
 * Tests for the generated custom-setup candidates (S-H, 2026-07-26):
 *
 * 1. The generator constrains the ATTACK races — cat to OPPONENT's mouse,
 *    the actual goal in standard (an earlier version constrained each cat
 *    against its own mouse, leaving real difficulty unconstrained).
 * 2. computeBestMoveDelta applies the engine's best move with production
 *    rules and measures the mover's distance change.
 * 3. applyCandidateVerdicts fails closed on any mismatch between the
 *    committed verdict artifact and the current candidate set, so a
 *    generator edit can never silently reuse stale engine decisions.
 * 4. The committed verdict artifact covers the current generator exactly
 *    one-to-one (this test fails whenever the generator changes without
 *    regenerating the artifact — that is its job).
 */

import { describe, it, expect } from "bun:test";
import {
  generateCustomSetupCandidates,
  type GeneratedCustomSetupCandidate,
} from "../../shared/domain/generated-custom-setup-candidates";
import {
  computeBestMoveDelta,
  keepByDelta,
  applyCandidateVerdicts,
  evaluationInputKey,
  type CandidateVerdictFile,
} from "../../shared/domain/custom-setup-verdicts";
import { Grid } from "../../shared/domain/grid";
import type {
  Cell,
  CustomSetupStandardInitialState,
} from "../../shared/domain/game-types";
import committedVerdicts from "../../shared/domain/generated-custom-setup-verdicts.json";

const cellKey = (cell: Cell) => `${cell[0]},${cell[1]}`;

describe("generated candidates: attack-race pairing", () => {
  const candidates = generateCustomSetupCandidates();

  it("generates 48 deterministic candidates", () => {
    expect(candidates.length).toBe(48);
    const again = generateCustomSetupCandidates();
    expect(JSON.stringify(again)).toBe(JSON.stringify(candidates));
  });

  it("places four distinct pawn cells with both ATTACK races in [3,6]", () => {
    for (const candidate of candidates) {
      const init = candidate.config
        .variantConfig as CustomSetupStandardInitialState;
      const cells = [
        init.pawns.p1.cat,
        init.pawns.p1.mouse,
        init.pawns.p2.cat,
        init.pawns.p2.mouse,
      ];
      expect(new Set(cells.map(cellKey)).size).toBe(4);

      const grid = new Grid(
        candidate.config.boardWidth,
        candidate.config.boardHeight,
        "standard",
      );
      for (const wall of init.walls) grid.addWall(wall);

      // The goal in standard is the OPPONENT's mouse.
      const p1Attack = grid.distance(init.pawns.p1.cat, init.pawns.p2.mouse);
      const p2Attack = grid.distance(init.pawns.p2.cat, init.pawns.p1.mouse);
      expect(p1Attack).toBeGreaterThanOrEqual(3);
      expect(p1Attack).toBeLessThanOrEqual(6);
      expect(p2Attack).toBeGreaterThanOrEqual(3);
      expect(p2Attack).toBeLessThanOrEqual(6);
      expect(candidate.distances).toEqual({ p1: p1Attack, p2: p2Attack });
    }
  });
});

describe("computeBestMoveDelta", () => {
  // Hand-built wall-less position: mover p1's cat at a6 ([0,0]), goal (p2's
  // mouse) at e6 ([0,4]), distance 4 along the top row.
  const handBuilt: GeneratedCustomSetupCandidate = {
    id: "test-position",
    displayName: "Test Position",
    humanPlaysAs: 1,
    distances: { p1: 4, p2: 5 },
    config: {
      variant: "custom-setup-standard",
      timeControl: {
        initialSeconds: 0,
        incrementSeconds: 0,
        preset: "unlimited",
      },
      rated: false,
      boardWidth: 6,
      boardHeight: 6,
      variantConfig: {
        pawns: {
          p1: { cat: [0, 0], mouse: [5, 5] },
          p2: { cat: [5, 0], mouse: [0, 4] },
        },
        walls: [],
        turn: { playerId: 1, actionsTaken: [] },
      } satisfies CustomSetupStandardInitialState,
    },
  };

  it("scores a greedy two-step walk as delta -2 (reject)", () => {
    // Cc6 = two steps right along the top row.
    const result = computeBestMoveDelta(handBuilt, "Cc6");
    expect(result).toEqual({ beforeDistance: 4, afterDistance: 2, delta: -2 });
    expect(keepByDelta(result.delta)).toBe(false);
  });

  it("scores a step-plus-wall move as delta -1 (keep)", () => {
    // One step right plus a wall far away: distance improves by exactly 1.
    const result = computeBestMoveDelta(handBuilt, "Cb6.^a1");
    expect(result).toEqual({ beforeDistance: 4, afterDistance: 3, delta: -1 });
    expect(keepByDelta(result.delta)).toBe(true);
  });

  it("accounts for walls the best move itself places", () => {
    // Step down plus a vertical wall at b6 that blocks the mover's own
    // top-row corridor: the distance is re-measured on the post-move grid,
    // so it LENGTHENS (4 -> 5) even though the cat also moved.
    const result = computeBestMoveDelta(handBuilt, "Ca5.>b6");
    expect(result).toEqual({ beforeDistance: 4, afterDistance: 5, delta: 1 });
    expect(keepByDelta(result.delta)).toBe(true);
  });

  it("throws on malformed notation", () => {
    expect(() => computeBestMoveDelta(handBuilt, "XYZ")).toThrow();
  });

  it("throws on an illegal move", () => {
    // f6 is five steps away — not reachable in one turn.
    expect(() => computeBestMoveDelta(handBuilt, "Cf6")).toThrow();
  });
});

describe("applyCandidateVerdicts fail-closed validation", () => {
  const candidates = generateCustomSetupCandidates().slice(0, 3);
  const goodFile = (): CandidateVerdictFile => ({
    evaluatedAt: "2026-07-26T00:00:00.000Z",
    origin: "test",
    botCompositeId: "test:bot",
    botName: "Test Bot",
    verdicts: candidates.map((candidate) => ({
      candidateId: candidate.id,
      fingerprint: evaluationInputKey(candidate),
      bestMove: "---",
      beforeDistance: 4,
      afterDistance: 3,
      delta: -1,
      keep: true,
    })),
  });

  it("accepts an exact one-to-one match and filters by keep", () => {
    const file = goodFile();
    expect(applyCandidateVerdicts(candidates, file).length).toBe(3);
    file.verdicts[1].keep = false;
    const kept = applyCandidateVerdicts(candidates, file);
    expect(kept.map((c) => c.id)).toEqual([candidates[0].id, candidates[2].id]);
  });

  it("throws on a missing verdict", () => {
    const file = goodFile();
    file.verdicts.pop();
    expect(() => applyCandidateVerdicts(candidates, file)).toThrow(/count/);
  });

  it("throws on a duplicate verdict", () => {
    const file = goodFile();
    file.verdicts.push({ ...file.verdicts[0] });
    expect(() => applyCandidateVerdicts(candidates, file)).toThrow(/Duplicate/);
  });

  it("throws on an extra stale verdict", () => {
    const file = goodFile();
    file.verdicts.push({
      ...file.verdicts[0],
      candidateId: "synthetic-6x6-99",
    });
    expect(() => applyCandidateVerdicts(candidates, file)).toThrow(/count/);
  });

  it("throws on a fingerprint mismatch", () => {
    const file = goodFile();
    file.verdicts[0].fingerprint = "not-the-position";
    expect(() => applyCandidateVerdicts(candidates, file)).toThrow(
      /fingerprint mismatch/,
    );
  });

  it("throws when the mover flipped since the verdict was computed", () => {
    // Same board, different side to move: the evaluation input differs, so
    // the stale verdict must not be reused.
    const file = goodFile();
    const flipped = {
      ...candidates[0],
      humanPlaysAs:
        candidates[0].humanPlaysAs === 1 ? (2 as const) : (1 as const),
    };
    file.verdicts[0].fingerprint = evaluationInputKey(flipped);
    expect(() => applyCandidateVerdicts(candidates, file)).toThrow(
      /fingerprint mismatch/,
    );
  });
});

describe("committed verdict artifact", () => {
  it("covers the current candidate set one-to-one and every record recomputes", () => {
    // Fails whenever the generator changes without regenerating the artifact
    // (bun scripts/filter-puzzle-candidates.ts). That is deliberate.
    const candidates = generateCustomSetupCandidates();
    const byId = new Map(candidates.map((c) => [c.id, c]));
    for (const verdict of (committedVerdicts as CandidateVerdictFile)
      .verdicts) {
      const candidate = byId.get(verdict.candidateId);
      expect(candidate).toBeDefined();
      // Replaying the recorded best move must reproduce the recorded numbers
      // exactly — catches corrupted fields and illegal recorded moves.
      expect(computeBestMoveDelta(candidate!, verdict.bestMove)).toEqual({
        beforeDistance: verdict.beforeDistance,
        afterDistance: verdict.afterDistance,
        delta: verdict.delta,
      });
      expect(verdict.keep).toBe(keepByDelta(verdict.delta));
    }
    const kept = applyCandidateVerdicts(
      candidates,
      committedVerdicts as CandidateVerdictFile,
    );
    expect(kept.length).toBeGreaterThan(0);
    for (const verdict of (committedVerdicts as CandidateVerdictFile)
      .verdicts) {
      // Every recorded delta obeys the keep rule exactly.
      expect(verdict.keep).toBe(keepByDelta(verdict.delta));
      expect(verdict.delta).toBe(
        verdict.afterDistance - verdict.beforeDistance,
      );
    }
  });
});
