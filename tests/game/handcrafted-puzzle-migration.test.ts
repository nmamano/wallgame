import { describe, expect, it } from "bun:test";

import {
  planHandcraftedMigration,
  puzzleNumberFromName,
  type ExistingPuzzleRow,
} from "../../shared/domain/handcrafted-puzzle-migration";

/**
 * The one-shot move of the authored puzzles into the puzzle table.
 *
 * Worth testing harder than most code because of HOW it fails: not by
 * crashing, but by producing an ordering that still looks plausible. A gap in
 * the indices, or a number shifted by the wrong amount, renders as a perfectly
 * normal list and quietly points share links at the wrong puzzles.
 *
 * The fixture mirrors the shape production is actually in: contiguous visible
 * numbering over the ENABLED rows, with retired rows interleaved keeping stale
 * names and consuming sort indices.
 */
const existing: ExistingPuzzleRow[] = [
  { id: "g1", displayName: "Puzzle 1", sortIndex: 1, enabled: true },
  { id: "g2", displayName: "Puzzle 2", sortIndex: 2, enabled: true },
  { id: "r1", displayName: "Generated Puzzle 6", sortIndex: 3, enabled: false },
  { id: "g3", displayName: "Puzzle 3", sortIndex: 4, enabled: true },
  { id: "r2", displayName: "Puzzle 9", sortIndex: 5, enabled: false },
];

describe("puzzleNumberFromName", () => {
  it("reads the trailing number, or nothing", () => {
    expect(puzzleNumberFromName("Puzzle 7")).toBe(7);
    expect(puzzleNumberFromName("Generated Puzzle 12")).toBe(12);
    expect(puzzleNumberFromName("Special Puzzle")).toBeNull();
    expect(puzzleNumberFromName("Puzzle 0")).toBeNull();
  });
});

describe("planHandcraftedMigration — curated-first", () => {
  const plan = planHandcraftedMigration("curated-first", existing);

  it("puts the authored ten at 1-10", () => {
    expect(plan.inserts.map((row) => row.sortIndex)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(plan.inserts.map((row) => row.displayName)).toEqual([
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

  it("shifts every existing row up by exactly ten", () => {
    expect(
      plan.renumber.map((row) => ({ id: row.id, sortIndex: row.sortIndex })),
    ).toEqual([
      { id: "g1", sortIndex: 11 },
      { id: "g2", sortIndex: 12 },
      { id: "r1", sortIndex: 13 },
      { id: "g3", sortIndex: 14 },
      { id: "r2", sortIndex: 15 },
    ]);
  });

  it("renames the visible rows by their OWN number, and leaves retired ones alone", () => {
    // The live numbering runs over enabled rows only, so a retired row's stale
    // name must not be dragged into the sequence — and recomputing names from
    // sort_index would do exactly that.
    const renamed = Object.fromEntries(
      plan.renumber
        .filter((row) => row.displayName !== undefined)
        .map((row) => [row.id, row.displayName]),
    );
    expect(renamed).toEqual({
      g1: "Puzzle 11",
      g2: "Puzzle 12",
      g3: "Puzzle 13",
    });
    expect(
      plan.renumber.find((row) => row.id === "r1")?.displayName,
    ).toBeUndefined();
    expect(
      plan.renumber.find((row) => row.id === "r2")?.displayName,
    ).toBeUndefined();
  });

  it("leaves no gap and no duplicate across the whole table", () => {
    const indices = [
      ...plan.inserts.map((row) => row.sortIndex),
      ...plan.renumber.map((row) => row.sortIndex),
    ].sort((a, b) => a - b);
    expect(new Set(indices).size).toBe(indices.length);
    expect(indices).toEqual(
      Array.from({ length: indices.length }, (_, index) => index + 1),
    );
  });

  it("gives every puzzle a distinct visible number", () => {
    const names = [
      ...plan.inserts.map((row) => row.displayName),
      ...plan.renumber
        .filter((row) => row.displayName !== undefined)
        .map((row) => row.displayName!),
    ];
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("planHandcraftedMigration — curated-last", () => {
  const plan = planHandcraftedMigration("curated-last", existing);

  it("appends immediately after the existing rows, with NO gap", () => {
    // The bug this pins: starting at highestSortIndex + batch size + 1 leaves
    // a ten-index hole that still renders in the right order, so nothing looks
    // wrong until the next batch collides with it.
    expect(plan.inserts[0].sortIndex).toBe(6);
    expect(plan.inserts.map((row) => row.sortIndex)).toEqual([
      6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it("continues the visible numbering, ignoring retired rows entirely", () => {
    // The fixture's enabled rows are Puzzle 1-3; "Puzzle 9" is RETIRED and its
    // number is NOT spoken for. Continuing past it would leave a visible hole
    // at 4-9 and break the contiguous "Puzzle 1..K" invariant that
    // scripts/retire-puzzles.ts maintains and the link resolver relies on.
    expect(plan.inserts.map((row) => row.displayName)).toEqual([
      "Puzzle 4",
      "Puzzle 5",
      "Puzzle 6",
      "Puzzle 7",
      "Puzzle 8",
      "Puzzle 9",
      "Puzzle 10",
      "Puzzle 11",
      "Puzzle 12",
      "Puzzle 13",
    ]);
  });

  it("ignores a retired row numbered ABOVE every enabled one", () => {
    // The sharp case: a puzzle retired from the tail leaves a high stale name
    // behind. It must not push the new rows past it.
    const withHighRetired = [
      ...existing,
      { id: "r3", displayName: "Puzzle 99", sortIndex: 6, enabled: false },
    ];
    const appended = planHandcraftedMigration("curated-last", withHighRetired);
    expect(appended.inserts[0].displayName).toBe("Puzzle 4");
  });

  it("leaves the visible sequence contiguous across enabled rows", () => {
    const visible = [
      ...existing.filter((row) => row.enabled).map((row) => row.displayName),
      ...plan.inserts.map((row) => row.displayName),
    ].map((name) => puzzleNumberFromName(name));
    expect(visible).toEqual(
      Array.from({ length: visible.length }, (_, index) => index + 1),
    );
  });

  it("renumbers nothing, so no existing link changes meaning", () => {
    expect(plan.renumber).toEqual([]);
  });
});

describe("both modes", () => {
  for (const mode of ["curated-first", "curated-last"] as const) {
    it(`${mode}: seeds all ten, enabled, with their authored line attached`, () => {
      const plan = planHandcraftedMigration(mode, existing);
      expect(plan.inserts).toHaveLength(10);
      expect(plan.inserts.every((row) => row.enabled === true)).toBe(true);
      expect(plan.inserts.map((row) => row.legacyScriptedId)).toEqual([
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
    });

    it(`${mode}: parks above every index in play, so no update can collide`, () => {
      const plan = planHandcraftedMigration(mode, existing);
      const finalIndices = [
        ...plan.inserts.map((row) => row.sortIndex),
        ...plan.renumber.map((row) => row.sortIndex),
      ];
      const existingIndices = existing.map((row) => row.sortIndex);
      const parked = plan.renumber.map(
        (row) => row.sortIndex + plan.parkOffset,
      );
      for (const index of parked) {
        expect(existingIndices).not.toContain(index);
        expect(finalIndices).not.toContain(index);
      }
    });

    it(`${mode}: an empty table needs no renumbering and starts at 1`, () => {
      const plan = planHandcraftedMigration(mode, []);
      expect(plan.renumber).toEqual([]);
      expect(plan.inserts[0].sortIndex).toBe(1);
      expect(plan.inserts[0].displayName).toBe("Puzzle 1");
    });
  }

  it("parks clear of an unexpectedly high existing index", () => {
    // A fixed park constant would be silently wrong the day a row exists above
    // it. Derived from the data, this holds however far out the rows are.
    const far = [
      { id: "x", displayName: "Puzzle 1", sortIndex: 100_000, enabled: true },
    ];
    const plan = planHandcraftedMigration("curated-first", far);
    expect(plan.renumber[0].sortIndex + plan.parkOffset).toBeGreaterThan(
      100_000,
    );
  });
});
