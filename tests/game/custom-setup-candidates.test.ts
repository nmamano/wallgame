/**
 * Tests for the generated custom-setup candidates (S-H, 2026-07-26):
 *
 * 1. The generator constrains the ATTACK races — cat to OPPONENT's mouse,
 *    the actual goal in standard (an earlier version constrained each cat
 *    against its own mouse, leaving real difficulty unconstrained).
 * 2. computeBestMoveDelta applies the engine's best move with production
 *    rules and measures the mover's distance change.
 * 3. The two keep rules: the distance rule and (2026-07-29) the
 *    decisively-winning rule, including the mover-perspective sign
 *    conversion that would invert the whole filter if it were backwards.
 * 4. applyCandidateVerdicts fails closed on any mismatch between the
 *    committed verdict artifact and the current candidate set, so neither a
 *    generator edit nor a rule change can silently reuse stale engine
 *    decisions — recorded moves are replayed and keep flags recomputed.
 * 5. The committed verdict artifact covers the current generator exactly
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
  keepByEvaluation,
  keepVerdict,
  moverEvaluation,
  isValidEvaluation,
  applyCandidateVerdicts,
  evaluationInputKey,
  MIN_MOVER_EVALUATION,
  type CandidateVerdict,
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
      const init = candidate.config.variantConfig;
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

describe("the two keep rules", () => {
  it("negates the evaluation only when the mover is P2", () => {
    // The sign is the whole trap in this rule: an inverted conversion would
    // keep exactly the losing positions and reject the winning ones.
    expect(moverEvaluation(0.9, 1)).toBe(0.9);
    expect(moverEvaluation(0.9, 2)).toBe(-0.9);
    expect(moverEvaluation(-0.9, 1)).toBe(-0.9);
    expect(moverEvaluation(-0.9, 2)).toBe(0.9);
  });

  it("treats the threshold as inclusive", () => {
    expect(keepByEvaluation(MIN_MOVER_EVALUATION)).toBe(true);
    expect(keepByEvaluation(MIN_MOVER_EVALUATION - 0.001)).toBe(false);
    expect(keepByEvaluation(1)).toBe(true);
    expect(keepByEvaluation(-1)).toBe(false);
  });

  it("requires BOTH rules to keep a candidate", () => {
    const winning = MIN_MOVER_EVALUATION;
    const losing = MIN_MOVER_EVALUATION - 0.001;
    expect(keepVerdict({ delta: 0, moverEval: winning })).toBe(true);
    // A decisively winning position whose answer is a greedy walk.
    expect(keepVerdict({ delta: -2, moverEval: winning })).toBe(false);
    // A non-trivial answer in a position the mover cannot win.
    expect(keepVerdict({ delta: 0, moverEval: losing })).toBe(false);
    expect(keepVerdict({ delta: -2, moverEval: losing })).toBe(false);
  });

  it("rejects evaluations that are not real numbers in [-1,1]", () => {
    for (const good of [-1, -0.5, 0, 0.715, 1]) {
      expect(isValidEvaluation(good)).toBe(true);
    }
    for (const bad of [
      NaN,
      Infinity,
      -Infinity,
      1.0001,
      -1.0001,
      "0.5",
      null,
      undefined,
    ]) {
      expect(isValidEvaluation(bad)).toBe(false);
    }
  });
});

describe("applyCandidateVerdicts fail-closed validation", () => {
  // Fixtures are built from REAL committed verdicts, because the loader now
  // replays the recorded move: a placeholder like "---" no longer parses.
  // Only candidates that pass the distance rule are used, so the evaluation
  // is the variable under test and regenerating the artifact cannot make
  // these fixtures accidentally about something else.
  const committed = committedVerdicts as CandidateVerdictFile;
  const committedById = new Map(
    committed.verdicts.map((v) => [v.candidateId, v]),
  );
  const candidates = generateCustomSetupCandidates()
    .filter((c) => (committedById.get(c.id)?.delta ?? 0) >= -1)
    .slice(0, 3);

  /** A self-consistent file: each candidate at the given mover evaluation. */
  const fileWithMoverEvals = (moverEvals: number[]): CandidateVerdictFile => ({
    evaluatedAt: "2026-07-29T00:00:00.000Z",
    origin: "test",
    botCompositeId: "test:bot",
    botName: "Test Bot",
    verdicts: candidates.map((candidate, index): CandidateVerdict => {
      const real = committedById.get(candidate.id)!;
      const moverEval = moverEvals[index];
      return {
        ...real,
        fingerprint: evaluationInputKey(candidate),
        // Undo the mover-perspective conversion to get a raw P1 number.
        evaluation: candidate.humanPlaysAs === 1 ? moverEval : -moverEval,
        keep: keepVerdict({ delta: real.delta, moverEval }),
      };
    }),
  });

  const goodFile = (): CandidateVerdictFile =>
    fileWithMoverEvals([0.99, 0.99, 0.99]);

  it("keeps every candidate when all pass both rules", () => {
    const kept = applyCandidateVerdicts(candidates, goodFile());
    expect(kept.map((c) => c.id)).toEqual(candidates.map((c) => c.id));
  });

  it("drops a candidate the mover is not decisively winning", () => {
    const file = fileWithMoverEvals([0.99, 0, 0.99]);
    const kept = applyCandidateVerdicts(candidates, file);
    expect(kept.map((c) => c.id)).toEqual([candidates[0].id, candidates[2].id]);
  });

  it("throws when the stored keep disagrees with the recomputed rule", () => {
    // The artifact's keep is an audit checksum, not an instruction: a rule
    // change with a stale file must fail loudly rather than quietly honour
    // the old decisions.
    const file = goodFile();
    file.verdicts[1].keep = false;
    expect(() => applyCandidateVerdicts(candidates, file)).toThrow(
      /keep flag .* disagrees/,
    );
  });

  it("throws on an evaluation that is missing, non-finite or out of range", () => {
    for (const bad of [undefined, NaN, 1.5, -1.5]) {
      const file = goodFile();
      (file.verdicts[0] as { evaluation: unknown }).evaluation = bad;
      expect(() => applyCandidateVerdicts(candidates, file)).toThrow(
        /not a number in/,
      );
    }
  });

  it("throws when the recorded distances do not reproduce", () => {
    // Fabricated numbers with a legal move: only replaying the move catches
    // this, which is why the loader replays instead of trusting the record.
    const file = goodFile();
    file.verdicts[0].beforeDistance += 1;
    expect(() => applyCandidateVerdicts(candidates, file)).toThrow(
      /do not reproduce/,
    );

    const deltaOnly = goodFile();
    deltaOnly.verdicts[0].delta -= 1;
    expect(() => applyCandidateVerdicts(candidates, deltaOnly)).toThrow(
      /do not reproduce/,
    );
  });

  it("throws on a malformed recorded move", () => {
    const file = goodFile();
    file.verdicts[0].bestMove = "XYZ";
    expect(() => applyCandidateVerdicts(candidates, file)).toThrow();
  });

  it("throws on a recorded move that is a pass", () => {
    // "---" is VALID notation for an empty move, so it replays to zero
    // distance change and would silently reproduce any delta-0 record. The
    // engine never answers a live position with a pass.
    const file = goodFile();
    file.verdicts[0].bestMove = "---";
    expect(() => applyCandidateVerdicts(candidates, file)).toThrow(/is empty/);
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
    // Fails whenever the generator OR the rule changes without regenerating
    // the artifact (bun scripts/filter-puzzle-candidates.ts). That is
    // deliberate.
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
      expect(verdict.delta).toBe(
        verdict.afterDistance - verdict.beforeDistance,
      );
      // Every evaluation is a real number in range, and every keep flag
      // matches BOTH rules applied to the mover's view of it.
      expect(isValidEvaluation(verdict.evaluation)).toBe(true);
      expect(verdict.keep).toBe(
        keepVerdict({
          delta: verdict.delta,
          moverEval: moverEvaluation(
            verdict.evaluation,
            candidate!.humanPlaysAs,
          ),
        }),
      );
    }
    const kept = applyCandidateVerdicts(
      candidates,
      committedVerdicts as CandidateVerdictFile,
    );
    expect(kept.length).toBeGreaterThan(0);
  });

  it("keeps no candidate the mover is not decisively winning", () => {
    // The property the six retired puzzles violated, asserted directly over
    // the artifact rather than inferred from the keep flags.
    const candidates = generateCustomSetupCandidates();
    const byId = new Map(candidates.map((c) => [c.id, c]));
    for (const verdict of (committedVerdicts as CandidateVerdictFile)
      .verdicts) {
      if (!verdict.keep) continue;
      const mover = byId.get(verdict.candidateId)!.humanPlaysAs;
      expect(moverEvaluation(verdict.evaluation, mover)).toBeGreaterThanOrEqual(
        MIN_MOVER_EVALUATION,
      );
    }
  });
});
