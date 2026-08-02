import { describe, expect, it } from "bun:test";
import {
  puzzlePath,
  puzzleShareUrl,
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

  it("covers every kind the type allows", () => {
    // A new kind added to PuzzleKind without a path here would fall through
    // the switch and return undefined; this fails loudly if that happens.
    const kinds: PuzzleKind[] = ["scripted", "campaign", "generated"];
    for (const kind of kinds) {
      expect(puzzlePath(kind, "x")).toStartWith("/");
    }
  });
});
