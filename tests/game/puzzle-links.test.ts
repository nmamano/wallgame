import { describe, expect, it } from "bun:test";
import {
  generatedPuzzleSlug,
  puzzlePath,
  puzzleShareUrl,
  resolveGeneratedPuzzle,
  type PuzzleKind,
} from "../../frontend/src/lib/puzzle-links";
import { getPuzzleIds } from "../../shared/domain/puzzles";
import { getLevelIds } from "../../shared/domain/solo-campaign-levels";

/**
 * Share links for the three kinds of puzzle.
 *
 * The interesting one is `generated`. Those puzzles had no address at all —
 * they were launched straight into a bot game, so the only link a player could
 * produce pointed at one playthrough, which a friend could watch but not play.
 * They now live under `/puzzles/generated/$id`, deliberately NOT at
 * `/puzzles/$id` alongside the scripted set: that route resolves ids against
 * the scripted `PUZZLES` map and sends anything it does not recognise back to
 * the listing, so a generated link parked there would depend on two id
 * namespaces never colliding. They are nanoids and "1".."10" today, which is
 * an accident rather than a guarantee.
 */

const ORIGIN = "https://wallgame.io";

describe("puzzle share links", () => {
  it("gives each kind its own path shape", () => {
    expect(puzzlePath("scripted", "3")).toBe("/puzzles/3");
    expect(puzzlePath("campaign", "2")).toBe("/solo-campaign/2");
    expect(puzzlePath("generated", "uN9TKDUp0T")).toBe(
      "/puzzles/generated/uN9TKDUp0T",
    );
  });

  it("keeps generated links clear of the scripted route", () => {
    // The collision this URL shape exists to prevent: were generated puzzles
    // served from /puzzles/$id, a generated id equal to a scripted one would
    // resolve to the scripted puzzle, silently.
    const scriptedIds = new Set(
      getPuzzleIds().map((id) => puzzlePath("scripted", id)),
    );
    for (const id of [...getPuzzleIds(), "uN9TKDUp0T", "abc123"]) {
      expect(scriptedIds.has(puzzlePath("generated", id))).toBe(false);
    }
  });

  it("keeps campaign links clear of the scripted route", () => {
    // Level ids and scripted puzzle ids are both small integers and DO overlap
    // ("1" is both), so these two kinds genuinely rely on separate paths.
    const scriptedIds = new Set(
      getPuzzleIds().map((id) => puzzlePath("scripted", id)),
    );
    for (const levelId of getLevelIds()) {
      expect(scriptedIds.has(puzzlePath("campaign", levelId))).toBe(false);
    }
  });

  it("builds an absolute link on the given origin", () => {
    expect(puzzleShareUrl("scripted", "3", ORIGIN)).toBe(
      "https://wallgame.io/puzzles/3",
    );
  });

  it("does not double the slash when the origin carries one", () => {
    expect(puzzleShareUrl("generated", "abc", "https://wallgame.io/")).toBe(
      "https://wallgame.io/puzzles/generated/abc",
    );
  });

  it("produces a distinct link for every shipped puzzle and level", () => {
    // Nothing may share a link with anything else, across all three kinds.
    const links: string[] = [
      ...getPuzzleIds().map((id) => puzzleShareUrl("scripted", id, ORIGIN)),
      ...getLevelIds().map((id) => puzzleShareUrl("campaign", id, ORIGIN)),
    ];
    expect(new Set(links).size).toBe(links.length);
  });

  describe("generated links carry the puzzle number", () => {
    const listing = [
      { id: "uN9TKDUp0T", displayName: "Puzzle 1" },
      { id: "thfcTeXikd", displayName: "Puzzle 2" },
      { id: "mPJ-d8r2yM", displayName: "Puzzle 7" },
    ];

    it("builds a link on the number a player can actually read", () => {
      expect(generatedPuzzleSlug(listing[2])).toBe("7");
      expect(
        puzzleShareUrl("generated", generatedPuzzleSlug(listing[2]), ORIGIN),
      ).toBe("https://wallgame.io/puzzles/generated/7");
    });

    it("resolves a numeric link back to that puzzle", () => {
      expect(resolveGeneratedPuzzle(listing, "7")?.id).toBe("mPJ-d8r2yM");
      expect(resolveGeneratedPuzzle(listing, "1")?.id).toBe("uN9TKDUp0T");
    });

    it("still resolves an id link, so links minted earlier keep working", () => {
      // The share links handed out before numbers existed are row ids.
      expect(resolveGeneratedPuzzle(listing, "mPJ-d8r2yM")?.displayName).toBe(
        "Puzzle 7",
      );
    });

    it("resolves by NAME order, not array order", () => {
      // The listing re-sorts by likes, so position is not the number. Sorting
      // the array must not change what a link points at.
      const reordered = [listing[2], listing[0], listing[1]];
      expect(resolveGeneratedPuzzle(reordered, "7")?.id).toBe("mPJ-d8r2yM");
      expect(resolveGeneratedPuzzle(reordered, "1")?.id).toBe("uN9TKDUp0T");
    });

    it("answers nothing for a number no puzzle has", () => {
      // A retired tail number must miss rather than fall through to a neighbour.
      expect(resolveGeneratedPuzzle(listing, "99")).toBeUndefined();
      expect(resolveGeneratedPuzzle(listing, "unknown-id")).toBeUndefined();
    });

    it("documents that a number is NOT stable across a retirement", () => {
      // Nil accepted this on 2026-08-02. Retiring a puzzle renumbers the
      // survivors, so the same link resolves to a different puzzle afterwards.
      // Pinned so nobody later "fixes" numbering while believing links are safe.
      const afterRetiringPuzzle1 = [
        { id: "thfcTeXikd", displayName: "Puzzle 1" },
        { id: "mPJ-d8r2yM", displayName: "Puzzle 6" },
      ];
      expect(resolveGeneratedPuzzle(listing, "1")?.id).toBe("uN9TKDUp0T");
      expect(resolveGeneratedPuzzle(afterRetiringPuzzle1, "1")?.id).toBe(
        "thfcTeXikd",
      );
    });

    it("falls back to the row id when a name carries no number", () => {
      const odd = [{ id: "abc123", displayName: "Special Puzzle" }];
      expect(generatedPuzzleSlug(odd[0])).toBe("abc123");
      expect(resolveGeneratedPuzzle(odd, "abc123")?.id).toBe("abc123");
    });
  });

  it("covers every kind the type allows", () => {
    // A new kind added to PuzzleKind without a path here would fall through
    // the switch and return undefined; this fails loudly if that happens.
    const kinds: PuzzleKind[] = ["scripted", "campaign", "generated"];
    for (const kind of kinds) {
      expect(puzzlePath(kind, "x")).toStartWith("/");
    }
  });
});
