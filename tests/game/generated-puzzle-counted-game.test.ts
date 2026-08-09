import { describe, it, expect } from "bun:test";
import { generateCustomSetupCandidates } from "../../shared/domain/generated-custom-setup-candidates";
import { MIN_MOVES_FOR_A_COUNTED_GAME } from "../../shared/domain/game-utils";
import { Grid } from "../../shared/domain/grid";

/**
 * Completion tracking (S-G3) can only ever see puzzles whose win produces a
 * PERSISTED game, and a game that finishes before both players have moved is
 * treated as aborted and never stored (`MIN_MOVES_FOR_A_COUNTED_GAME`).
 *
 * For a human-as-P1 puzzle the human moves at ply 0, so an immediate win
 * would leave a move count of 1 — below the threshold — and the solve would
 * be silently unrecordable. (Human-as-P2 puzzles are safe by construction:
 * the bot's scripted lead-in is a real ply 0, so the human's winning move is
 * already the second.)
 *
 * Today this holds because the generator keeps both attack races at 3 moves
 * or more. That is a curation choice, not a law, so this test pins it: a
 * future generator or curation change that admits a one-ply win fails here
 * instead of quietly producing puzzles that cannot be marked solved.
 */

/** A ply is at most two pawn steps, so a win needs the goal within that. */
const MAX_PAWN_STEPS_PER_PLY = 2;

describe("generated puzzles stay recordable as completions", () => {
  const candidates = generateCustomSetupCandidates();

  it("gives no human-as-P1 puzzle a win on the opening ply", () => {
    const humanFirst = candidates.filter(
      (candidate) => candidate.humanPlaysAs === 1,
    );
    // Guard the premise: if the generator ever stopped producing P1 puzzles,
    // this test would pass vacuously.
    expect(humanFirst.length).toBeGreaterThan(0);

    for (const candidate of humanFirst) {
      const init = candidate.config.variantConfig;
      const grid = new Grid(
        candidate.config.boardWidth,
        candidate.config.boardHeight,
        "standard",
      );
      for (const wall of init.walls) grid.addWall(wall);

      // In standard the goal is the OPPONENT's mouse.
      const attackDistance = grid.distance(
        init.pawns.p1.cat,
        init.pawns.p2.mouse,
      );
      expect(attackDistance).toBeGreaterThan(MAX_PAWN_STEPS_PER_PLY);
    }
  });

  it("assumes the threshold it was written against", () => {
    // If this ever changes, re-read the reasoning above before adjusting.
    expect(MIN_MOVES_FOR_A_COUNTED_GAME).toBe(2);
  });
});
