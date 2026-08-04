/**
 * A rehearsal of the authored-puzzle migration against a real database shaped
 * like production.
 *
 * This migration runs ONCE, against rows people have already shared links to.
 * The pure planner is unit tested, but the planner cannot tell you whether the
 * two-pass renumber actually survives the UNIQUE constraint on sort_index,
 * whether the completion rewrite lands, or whether a second run is genuinely a
 * no-op. Those are properties of the database, so they get a database.
 *
 * THE FIXTURE IS PRODUCTION, read from it on 2026-08-04: 41 rows at sort_index
 * 1-41, of which 33 are enabled and visibly numbered "Puzzle 1".."Puzzle 33"
 * contiguously, and 8 are retired keeping stale names — including
 * "Puzzle 39", whose number is HIGHER than any live one. Plus 61 client-
 * asserted completions spread over the ten authored ids.
 */

import {
  describe,
  it,
  beforeEach,
  beforeAll,
  afterAll,
  expect,
} from "bun:test";
import type { StartedTestContainer } from "testcontainers";

import { setupEphemeralDb, teardownEphemeralDb } from "../setup-db";

let container: StartedTestContainer | undefined;
let db: typeof import("../../server/db").db;
let savedPuzzlesTable: typeof import("../../server/db/schema/saved-puzzles").savedPuzzlesTable;
let scriptedPuzzleCompletionsTable: typeof import("../../server/db/schema/scripted-puzzle-completions").scriptedPuzzleCompletionsTable;
let applyHandcraftedMigration: typeof import("../../server/db/apply-handcrafted-migration").applyHandcraftedMigration;

/** The eight retired rows, exactly as production holds them. */
const RETIRED: [string, number][] = [
  ["Generated Puzzle 1", 1],
  ["Generated Puzzle 6", 6],
  ["Puzzle 17", 19],
  ["Puzzle 19", 21],
  ["Puzzle 28", 30],
  ["Puzzle 32", 34],
  ["Puzzle 34", 36],
  ["Puzzle 39", 41],
];

const seedProductionShape = async () => {
  const retiredAt = new Map(RETIRED.map(([name, index]) => [index, name]));
  const rows = [];
  let visible = 0;
  for (let sortIndex = 1; sortIndex <= 41; sortIndex++) {
    const retired = retiredAt.get(sortIndex);
    if (retired) {
      rows.push({ displayName: retired, sortIndex, enabled: false });
    } else {
      visible += 1;
      rows.push({ displayName: `Puzzle ${visible}`, sortIndex, enabled: true });
    }
  }
  await db.insert(savedPuzzlesTable).values(
    rows.map((row) => ({
      id: `gen-${row.sortIndex}`,
      displayName: row.displayName,
      sortIndex: row.sortIndex,
      enabled: row.enabled,
      config: {},
      source: { fingerprint: `fp-${row.sortIndex}` },
      sourceFingerprint: `fp-${row.sortIndex}`,
    })),
  );

  // 61 completions over the ten authored ids, matching production's spread.
  const perPuzzle: Record<string, number> = {
    "1": 14,
    "2": 9,
    "3": 10,
    "4": 7,
    "5": 6,
    "6": 4,
    "7": 4,
    "8": 3,
    "9": 3,
    "10": 1,
  };
  const completions = [];
  for (const [puzzleId, count] of Object.entries(perPuzzle)) {
    for (let n = 0; n < count; n++) {
      completions.push({ puzzleId, userId: null });
    }
  }
  await db.insert(scriptedPuzzleCompletionsTable).values(completions);
  return completions.length;
};

const readRows = async () =>
  (await db.select().from(savedPuzzlesTable)).sort(
    (a, b) => a.sortIndex - b.sortIndex,
  );

const visibleNumber = (name: string): number | null => {
  const match = /(\d+)\s*$/.exec(name);
  return match ? Number(match[1]) : null;
};

let seededCompletions = 0;

describe("handcrafted puzzle migration, on production-shaped data", () => {
  beforeAll(async () => {
    container = (await setupEphemeralDb()).container;
    db = (await import("../../server/db")).db;
    savedPuzzlesTable = (await import("../../server/db/schema/saved-puzzles"))
      .savedPuzzlesTable;
    scriptedPuzzleCompletionsTable = (
      await import("../../server/db/schema/scripted-puzzle-completions")
    ).scriptedPuzzleCompletionsTable;
    applyHandcraftedMigration = (
      await import("../../server/db/apply-handcrafted-migration")
    ).applyHandcraftedMigration;
  }, 120_000);

  beforeEach(async () => {
    await db.delete(scriptedPuzzleCompletionsTable);
    await db.delete(savedPuzzlesTable);
    seededCompletions = await seedProductionShape();
  });

  afterAll(async () => {
    await teardownEphemeralDb(container);
  }, 60_000);

  const migrate = (
    mode: "curated-first" | "curated-last" = "curated-first",
  ) => {
    let n = 0;
    return db.transaction((tx) =>
      applyHandcraftedMigration(tx, mode, () => `authored-${++n}`),
    );
  };

  it("applies, reporting exactly what it did", async () => {
    const result = await migrate();
    expect(result.applied).toBe(true);
    expect(result.inserted).toBe(10);
    expect(result.renumbered).toBe(41);
    expect(result.movedCompletions).toBe(seededCompletions);
    expect(result.insertedNames).toEqual([
      "Puzzle 1",
      "Puzzle 2",
      "Puzzle 3",
      "Puzzle 4",
      "Puzzle 5",
      "Puzzle 6",
      "Puzzle 7",
      "Puzzle 8",
      "Puzzle 9",
      "Puzzle 10",
    ]);
  });

  it("survives the UNIQUE sort_index while shifting every row", async () => {
    // The two-pass park exists for this. A single "+10" would collide with a
    // row it had not moved yet, and which row that is depends on update order.
    await migrate();
    const rows = await readRows();
    expect(rows).toHaveLength(51);
    expect(rows.map((row) => row.sortIndex)).toEqual(
      Array.from({ length: 51 }, (_, index) => index + 1),
    );
  });

  it("puts the authored ten first, disabled, with their line attached", async () => {
    await migrate();
    const rows = await readRows();
    const authored = rows.slice(0, 10);
    expect(authored.map((row) => row.legacyScriptedId)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
    ]);
    // Live immediately, playing their authored line exactly as before: no bot
    // declares custom-setup-classic yet, so the opponent is unchanged.
    expect(authored.every((row) => row.enabled === true)).toBe(true);
    expect(authored.every((row) => row.source === null)).toBe(true);
    expect(authored.map((row) => row.author)).toEqual([
      "Nilo",
      "Nilo",
      "Nilo",
      "Nilo",
      "Nilo",
      "Nilo",
      "Nilo",
      "Nilo",
      "Nilo",
      "Tim",
    ]);
  });

  it("renumbers the live generated set to 11..43 and leaves retired names alone", async () => {
    await migrate();
    const rows = await readRows();
    const live = rows.filter(
      (row) => row.enabled && row.legacyScriptedId === null,
    );
    // The 33 live generated rows, now numbered 11-43.
    expect(live.map((row) => visibleNumber(row.displayName))).toEqual(
      Array.from({ length: 33 }, (_, index) => index + 11),
    );
    // Retired rows keep exactly the stale names they had.
    const retired = rows
      .filter((row) => !row.enabled && row.legacyScriptedId === null)
      .map((row) => row.displayName)
      .sort();
    expect(retired).toEqual(RETIRED.map(([name]) => name).sort());
  });

  it("moves every completion onto a row id, leaving none behind", async () => {
    await migrate();
    const completions = await db
      .selectDistinct({ puzzleId: scriptedPuzzleCompletionsTable.puzzleId })
      .from(scriptedPuzzleCompletionsTable);
    const authoredIds = new Set(
      (await readRows())
        .filter((row) => row.legacyScriptedId !== null)
        .map((row) => row.id),
    );
    expect(completions).toHaveLength(10);
    for (const row of completions) {
      expect(authoredIds.has(row.puzzleId)).toBe(true);
      // The old namespace must be gone entirely.
      expect(/^\d{1,2}$/.test(row.puzzleId)).toBe(false);
    }
  });

  it("is a no-op when run a second time", async () => {
    await migrate();
    const before = await readRows();
    const second = await migrate();
    expect(second.applied).toBe(false);
    expect(second.renumbered).toBe(0);
    // Critically: nothing renumbered again. A second shift would move every
    // live puzzle another ten places.
    expect(await readRows()).toEqual(before);
  });

  it("rolls the whole thing back if the insert fails", async () => {
    // A REAL fault, not a decorative one: minting the same id for every row
    // makes the ten-row insert violate the primary key, so the failure happens
    // inside the transaction after the renumber has already been written.
    // That is the case that matters - a half-applied run would leave every
    // live puzzle shifted ten places with no authored puzzles to show for it.
    const before = await readRows();
    let threw = false;
    try {
      await db.transaction((tx) =>
        applyHandcraftedMigration(tx, "curated-first", () => "duplicate-id"),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const after = await readRows();
    expect(after).toEqual(before);
    // Specifically: the renumber did not survive.
    expect(after.map((row) => row.sortIndex)).toEqual(
      Array.from({ length: 41 }, (_, index) => index + 1),
    );
    expect(after.filter((row) => row.legacyScriptedId !== null)).toHaveLength(
      0,
    );
    // And the completions still name the authored ids, untouched.
    const completions = await db
      .selectDistinct({ puzzleId: scriptedPuzzleCompletionsTable.puzzleId })
      .from(scriptedPuzzleCompletionsTable);
    expect(completions.map((row) => row.puzzleId).sort()).toEqual([
      "1",
      "10",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
  });
});
