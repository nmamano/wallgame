/**
 * Contracts for saved puzzles (named persisted entities, S-G1).
 *
 * A saved puzzle is a custom-setup position persisted in the saved_puzzles
 * table with a durable display name. The page fetches {id, displayName,
 * config} and launches through the existing client-side bot-game flow
 * (playVsBot with the persisted config); the id/name travel client-side in
 * the game handshake only. This is NOT a server-authoritative launch —
 * that becomes relevant with completion tracking.
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
import { customSetupConfigSchema } from "./games";

const nonempty = z.string().min(1);

/** Provenance recorded when a batch is seeded (JSONB `source` column). */
export const savedPuzzleSourceSchema = z.object({
  candidateId: nonempty,
  /** Mover-aware evaluation fingerprint (custom-setup-verdicts). */
  fingerprint: nonempty,
  bestMove: nonempty,
  beforeDistance: z.number().int(),
  afterDistance: z.number().int(),
  delta: z.number().int(),
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
  source: savedPuzzleSourceSchema,
  /** Identity column; must mirror source.fingerprint (refined below). */
  sourceFingerprint: nonempty,
});

const fingerprintsMatch = {
  message: "sourceFingerprint must equal source.fingerprint",
  path: ["sourceFingerprint"],
};

/** What the seeder inserts (createdAt is the DB default). */
export const savedPuzzleSeedRowSchema = savedPuzzleRowBase.refine(
  (row) => row.sourceFingerprint === row.source.fingerprint,
  fingerprintsMatch,
);

/** A full saved_puzzles row as read back from the DB. */
export const savedPuzzleDbRowSchema = savedPuzzleRowBase
  .extend({
    createdAt: z.instanceof(Date),
  })
  .refine(
    (row) => row.sourceFingerprint === row.source.fingerprint,
    fingerprintsMatch,
  );

/** What the list endpoint returns per puzzle. */
export const savedPuzzleSchema = z.object({
  id: nonempty,
  displayName: nonempty,
  config: customSetupConfigSchema,
});

export const savedPuzzlesResponseSchema = z.object({
  puzzles: z.array(savedPuzzleSchema),
});

export type SavedPuzzleSource = z.infer<typeof savedPuzzleSourceSchema>;
export type SavedPuzzleSeedRow = z.infer<typeof savedPuzzleSeedRowSchema>;
export type SavedPuzzleDbRow = z.infer<typeof savedPuzzleDbRowSchema>;
export type SavedPuzzle = z.infer<typeof savedPuzzleSchema>;
export type SavedPuzzlesResponse = z.infer<typeof savedPuzzlesResponseSchema>;
export type SavedPuzzleConfig = z.infer<typeof customSetupConfigSchema>;

/**
 * Pure row->response mapping used by the GET /api/puzzles route: validates
 * each full DB row (throws on the first corrupted one — fail closed), drops
 * disabled rows, orders by sortIndex, and projects the public shape.
 */
export const mapSavedPuzzleRows = (rows: unknown[]): SavedPuzzle[] =>
  rows
    .map((row) => savedPuzzleDbRowSchema.parse(row))
    .filter((row) => row.enabled)
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .map((row) => ({
      id: row.id,
      displayName: row.displayName,
      config: row.config,
    }));
