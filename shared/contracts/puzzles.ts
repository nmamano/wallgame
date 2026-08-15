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
 * Invariant: ONLY a P2 puzzle may carry one, and carrying one is what makes a
 * P2 puzzle launchable against a bot (`isBotLaunchReady`). A P2 puzzle without
 * one is not broken — it is a puzzle no bot can open, played instead against
 * its authored line. The launch path fails closed either way.
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
import { authoredPositionConfigSchema, cellSchema } from "./games";

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

/** The 1-5 tier a player sees, or null when nothing honest can be shown. */
export const puzzleDifficultySchema = z.number().int().min(1).max(5).nullable();

/**
 * The author recorded for a puzzle the generation pipeline produced. Nil's
 * word for it (2026-08-03), and a real value rather than an empty string, so
 * "nobody wrote this" is stated instead of missing. Display surfaces skip the
 * byline for it — "by synthetic" is noise on every generated card.
 */
export const SYNTHETIC_AUTHOR = "synthetic";

const savedPuzzleRowBase = z.object({
  id: nonempty,
  displayName: nonempty,
  sortIndex: z.number().int(),
  enabled: z.boolean(),
  config: authoredPositionConfigSchema,
  leadIn: savedPuzzleLeadInSchema.nullable(),
  /** Descriptive only. "synthetic" for the pipeline, a person for the rest. */
  author: nonempty,
  difficulty: puzzleDifficultySchema,
  /**
   * The authored line this row can fall back to, or null when it has none.
   * Non-null only for the handcrafted set — see the table's own comment for
   * why it is a stable key rather than the display name or the sort index.
   */
  legacyScriptedId: nonempty.nullable(),
  /** Pipeline provenance; null for a handcrafted puzzle, which has none. */
  source: savedPuzzleSourceSchema.nullable(),
  /** Identity column; mirrors source.fingerprint, and is null exactly when it is. */
  sourceFingerprint: nonempty.nullable(),
});

/**
 * Provenance is all-or-nothing, and when present the identity column must
 * mirror the JSON it came from. Mirrors the DB's own CHECK constraint: the
 * table guards every writer, this guards everything crossing the boundary.
 */
const fingerprintsMatch = {
  message:
    "source and sourceFingerprint must both be present or both absent, and must agree",
  path: ["sourceFingerprint"],
};

const provenanceConsistent = (row: {
  source: unknown;
  sourceFingerprint: string | null;
}) =>
  row.source === null
    ? row.sourceFingerprint === null
    : row.sourceFingerprint ===
      (row.source as { fingerprint: string }).fingerprint;

const leadInMatchesSeat = {
  message: "only a human-as-P2 puzzle may carry a leadIn",
  path: ["leadIn"],
};

/**
 * A lead-in is the BOT's scripted opening move, and it exists for one reason:
 * when the human plays P2 the game must still open with a real P1 move.
 *
 * So a human-as-P1 row must NEVER carry one — a stray lead-in would silently
 * start the puzzle a ply early, on a position nobody authored.
 *
 * A human-as-P2 row MAY carry one, and whether it does is exactly the
 * statement "this row can be launched against a bot" (see `botLaunchReady`).
 * It is deliberately not required: a puzzle with no bot that can play it is
 * still a perfectly good puzzle, it is just walked through by hand instead.
 *
 * What this rule must NOT do is reason about board dimensions. An earlier
 * version required a lead-in whenever the board was at least 4x4, importing
 * one engine's floor into the catalog's idea of a valid row — which is both
 * wrong at the edges (a 13x10 board is over every declared maximum) and the
 * exact coupling `botSupportsPosition` exists to remove. Whether a bot can
 * play a position is answered by the bot's own declaration, at the moment
 * somebody wants to play it, and never by a constant in here.
 */
const hasLeadInOnlyIfHumanIsP2 = (row: {
  config: z.infer<typeof authoredPositionConfigSchema>;
  leadIn: unknown;
}) => row.leadIn === null || row.config.initialState.turn.playerId === 2;

/**
 * Whether this row could be handed to a bot at all.
 *
 * True when the human moves first (the bot simply replies), or when the bot's
 * scripted opening move is stored. A human-as-P2 row without one cannot be
 * launched no matter which bot is online, because there would be no P1 move to
 * open with — `resolveSavedPuzzleLaunch` refuses it on the server, and this is
 * what lets the client avoid offering it in the first place.
 *
 * Note what it does NOT answer: whether a bot is actually around, or serves
 * this variant and size. That is `botSupportsPosition`, asked of a live bot.
 */
export const isBotLaunchReady = (row: {
  config: z.infer<typeof authoredPositionConfigSchema>;
  leadIn: unknown;
}): boolean =>
  row.config.initialState.turn.playerId === 1 || row.leadIn !== null;

/** What the seeder inserts (createdAt is the DB default). */
export const savedPuzzleSeedRowSchema = savedPuzzleRowBase
  .refine(provenanceConsistent, fingerprintsMatch)
  .refine(hasLeadInOnlyIfHumanIsP2, leadInMatchesSeat);

/** A full saved_puzzles row as read back from the DB. */
export const savedPuzzleDbRowSchema = savedPuzzleRowBase
  .extend({
    createdAt: z.instanceof(Date),
  })
  .refine(provenanceConsistent, fingerprintsMatch)
  .refine(hasLeadInOnlyIfHumanIsP2, leadInMatchesSeat);

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
    config: authoredPositionConfigSchema,
    author: nonempty,
    difficulty: puzzleDifficultySchema,
    /**
     * Present iff this puzzle has an authored line to fall back to. The
     * launcher needs it to answer "can this be played at all when no bot is
     * available", and the scripted player needs it to find the line.
     */
    legacyScriptedId: nonempty.nullable(),
    /**
     * Whether a bot could be handed this row at all — see `isBotLaunchReady`.
     * Shipped rather than re-derived on the client so there is one definition
     * of it, and because `leadIn` itself is server-only.
     */
    botLaunchReady: z.boolean(),
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
export type SavedPuzzleConfig = z.infer<typeof authoredPositionConfigSchema>;
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
        author: row.author,
        difficulty: row.difficulty,
        legacyScriptedId: row.legacyScriptedId,
        botLaunchReady: isBotLaunchReady(row),
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
 * purpose. The split is no longer about id NAMESPACES — since handcrafted
 * puzzles became saved_puzzles rows, the first two share one nanoid namespace
 * — it is about EVIDENCE, which is the distinction that actually matters:
 *
 *   verifiedSolvedSavedPuzzleIds  — the server watched you win. Read from
 *     decisive games carrying that puzzle's id; unforgeable.
 *   assertedCompletedSavedPuzzleIds — you told us you finished it. Migrated
 *     from the client-asserted scripted completions, and still written that
 *     way for a puzzle played against its authored line, where there is no
 *     game record to check.
 *
 * They are DISJOINT rather than one merged list plus a verified subset: two
 * sources state exactly what the server knows, whereas a union plus a subset
 * invents an invariant ("verified ⊆ union") that can drift. A card is solved
 * if it appears in either, which is one Set union at the point of display.
 *
 * Keeping them apart is what makes voting safe by construction. A vote is
 * earned by BEATING a puzzle, so its eligibility check reads decisive games
 * directly (`hasVerifiedSavedPuzzleSolve`) and never any array here — but if
 * these were merged, a future reader wiring voting to "solved" would silently
 * let a client assertion buy a vote.
 *
 * Campaign levels joined this response in S-FOLD, when the campaign moved onto
 * the /puzzles page: three sections on one page share ONE progress read, so
 * the route loader warms them together and one invalidation refreshes all of
 * them. They keep their own ids and their own array. Campaign WRITES still go
 * to /api/campaign/complete, and GET /api/campaign/progress is kept for old
 * bundles.
 *
 * Every field is REQUIRED. An old-shaped response must fail closed rather than
 * quietly render everything as unfinished.
 *
 * All three arrays are sorted, so responses are deterministic for caching and
 * tests.
 */
export const puzzleProgressResponseSchema = z.object({
  verifiedSolvedSavedPuzzleIds: z.array(nonempty),
  assertedCompletedSavedPuzzleIds: z.array(nonempty),
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
