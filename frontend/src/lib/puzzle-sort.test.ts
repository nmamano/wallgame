import { describe, expect, it } from "bun:test";
import { sortPuzzles, voteScore } from "./puzzle-sort";

/**
 * Ordering of the generated puzzle list (S-G4).
 *
 * The tiebreak is the part worth pinning: every puzzle starts at zero votes,
 * so a comparator without one would leave the default-looking list at the
 * mercy of sort stability, and a single vote would shuffle unrelated cards.
 */
const puzzle = (sortIndex: number, likes: number, dislikes: number) => ({
  id: `p${sortIndex}`,
  sortIndex,
  likes,
  dislikes,
});

describe("sorting puzzles", () => {
  it("keeps the server's order for the default option", () => {
    const list = [puzzle(3, 9, 0), puzzle(1, 0, 0), puzzle(2, 0, 5)];
    expect(sortPuzzles(list, "number").map((p) => p.id)).toEqual([
      "p3",
      "p1",
      "p2",
    ]);
  });

  it("ranks by likes minus dislikes", () => {
    const list = [puzzle(1, 1, 0), puzzle(2, 5, 1), puzzle(3, 0, 3)];
    expect(sortPuzzles(list, "most-liked").map((p) => p.id)).toEqual([
      "p2", // +4
      "p1", // +1
      "p3", // -3
    ]);
  });

  it("breaks ties by puzzle number, including the all-zero case", () => {
    const list = [puzzle(3, 0, 0), puzzle(1, 0, 0), puzzle(2, 2, 2)];
    expect(sortPuzzles(list, "most-liked").map((p) => p.id)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
  });

  it("never mutates the array it was given", () => {
    // It is cached query data; sorting in place would reorder what other
    // components read.
    const list = [puzzle(2, 0, 0), puzzle(1, 9, 0)];
    const before = list.map((p) => p.id);
    sortPuzzles(list, "most-liked");
    expect(list.map((p) => p.id)).toEqual(before);
  });

  it("scores a puzzle as likes minus dislikes", () => {
    expect(voteScore({ likes: 4, dislikes: 6 })).toBe(-2);
  });
});
