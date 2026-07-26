import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Saved puzzles: named persisted custom-setup positions (S-G1).
 *
 * Identity is a DB invariant: source_fingerprint (the mover-aware
 * evaluation fingerprint from custom-setup-verdicts) is UNIQUE, so
 * re-running the seeder can never duplicate a puzzle; sort_index is UNIQUE,
 * so a later batch must allocate new indices (or explicitly retire/update
 * rows) rather than collide with existing ones.
 *
 * `enabled` supports retiring a puzzle without deleting it (the set is
 * deliberately fluid). `config` is the exact custom-setup wire
 * GameConfiguration used to launch; `source` is provenance only — identity
 * never queries JSON.
 *
 * NOTE: the legacy tutorial-era `puzzles` table still exists but is unused;
 * dropping it is a future non-additive migration.
 */
export const savedPuzzlesTable = pgTable("saved_puzzles", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  sortIndex: integer("sort_index").notNull().unique(),
  enabled: boolean("enabled").notNull().default(true),
  config: jsonb("config").notNull(),
  /**
   * Scripted bot ply-0 move for human-as-P2 puzzles (S-P1 "P1 moves first"
   * axiom): {piece, from}. Invariant (enforced at the launch boundary, not
   * here): non-null iff the config's authored turn is P2. Nullable so the
   * additive migration lands before population.
   */
  leadIn: jsonb("lead_in"),
  source: jsonb("source").notNull(),
  sourceFingerprint: text("source_fingerprint").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
