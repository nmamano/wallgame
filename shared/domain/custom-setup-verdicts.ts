/**
 * Engine filtering for generated custom-setup candidates. TWO rules, both
 * Nil's, both judged from the engine's answer at ply 0:
 *
 * 1. The best first move must improve the mover's true distance to their goal
 *    by AT MOST 1. If the best play is the greedy two-step walk at the target
 *    (delta -2), the puzzle's answer is trivial walking.
 * 2. The mover must be DECISIVELY WINNING (2026-07-29). Solving a puzzle means
 *    literally winning the game, so a position the mover cannot win is not a
 *    puzzle at all. Six live puzzles had to be retired because nothing checked
 *    this: two were already lost at move one and four were coin flips.
 *
 * Rule 2 exists because the generator only ever guaranteed that both attack
 * races are 3-6 steps, which says nothing about who is winning — the two race
 * lengths are drawn independently, and a defender can spend actions on walls.
 * Race asymmetry does not predict it either: the worst position measured was a
 * mild 4-vs-3 race.
 *
 * Verdicts are computed OFFLINE against the production engine (see
 * scripts/filter-puzzle-candidates.ts) and committed as
 * generated-custom-setup-verdicts.json. Each verdict is tied to the exact
 * position it was computed for via the position fingerprint, so a generator
 * edit cannot silently reuse old decisions for new positions: validation
 * fails closed on any mismatch, missing, duplicate, or stale-extra verdict.
 */

import { GameState } from "./game-state";
import { moveFromStandardNotation } from "./standard-notation";
import type { PlayerId } from "./game-types";
import {
  positionKey,
  type GeneratedCustomSetupCandidate,
} from "./generated-custom-setup-candidates";

/**
 * Fingerprint of the full EVALUATION INPUT a verdict was computed for:
 * variant, board dimensions, side to move, and the canonical position.
 * positionKey() alone covers pawns+walls but not the mover — and the mover
 * determines whose best move and goal distance are being judged, so a
 * generator edit that flips humanPlaysAs must invalidate the verdict.
 */
export const evaluationInputKey = (
  candidate: GeneratedCustomSetupCandidate,
): string =>
  [
    candidate.config.variant,
    `${candidate.config.boardWidth}x${candidate.config.boardHeight}`,
    `mover:${candidate.humanPlaysAs}`,
    positionKey(
      candidate.config.variantConfig as Parameters<typeof positionKey>[0],
    ),
  ].join("#");

export interface CandidateVerdict {
  candidateId: string;
  /** evaluationInputKey() of the candidate this verdict was computed for. */
  fingerprint: string;
  /** The engine's best move for the mover at ply 0, standard notation. */
  bestMove: string;
  /** Mover's true distance to their goal before/after applying bestMove. */
  beforeDistance: number;
  afterDistance: number;
  /** afterDistance - beforeDistance. */
  delta: number;
  /**
   * The engine's evaluation at ply 0, RAW as the protocol reports it: from
   * P1's perspective, +1 = P1 winning, -1 = P2 winning. Stored raw because
   * that is the protocol fact; the mover's view is derived by
   * moverEvaluation() rather than stored as a second source of truth.
   */
  evaluation: number;
  /**
   * Audit checksum of the rule AT THE TIME the artifact was written.
   * applyCandidateVerdicts recomputes the decision and throws if it
   * disagrees, so a rule change with an un-regenerated artifact fails loudly
   * instead of silently honouring stale decisions.
   */
  keep: boolean;
}

export interface CandidateVerdictFile {
  /** When the batch was evaluated (ISO timestamp). */
  evaluatedAt: string;
  /** Where the engine verdicts came from (e.g. https://wallgame.io). */
  origin: string;
  /** The bot that produced the best moves. */
  botCompositeId: string;
  botName: string;
  verdicts: CandidateVerdict[];
}

/**
 * The mover's true distance to their goal (the opponent's mouse in standard),
 * before and after applying the engine's best move with production game rules
 * (walls placed by the move change the grid; the mover's own mouse moving does
 * not change their goal). Throws on malformed or illegal bestMove.
 */
export const computeBestMoveDelta = (
  candidate: GeneratedCustomSetupCandidate,
  bestMove: string,
): { beforeDistance: number; afterDistance: number; delta: number } => {
  const state = new GameState(candidate.config, 0);
  const mover = candidate.humanPlaysAs;

  const beforeDistance = state.grid.distance(
    state.pawns[mover].cat,
    state.goalCell(mover),
  );

  const move = moveFromStandardNotation(bestMove, candidate.config.boardHeight);
  // applyGameAction is immutable: it returns the next state.
  const next = state.applyGameAction({
    kind: "move",
    move,
    playerId: mover,
    timestamp: 0,
  });

  const afterDistance = next.grid.distance(
    next.pawns[mover].cat,
    next.goalCell(mover),
  );

  return {
    beforeDistance,
    afterDistance,
    delta: afterDistance - beforeDistance,
  };
};

/** Nil's rule: keep iff the best move improves the distance by at most 1. */
export const keepByDelta = (delta: number): boolean => delta >= -1;

/**
 * How decisively the mover must be winning for the position to be a puzzle.
 *
 * The engine contract promises only a number in [-1, +1] from P1's
 * perspective; it says nothing about calibration, so this is a threshold on
 * that number and NOT a win probability. The current UI maps 0.65 to a
 * displayed 82.5%.
 *
 * The value is the MIDPOINT of Nil's own curation boundary: he retired a
 * puzzle the engine scored ~0.592 for the mover and kept one at ~0.715.
 * An earlier version used 0.7, which hugged the kept edge — and the kept
 * puzzle then read 0.691, 0.715 and 0.757 across three independent
 * evaluations, so 0.7 turned ordinary engine noise into an arbitrary
 * classification. The midpoint classified every independent reading of both
 * anchors on Nil's intended side of the boundary.
 */
export const MIN_MOVER_EVALUATION = 0.65;

/**
 * A TypeScript field does not validate imported JSON, so every evaluation is
 * range-checked at the boundary before it can be written or trusted.
 */
export const isValidEvaluation = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= -1 &&
  value <= 1;

/**
 * The raw P1-perspective evaluation as the MOVER sees it. The single place
 * the sign is flipped — getting this backwards would invert the whole rule,
 * so it is one helper with both directions pinned by tests.
 */
export const moverEvaluation = (evaluation: number, mover: PlayerId): number =>
  mover === 1 ? evaluation : -evaluation;

/** Rule 2: the mover must be decisively winning. */
export const keepByEvaluation = (moverEval: number): boolean =>
  moverEval >= MIN_MOVER_EVALUATION;

/** The sole conjunction of the two rules. Nothing else may combine them. */
export const keepVerdict = (input: {
  delta: number;
  moverEval: number;
}): boolean => keepByDelta(input.delta) && keepByEvaluation(input.moverEval);

/**
 * Apply a committed verdict file to the current candidate set, failing closed.
 *
 * Every candidate must have exactly one verdict whose fingerprint matches the
 * candidate's current position, and there must be no extra verdicts. Any
 * mismatch means the generator changed after the verdicts were computed —
 * regenerate them (scripts/filter-puzzle-candidates.ts) instead of trusting
 * stale decisions.
 *
 * Nothing recorded in the file is taken on trust. The recorded best move is
 * REPLAYED against production game rules and must reproduce the recorded
 * distances exactly, the evaluation must be a real number in range, and the
 * keep decision is RECOMPUTED from those replayed facts — the file's own
 * `keep` is only an audit checksum, and disagreement throws. Without the
 * replay, a structurally valid file with fabricated distances would be
 * accepted by every caller except the committed-artifact test.
 *
 * Returns only the kept candidates.
 */
export const applyCandidateVerdicts = (
  candidates: GeneratedCustomSetupCandidate[],
  file: CandidateVerdictFile,
): GeneratedCustomSetupCandidate[] => {
  const byId = new Map<string, CandidateVerdict>();
  for (const verdict of file.verdicts) {
    if (byId.has(verdict.candidateId)) {
      throw new Error(
        `Duplicate verdict for candidate ${verdict.candidateId} — regenerate the verdict file`,
      );
    }
    byId.set(verdict.candidateId, verdict);
  }

  if (byId.size !== candidates.length) {
    throw new Error(
      `Verdict count (${byId.size}) does not match candidate count ` +
        `(${candidates.length}) — regenerate the verdict file`,
    );
  }

  const kept: GeneratedCustomSetupCandidate[] = [];
  for (const candidate of candidates) {
    const verdict = byId.get(candidate.id);
    if (!verdict) {
      throw new Error(
        `No verdict for candidate ${candidate.id} — regenerate the verdict file`,
      );
    }
    const fingerprint = evaluationInputKey(candidate);
    if (verdict.fingerprint !== fingerprint) {
      throw new Error(
        `Verdict fingerprint mismatch for ${candidate.id} — the generator ` +
          `changed after the verdicts were computed; regenerate the verdict file`,
      );
    }

    if (!isValidEvaluation(verdict.evaluation)) {
      throw new Error(
        `Verdict evaluation for ${candidate.id} is not a number in [-1,1] ` +
          `(${String(verdict.evaluation)}) — regenerate the verdict file`,
      );
    }

    // A pass ("---") is valid notation and replays to zero distance change,
    // so for a delta-0 record it would reproduce the numbers exactly. The
    // engine never answers a live position with a pass — it errors instead —
    // so an empty move in the artifact means corruption.
    if (
      moveFromStandardNotation(verdict.bestMove, candidate.config.boardHeight)
        .actions.length === 0
    ) {
      throw new Error(
        `Verdict best move for ${candidate.id} is empty ("${verdict.bestMove}") ` +
          `— regenerate the verdict file`,
      );
    }

    // Replay the recorded move with production rules: recorded distances are
    // claims until they reproduce.
    const replayed = computeBestMoveDelta(candidate, verdict.bestMove);
    if (
      replayed.beforeDistance !== verdict.beforeDistance ||
      replayed.afterDistance !== verdict.afterDistance ||
      replayed.delta !== verdict.delta
    ) {
      throw new Error(
        `Verdict distances for ${candidate.id} do not reproduce: recorded ` +
          `${verdict.beforeDistance}->${verdict.afterDistance} ` +
          `(delta ${verdict.delta}), replayed ` +
          `${replayed.beforeDistance}->${replayed.afterDistance} ` +
          `(delta ${replayed.delta}) — regenerate the verdict file`,
      );
    }

    const keep = keepVerdict({
      delta: replayed.delta,
      moverEval: moverEvaluation(verdict.evaluation, candidate.humanPlaysAs),
    });
    if (keep !== verdict.keep) {
      throw new Error(
        `Verdict keep flag for ${candidate.id} disagrees with the current ` +
          `rule (recorded ${verdict.keep}, recomputed ${keep}) — the rule ` +
          `changed after the verdicts were computed; regenerate the verdict file`,
      );
    }
    if (keep) {
      kept.push(candidate);
    }
  }

  return kept;
};
