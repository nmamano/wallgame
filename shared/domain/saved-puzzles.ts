/**
 * Builds the seed rows for the saved_puzzles table from the generated
 * candidates and their committed engine verdicts (S-G1). Pure — the seeder
 * script adds ids and performs the transactional insert.
 */

import type { GeneratedCustomSetupCandidate } from "./generated-custom-setup-candidates";
import {
  applyCandidateVerdicts,
  type CandidateVerdictFile,
} from "./custom-setup-verdicts";
import { authoredPositionConfigSchema } from "../contracts/games";
import {
  SYNTHETIC_AUTHOR,
  type SavedPuzzleSeedRow,
} from "../contracts/puzzles";
import { computeLeadIn, validateLeadInReplay } from "./puzzle-lead-in";

/**
 * Generated puzzles are named "Puzzle 1".."Puzzle N" by position.
 *
 * The ten hand-authored scripted puzzles are titled exactly "Puzzle
 * 1".."Puzzle 10", so the first ten names OVERLAP, deliberately (Nil,
 * 2026-07-29 — the word "Generated" described how a puzzle was made, which
 * is not the player's business). The overlap is safe only because a display
 * name is presentation: identity is the row id, and seed matching is by
 * `sourceFingerprint`. Nothing may look a puzzle up by name — a name-based
 * lookup would resolve two different puzzles to one.
 */
export const generatedPuzzleDisplayName = (sortIndex: number): string =>
  `Puzzle ${sortIndex}`;

/** A seed row before the seeder assigns its id. */
export type SavedPuzzleSeedRowWithoutId = Omit<SavedPuzzleSeedRow, "id">;

/**
 * Display names are presentation, not identity (identity is
 * sourceFingerprint). The UI shows continuous numbers, so retirement
 * renumbers the ENABLED rows positionally by sortIndex order; disabled rows
 * keep their historical names (harmless duplicates — enabled-aware tooling
 * never looks names up across disabled rows).
 */
export const computeContiguousRenames = (
  rows: {
    id: string;
    displayName: string;
    sortIndex: number;
    enabled: boolean;
  }[],
): { id: string; from: string; to: string }[] =>
  rows
    .filter((row) => row.enabled)
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .map((row, index) => ({
      id: row.id,
      from: row.displayName,
      to: generatedPuzzleDisplayName(index + 1),
    }))
    .filter((rename) => rename.from !== rename.to);

/**
 * Whether a stored row is the given committed seed row, by IDENTITY:
 * fingerprint and exact config. Deliberately name-free so contiguous
 * renumbering can never fail an identity preflight (populate script,
 * audits).
 */
export const rowMatchesSeedIdentity = (
  // Nullable on both sides, because the column is: a handcrafted row has no
  // provenance. Demanding a `string` here asked callers for something the DB
  // and the seed row type cannot promise.
  row: { sourceFingerprint: string | null; config: unknown },
  seed: SavedPuzzleSeedRowWithoutId,
): boolean =>
  row.sourceFingerprint === seed.sourceFingerprint &&
  JSON.stringify(row.config) === JSON.stringify(seed.config);

/**
 * The kept candidates (per the verdict file, validated fail-closed) as seed
 * rows, in generation order with sortIndex 1..N. The launch config is parsed
 * through the wire schema, so construction is exact at compile time AND
 * runtime. Throws when the verdicts do not match the candidates — never
 * seed from stale decisions.
 */
export const buildSavedPuzzleSeedRows = (
  candidates: GeneratedCustomSetupCandidate[],
  verdictFile: CandidateVerdictFile,
): SavedPuzzleSeedRowWithoutId[] => {
  const kept = applyCandidateVerdicts(candidates, verdictFile);
  const verdictById = new Map(
    verdictFile.verdicts.map((verdict) => [verdict.candidateId, verdict]),
  );

  return kept.map((candidate, index) => {
    const verdict = verdictById.get(candidate.id);
    if (!verdict) {
      // applyCandidateVerdicts guarantees coverage; this guards refactors.
      throw new Error(`No verdict for kept candidate ${candidate.id}`);
    }
    const sortIndex = index + 1;
    const config = authoredPositionConfigSchema.parse({
      variant: candidate.config.variant,
      boardWidth: candidate.config.boardWidth,
      boardHeight: candidate.config.boardHeight,
      initialState: candidate.config.initialState,
    });
    // P1-moves-first axiom (S-P1): a human-as-P2 puzzle cannot be seeded
    // without a plausible bot lead-in — fail closed, no wall fallback.
    const leadIn = computeLeadIn(config);
    if (config.initialState.turn.playerId === 2) {
      if (!leadIn) {
        throw new Error(
          `no pawn lead-in heuristic applies to candidate ${candidate.id}`,
        );
      }
      validateLeadInReplay(config, leadIn);
    }
    return {
      displayName: generatedPuzzleDisplayName(sortIndex),
      sortIndex,
      enabled: true,
      config,
      // Nobody wrote these; the pipeline produced them. Stated rather than
      // left empty, so a card can tell "no human author" from "unknown".
      author: SYNTHETIC_AUTHOR,
      // The pipeline produces no difficulty. Their cards show votes, which is
      // a community signal rather than an invented number.
      difficulty: null,
      // No authored line: a generated puzzle is only ever played against a bot.
      legacyScriptedId: null,
      leadIn,
      source: {
        candidateId: candidate.id,
        fingerprint: verdict.fingerprint,
        bestMove: verdict.bestMove,
        beforeDistance: verdict.beforeDistance,
        afterDistance: verdict.afterDistance,
        delta: verdict.delta,
        evaluation: verdict.evaluation,
        evaluatedAt: verdictFile.evaluatedAt,
        origin: verdictFile.origin,
        engine: verdictFile.botName,
      },
      sourceFingerprint: verdict.fingerprint,
    };
  });
};
