/**
 * Turning the ten authored puzzles into ordinary saved_puzzles rows.
 *
 * They were written as `classic` positions — each player races a cat to their
 * own home — and lived only in code, played as a scripted line. As rows they
 * remain `classic` and carry their explicit starting position in
 * `variantConfig`. Setup provenance is not a rules identity.
 *
 * What survives the move is everything a player sees: the author, the tier,
 * and the position itself. What is dropped is the 1350-1850 rating — Nil,
 * 2026-08-03: "the rating is pretty meaningless, it is just based on vibes" —
 * which is collapsed here, once, into the 1-5 tier every surface already
 * showed.
 *
 * The authored MOVE LINE deliberately stays in `shared/domain/puzzles.ts`,
 * reached through `legacyScriptedId`. It is authored content, like the
 * campaign's levels, and the row points at it rather than copying it.
 */

import { PUZZLES, getPuzzleIds, ratingToDifficulty } from "./puzzles";
import { authoredPositionConfigSchema } from "../contracts/games";
import type { SavedPuzzleSeedRow } from "../contracts/puzzles";

export type HandcraftedSeedRow = Omit<SavedPuzzleSeedRow, "id">;

/**
 * Build the rows, numbered from `firstSortIndex`.
 *
 * The numbering is a parameter rather than a constant because it is the one
 * thing that cannot be decided here: sort_index is UNIQUE across the whole
 * table, and the display name carries the number a share link resolves by
 * (`savedPuzzleNumber`), so where these ten sit relative to the existing rows
 * decides whether any live link changes meaning.
 *
 * `enabled` is TRUE, and the acceptance gate lives somewhere better.
 *
 * It was false at first, so no migrated puzzle went live before being played
 * through. But disabled rows are filtered out of the listing, and the code
 * that used to render these ten from `shared/domain/puzzles.ts` is gone — so
 * seeding them off would DELETE ten working puzzles from the site for the
 * length of the acceptance pass.
 *
 * Bot eligibility is selected by puzzle placement and the Classic capability,
 * while `legacyScriptedId` keeps the authored-line fallback.
 */
export const buildHandcraftedSeedRows = (
  firstSortIndex: number,
): HandcraftedSeedRow[] =>
  getPuzzleIds().map((scriptedId, index) => {
    const puzzle = PUZZLES[scriptedId];
    const config = authoredPositionConfigSchema.parse({
      variant: "classic",
      boardWidth: puzzle.boardWidth,
      boardHeight: puzzle.boardHeight,
      initialState: {
        pawns: {
          p1: { cat: puzzle.p1Cat, home: puzzle.p1Home },
          p2: { cat: puzzle.p2Cat, home: puzzle.p2Home },
        },
        walls: puzzle.initialWalls,
        // The authored position is stated from the side the human plays, with
        // a full turn ahead of them — which is exactly what `turn` means here.
        turn: { playerId: puzzle.humanPlaysAs, actionsTaken: [] },
      },
    });

    return {
      displayName: puzzle.title,
      sortIndex: firstSortIndex + index,
      enabled: true,
      config,
      author: puzzle.author,
      difficulty: ratingToDifficulty(puzzle.difficulty),
      legacyScriptedId: scriptedId,
      /**
       * No lead-in. For the nine human-as-P1 puzzles there is nothing for one
       * to do — the human opens. Puzzle 2 is human-as-P2 and so is NOT
       * bot-launchable (`isBotLaunchReady` is false for it): it is played
       * against its authored line, which is what it always was. Giving it a
       * lead-in later is what would make it bot-launchable, and nothing here
       * has to change for that.
       */
      leadIn: null,
      /** A person wrote it. There is no pipeline provenance to record. */
      source: null,
      sourceFingerprint: null,
    };
  });
