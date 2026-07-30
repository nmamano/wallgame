/**
 * Contracts for saved puzzles (named persisted entities, S-G1).
 *
 * A saved puzzle is a custom-setup position persisted in the saved_puzzles
 * table with a durable display name. The page fetches {id, displayName,
 * config} for display, but LAUNCH is server-authoritative (S-P1): the client
 * sends only the puzzleId and the server derives config, seat, and lead-in
 * from the DB row. The id/name still travel client-side in the game
 * handshake for banner display and Retry.
 *
 * Lead-in (S-P1, "P1 moves first" axiom): puzzles whose curated position has
 * the human as P2 store a scripted bot first move — `piece` starts on `from`
 * in the pre-position and double-moves to its curated cell as real ply 0.
 * Invariant: a P2 puzzle MUST have a lead-in, a P1 puzzle MUST NOT. The
 * launch path fails closed on violations (a listing read stays soft so the
 * page survives the migration->population rollout gap).
 *
 * DB JSONB is untrusted at the boundary: the route parses every selected
 * row (including createdAt and the identity column) before returning, and
 * the frontend parses the response before launch. The config shape is the
 * exact supported custom-setup GameConfiguration wire shape — a corrupted
 * enabled row fails the request closed rather than reaching playVsBot.
 *
 * (This file previously held the legacy tutorial-era puzzle CRUD schema;
 * that API surface is intentionally removed along with its unauthenticated
 * POST/DELETE routes.)
 */

import { z } from "zod";
import { cellSchema, customSetupConfigSchema } from "./games";

const nonempty = z.string().min(1);

/**
 * Scripted bot first move for human-as-P2 puzzles: `piece` stands on `from`
 * in the pre-position and double-moves to its curated cell as real ply 0.
 */
export const savedPuzzleLeadInSchema = z
  .object({
    piece: z.enum(["cat", "mouse"]),
    from: cellSchema,
  })
  .strict();

/** Provenance recorded when a batch is seeded (JSONB `source` column). */
export const savedPuzzleSourceSchema = z.object({
  candidateId: nonempty,
  /** Mover-aware evaluation fingerprint (custom-setup-verdicts). */
  fingerprint: nonempty,
  bestMove: nonempty,
  beforeDistance: z.number().int(),
  afterDistance: z.number().int(),
  delta: z.number().int(),
  /**
   * The engine's raw P1-perspective evaluation at ply 0, recorded from
   * 2026-07-29 so a row carries the number its keep decision rested on.
   * OPTIONAL because the rows seeded before that date do not have it and are
   * deliberately not backfilled — their provenance is the committed verdict
   * artifact of the day they were seeded.
   */
  evaluation: z.number().min(-1).max(1).optional(),
  evaluatedAt: z.string().datetime(),
  origin: nonempty,
  engine: nonempty,
});

const savedPuzzleRowBase = z.object({
  id: nonempty,
  displayName: nonempty,
  sortIndex: z.number().int(),
  enabled: z.boolean(),
  config: customSetupConfigSchema,
  leadIn: savedPuzzleLeadInSchema.nullable(),
  source: savedPuzzleSourceSchema,
  /** Identity column; must mirror source.fingerprint (refined below). */
  sourceFingerprint: nonempty,
});

const fingerprintsMatch = {
  message: "sourceFingerprint must equal source.fingerprint",
  path: ["sourceFingerprint"],
};

const leadInMatchesSeat = {
  message: "a human-as-P2 puzzle must have a leadIn and a P1 puzzle must not",
  path: ["leadIn"],
};

const hasLeadInIffHumanIsP2 = (row: {
  config: z.infer<typeof customSetupConfigSchema>;
  leadIn: unknown;
}) => (row.config.variantConfig.turn.playerId === 2) === (row.leadIn !== null);

/** What the seeder inserts (createdAt is the DB default). */
export const savedPuzzleSeedRowSchema = savedPuzzleRowBase
  .refine(
    (row) => row.sourceFingerprint === row.source.fingerprint,
    fingerprintsMatch,
  )
  .refine(hasLeadInIffHumanIsP2, leadInMatchesSeat);

/** A full saved_puzzles row as read back from the DB. */
export const savedPuzzleDbRowSchema = savedPuzzleRowBase
  .extend({
    createdAt: z.instanceof(Date),
  })
  .refine(
    (row) => row.sourceFingerprint === row.source.fingerprint,
    fingerprintsMatch,
  );

/**
 * Likes and dislikes on one puzzle, plus the caller's own vote (S-G4).
 * `myVote` is null for an anonymous caller and for one who has not voted —
 * the two are the same to the UI, which only offers controls to a player who
 * has solved the puzzle anyway.
 */
export const puzzleVoteStateSchema = z.object({
  likes: z.number().int().nonnegative(),
  dislikes: z.number().int().nonnegative(),
  myVote: z.union([z.literal(1), z.literal(-1), z.null()]),
});

/** Body of a vote write: 1 likes, -1 dislikes, null withdraws. */
export const puzzleVoteRequestSchema = z
  .object({
    value: z.union([z.literal(1), z.literal(-1), z.null()]),
  })
  .strict();

/**
 * What the list endpoint returns per puzzle.
 *
 * `sortIndex` is the durable numeric order the server keeps; it ships so the
 * client can offer a "Most liked" sort with a deterministic tiebreak instead
 * of parsing display names or leaning on array order.
 */
export const savedPuzzleSchema = z
  .object({
    id: nonempty,
    displayName: nonempty,
    sortIndex: z.number().int(),
    config: customSetupConfigSchema,
  })
  .merge(puzzleVoteStateSchema);

export const savedPuzzlesResponseSchema = z.object({
  puzzles: z.array(savedPuzzleSchema),
});

export type SavedPuzzleLeadIn = z.infer<typeof savedPuzzleLeadInSchema>;
export type SavedPuzzleSource = z.infer<typeof savedPuzzleSourceSchema>;
export type SavedPuzzleSeedRow = z.infer<typeof savedPuzzleSeedRowSchema>;
export type SavedPuzzleDbRow = z.infer<typeof savedPuzzleDbRowSchema>;
export type SavedPuzzle = z.infer<typeof savedPuzzleSchema>;
export type SavedPuzzlesResponse = z.infer<typeof savedPuzzlesResponseSchema>;
export type SavedPuzzleConfig = z.infer<typeof customSetupConfigSchema>;
export type PuzzleVoteState = z.infer<typeof puzzleVoteStateSchema>;
export type PuzzleVoteRequest = z.infer<typeof puzzleVoteRequestSchema>;

/**
 * Pure row->response mapping used by the GET /api/puzzles route: validates
 * each full DB row (throws on the first corrupted one — fail closed), drops
 * disabled rows, orders by sortIndex, and projects the public shape.
 *
 * `voteStates` carries the counts; a puzzle nobody has voted on is simply
 * absent from it and defaults to zeroes with no vote of its own, so the
 * listing shape never depends on whether voting has happened yet.
 */
export const mapSavedPuzzleRows = (
  rows: unknown[],
  voteStates?: Map<string, PuzzleVoteState>,
): SavedPuzzle[] =>
  rows
    .map((row) => savedPuzzleDbRowSchema.parse(row))
    .filter((row) => row.enabled)
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .map((row) => {
      const votes = voteStates?.get(row.id);
      return {
        id: row.id,
        displayName: row.displayName,
        sortIndex: row.sortIndex,
        config: row.config,
        likes: votes?.likes ?? 0,
        dislikes: votes?.dislikes ?? 0,
        myVote: votes?.myVote ?? null,
      };
    });

// ============================================================================
// Completion tracking (S-G3)
// ============================================================================

/**
 * Everything the /puzzles page has been completed on, kept as THREE arrays on
 * purpose: the id namespaces differ (generated puzzles are nanoid rows in
 * saved_puzzles, scripted ones are "1".."10" from the domain set, campaign
 * levels are their own ids) and so do the trust models — a generated solve is
 * server-verified from the game record, a scripted or campaign one is
 * client-asserted. Merging them would invite a later reader to treat asserted
 * completions as verified.
 *
 * Campaign levels joined this response in S-FOLD, when the campaign moved onto
 * the /puzzles page: three sections on one page share ONE progress read, so
 * the route loader warms them together and one invalidation refreshes all of
 * them. Campaign WRITES still go to /api/campaign/complete, and
 * GET /api/campaign/progress is kept for old bundles.
 *
 * `completedCampaignLevelIds` is REQUIRED. An old-shaped response missing it
 * must fail closed rather than quietly render every campaign level as
 * unfinished.
 *
 * All three arrays are sorted, so responses are deterministic for caching and
 * tests.
 */
export const puzzleProgressResponseSchema = z.object({
  solvedGeneratedIds: z.array(nonempty),
  solvedScriptedIds: z.array(nonempty),
  completedCampaignLevelIds: z.array(nonempty),
});

/** Body of the client-asserted scripted-completion write. */
export const scriptedCompletionRequestSchema = z
  .object({
    puzzleId: z.string().min(1).max(32),
  })
  .strict();

export type PuzzleProgressResponse = z.infer<
  typeof puzzleProgressResponseSchema
>;
export type ScriptedCompletionRequest = z.infer<
  typeof scriptedCompletionRequestSchema
>;
