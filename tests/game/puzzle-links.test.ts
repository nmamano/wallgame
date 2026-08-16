import { describe, expect, it } from "bun:test";
import {
  savedPuzzleSlug,
  savedPuzzleNumber,
  puzzlePath,
  puzzleShareUrl,
  resolveSavedPuzzle,
  type PuzzleKind,
} from "../../shared/domain/puzzle-links";
import { getLevelIds } from "../../shared/domain/solo-campaign-levels";

/**
 * Share links for a puzzle, and for a campaign level.
 *
 * There used to be THREE kinds. Generated puzzles lived at
 * /puzzles/generated/$id specifically to stay clear of /puzzles/$id, which
 * resolved ids against the handcrafted set — two id namespaces that were only
 * accidentally disjoint. Moving every puzzle into one table removed the reason
 * for the extra segment: the listing still shows handcrafted and generated
 * apart, but the numbering runs once across both, so one namespace and one
 * address serve them. The old route is deleted outright, not redirected — no
 * link under it had been shared yet.
 *
 * The campaign keeps its own path, and that separation is load-bearing: level
 * ids and puzzle numbers are both small integers and genuinely overlap.
 */

const ORIGIN = "https://wallgame.io";

describe("puzzle share links", () => {
  it("gives each kind its own path shape", () => {
    expect(puzzlePath("saved", "3")).toBe("/puzzles/3");
    expect(puzzlePath("campaign", "2")).toBe("/solo-campaign/2");
  });

  it("keeps campaign links clear of puzzle links", () => {
    // "1" is both a level id and a puzzle number, so these two kinds rely on
    // separate paths rather than on distinct ids.
    const puzzleLinks = new Set(
      ["1", "2", "3"].map((id) => puzzlePath("saved", id)),
    );
    for (const levelId of getLevelIds()) {
      expect(puzzleLinks.has(puzzlePath("campaign", levelId))).toBe(false);
    }
  });

  it("builds an absolute link on the given origin", () => {
    expect(puzzleShareUrl("saved", "3", ORIGIN)).toBe(
      "https://wallgame.io/puzzles/3",
    );
  });

  it("does not double the slash when the origin carries one", () => {
    expect(puzzleShareUrl("saved", "abc", "https://wallgame.io/")).toBe(
      "https://wallgame.io/puzzles/abc",
    );
  });

  it("produces a distinct link for every level", () => {
    const links = getLevelIds().map((id) =>
      puzzleShareUrl("campaign", id, ORIGIN),
    );
    expect(new Set(links).size).toBe(links.length);
  });

  describe("puzzle links carry the puzzle number", () => {
    const listing = [
      { id: "uN9TKDUp0T", displayName: "Puzzle 1" },
      { id: "thfcTeXikd", displayName: "Puzzle 2" },
      { id: "mPJ-d8r2yM", displayName: "Puzzle 7" },
    ];

    it("builds a link on the number a player can actually read", () => {
      expect(savedPuzzleSlug(listing[2])).toBe("7");
      expect(puzzleShareUrl("saved", savedPuzzleSlug(listing[2]), ORIGIN)).toBe(
        "https://wallgame.io/puzzles/7",
      );
    });

    it("resolves a numeric link back to that puzzle", () => {
      expect(resolveSavedPuzzle(listing, "7")?.id).toBe("mPJ-d8r2yM");
      expect(resolveSavedPuzzle(listing, "1")?.id).toBe("uN9TKDUp0T");
    });

    it("still resolves an id link, so links minted earlier keep working", () => {
      // The share links handed out before numbers existed are row ids.
      expect(resolveSavedPuzzle(listing, "mPJ-d8r2yM")?.displayName).toBe(
        "Puzzle 7",
      );
    });

    it("resolves by NAME order, not array order", () => {
      // The listing re-sorts by likes, so position is not the number. Sorting
      // the array must not change what a link points at.
      const reordered = [listing[2], listing[0], listing[1]];
      expect(resolveSavedPuzzle(reordered, "7")?.id).toBe("mPJ-d8r2yM");
      expect(resolveSavedPuzzle(reordered, "1")?.id).toBe("uN9TKDUp0T");
    });

    it("answers nothing for a number no puzzle has", () => {
      // A retired tail number must miss rather than fall through to a neighbour.
      expect(resolveSavedPuzzle(listing, "99")).toBeUndefined();
      expect(resolveSavedPuzzle(listing, "unknown-id")).toBeUndefined();
    });

    it("documents that a number is NOT stable across a retirement", () => {
      // Nil accepted this on 2026-08-02. Retiring a puzzle renumbers the
      // survivors, so the same link resolves to a different puzzle afterwards.
      // Pinned so nobody later "fixes" numbering while believing links are safe.
      const afterRetiringPuzzle1 = [
        { id: "thfcTeXikd", displayName: "Puzzle 1" },
        { id: "mPJ-d8r2yM", displayName: "Puzzle 6" },
      ];
      expect(resolveSavedPuzzle(listing, "1")?.id).toBe("uN9TKDUp0T");
      expect(resolveSavedPuzzle(afterRetiringPuzzle1, "1")?.id).toBe(
        "thfcTeXikd",
      );
    });

    it("falls back to the row id when a name carries no number", () => {
      const odd = [{ id: "abc123", displayName: "Special Puzzle" }];
      expect(savedPuzzleNumber(odd[0].displayName)).toBeNull();
      expect(savedPuzzleSlug(odd[0])).toBe("abc123");
      expect(resolveSavedPuzzle(odd, "abc123")?.id).toBe("abc123");
    });

    it("does not confuse an authored puzzle with a generated one by number", () => {
      // The whole point of one numbering sequence: after the migration a
      // number names exactly one puzzle, whoever wrote it. Two rows sharing a
      // number would make a share link ambiguous, and this is the shape that
      // would catch it.
      const mixed = [
        { id: "hand-1", displayName: "Puzzle 1" },
        { id: "gen-11", displayName: "Puzzle 11" },
      ];
      expect(resolveSavedPuzzle(mixed, "1")?.id).toBe("hand-1");
      expect(resolveSavedPuzzle(mixed, "11")?.id).toBe("gen-11");
      expect(new Set(mixed.map(savedPuzzleSlug)).size).toBe(mixed.length);
    });
  });

  it("covers every kind the type allows", () => {
    // A new kind added to PuzzleKind without a path here would fall through
    // the switch and return undefined; this fails loudly if that happens.
    const kinds: PuzzleKind[] = ["saved", "campaign"];
    for (const kind of kinds) {
      expect(puzzlePath(kind, "x")).toStartWith("/");
    }
  });
});
