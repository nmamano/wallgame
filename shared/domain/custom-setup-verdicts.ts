/**
 * Engine-best-move filtering for generated custom-setup candidates (Nil's one
 * quality rule): a candidate is kept only if the engine's best first move
 * improves the mover's true distance to their goal by AT MOST 1. If the best
 * play is the greedy two-step walk at the target (delta -2), the puzzle's
 * answer is trivial walking and the candidate is rejected.
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
  /** afterDistance - beforeDistance. Keep iff delta >= -1. */
  delta: number;
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
 * Apply a committed verdict file to the current candidate set, failing closed:
 * every candidate must have exactly one verdict whose fingerprint matches the
 * candidate's current position, and there must be no extra verdicts. Any
 * mismatch means the generator changed after the verdicts were computed —
 * regenerate them (scripts/filter-puzzle-candidates.ts) instead of trusting
 * stale decisions. Returns only the kept candidates.
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
    if (verdict.keep) {
      kept.push(candidate);
    }
  }

  return kept;
};
