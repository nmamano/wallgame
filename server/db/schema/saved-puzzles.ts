import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Saved puzzles: every puzzle the /puzzles page offers, whatever made it.
 *
 * Originally this table held only the generated set (S-G1). The ten
 * handcrafted puzzles lived in `shared/domain/puzzles.ts` and were played as
 * a scripted line, which made them a second catalog with its own ids, its own
 * completion table and its own page. Nil's call (2026-08-03): "handcrafted
 * puzzles would be no different than generated ones. I do not see a good
 * reason why they would differ." So identity, listing, links and difficulty
 * are unified HERE, and only PLAYBACK still differs — see `legacyScriptedId`.
 *
 * Identity is a DB invariant: source_fingerprint (the mover-aware evaluation
 * fingerprint from custom-setup-verdicts) is UNIQUE, so re-running the seeder
 * can never duplicate a generated puzzle; sort_index is UNIQUE, so a later
 * batch must allocate new indices (or explicitly retire/update rows) rather
 * than collide with existing ones.
 *
 * `enabled` supports retiring a puzzle without deleting it (the set is
 * deliberately fluid), and is also the acceptance gate for a newly seeded
 * row: a migrated puzzle stays disabled until it has been played through.
 * `config` is the exact custom-setup wire GameConfiguration used to launch.
 *
 * NOTE: the legacy tutorial-era `puzzles` table still exists but is unused;
 * dropping it is a future non-additive migration.
 */
export const savedPuzzlesTable = pgTable(
  "saved_puzzles",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    sortIndex: integer("sort_index").notNull().unique(),
    enabled: boolean("enabled").notNull().default(true),
    config: jsonb("config").notNull(),
    /**
     * Who made this puzzle. "synthetic" for the generated pipeline, a person's
     * name for a handcrafted one. Purely descriptive: nothing branches on it.
     * How a puzzle LAUNCHES is decided from its config and `legacyScriptedId`,
     * never from who wrote it, so renaming an author can never change
     * behaviour.
     */
    author: text("author").notNull().default("synthetic"),
    /**
     * The 1-5 tier players see, or NULL when there is nothing honest to put
     * here. Nil, 2026-08-03, on the handcrafted set's 1350-1850 numbers: "the
     * rating is pretty meaningless, it is just based on vibes" — so the tier
     * is stored directly and the rating is gone. Generated rows are NULL:
     * their pipeline produces no difficulty, and their cards show votes, which
     * is what they already showed. Most rows are NULL on day one, so every
     * read path must render a puzzle without a difficulty.
     */
    difficulty: integer("difficulty"),
    /**
     * Scripted bot ply-0 move for human-as-P2 puzzles (S-P1 "P1 moves first"
     * axiom): {piece, from}. Invariant (enforced at the launch boundary, not
     * here): non-null iff the config's authored turn is P2.
     */
    leadIn: jsonb("lead_in"),
    /**
     * Which authored line in `shared/domain/puzzles.ts` this row is, for the
     * puzzles that still have one. Non-null ONLY for the handcrafted set.
     *
     * Two things need it. Three of the handcrafted boards are three rows tall
     * and the engine refuses anything under 4x4, so those puzzles can only
     * ever be played against their authored line. And for the rest it is the
     * pre-launch fallback: if no bot is available the authored line can still
     * be played, which is why the scripted machinery survives at all.
     *
     * It is a STABLE key, deliberately not the display name or the sort index
     * — both of those renumber when a puzzle is retired, and a fallback that
     * silently retargets after a renumber would play the wrong puzzle's line.
     */
    legacyScriptedId: text("legacy_scripted_id").unique(),
    /**
     * Where a GENERATED puzzle came from; NULL for a handcrafted one, which
     * has no pipeline provenance to record. Provenance only — identity never
     * queries this JSON.
     */
    source: jsonb("source"),
    sourceFingerprint: text("source_fingerprint").unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * Provenance is all-or-nothing. The fingerprint is the identity column
     * that makes seeding idempotent, so a row carrying one without the
     * `source` it was derived from (or the reverse) is a half-written row.
     * Postgres allows many NULLs under a UNIQUE index, so handcrafted rows
     * sharing NULL costs the generated set's uniqueness nothing.
     *
     * Checked here as well as in the Zod contract because the contract only
     * guards the paths that go through it; this guards the table.
     */
    check(
      "saved_puzzles_provenance_paired",
      sql`(${table.source} IS NULL) = (${table.sourceFingerprint} IS NULL)`,
    ),
    /** The tier players see; anything outside 1-5 is a bug, not a puzzle. */
    check(
      "saved_puzzles_difficulty_tier",
      sql`${table.difficulty} IS NULL OR (${table.difficulty} BETWEEN 1 AND 5)`,
    ),
  ],
);
