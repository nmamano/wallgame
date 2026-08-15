import { describe, expect, it } from "bun:test";

import {
  choosePlayback,
  resolveShapeBot,
  isForcedToAuthoredLine,
} from "./use-puzzle-playback";
import type { SavedPuzzle } from "../../../shared/contracts/puzzles";
import type { ListedBot } from "../../../shared/contracts/custom-bot-protocol";

/**
 * Which opponent a puzzle gets, and — the part that actually bites — WHEN that
 * question is allowed to be answered.
 *
 * The failure this guards against is not a wrong answer, it is an early one.
 * Bot discovery is a network round trip, so on a cold cache there is a window
 * where nothing is known yet. Treating that window as "no bot" sends a player
 * into the authored line of a puzzle a bot was about to be found for — and
 * then, when the query lands, the same mounted page decides "bot" after all,
 * mints a game, and navigates away from a board they were already using.
 */

const puzzle = (over: Partial<SavedPuzzle> = {}): SavedPuzzle =>
  ({
    id: "p1",
    displayName: "Puzzle 1",
    sortIndex: 1,
    author: "Nilo",
    difficulty: 1,
    legacyScriptedId: "1",
    botLaunchReady: true,
    likes: 0,
    dislikes: 0,
    myVote: null,
    config: {
      variant: "custom-setup-classic",
      boardWidth: 4,
      boardHeight: 4,
      variantConfig: {
        pawns: {
          p1: { cat: [0, 0], home: [3, 3] },
          p2: { cat: [0, 3], home: [3, 0] },
        },
        walls: [],
        turn: { playerId: 1, actionsTaken: [] },
      },
    },
    ...over,
  }) as SavedPuzzle;

const bot = {
  id: "client:bot",
  isOfficial: true,
  isAnalysisBot: true,
} as ListedBot;

/** A bot that really declares the 4x4 classic shape the fixture puzzle uses. */
const declaringBot = {
  id: "client:puzzlebot",
  isOfficial: true,
  isAnalysisBot: true,
  placement: "puzzle",
  variants: {
    classic: {
      boardWidth: { min: 4, max: 12 },
      boardHeight: { min: 4, max: 10 },
      recommended: [],
    },
  },
} as unknown as ListedBot;

describe("choosePlayback", () => {
  it("waits while discovery is pending, even though a line exists", () => {
    // THE regression. A handcrafted puzzle has an authored line AND a bot that
    // can play it; before the bot query settles the answer must be "wait",
    // never "walk the line".
    expect(choosePlayback(puzzle(), "pending")).toEqual({ kind: "pending" });
  });

  it("waits for a generated puzzle too, rather than calling it unavailable", () => {
    // Saying "unavailable" early would grey out a perfectly playable card for
    // as long as the request takes.
    expect(
      choosePlayback(puzzle({ legacyScriptedId: null }), "pending"),
    ).toEqual({ kind: "pending" });
  });

  it("plays the bot once one is found", () => {
    expect(choosePlayback(puzzle(), bot)).toEqual({ kind: "bot", bot });
  });

  it("falls back to the authored line only once discovery says there is no bot", () => {
    expect(choosePlayback(puzzle(), undefined)).toEqual({
      kind: "scripted",
      scriptedId: "1",
    });
  });

  it("is unavailable when there is neither a bot nor a line", () => {
    expect(
      choosePlayback(puzzle({ legacyScriptedId: null }), undefined),
    ).toEqual({ kind: "unavailable" });
  });

  describe("a row no bot could open", () => {
    // Human-as-P2 with no stored lead-in: there is no legal P1 move to start
    // from, whatever bot is online.
    const p2 = puzzle({ botLaunchReady: false });

    it("does not wait on discovery, because no answer would change it", () => {
      expect(choosePlayback(p2, "pending")).toEqual({
        kind: "scripted",
        scriptedId: "1",
      });
    });

    it("ignores a bot that WAS found", () => {
      expect(choosePlayback(p2, bot)).toEqual({
        kind: "scripted",
        scriptedId: "1",
      });
    });

    it("is unavailable when it has no line either", () => {
      expect(
        choosePlayback(
          puzzle({ botLaunchReady: false, legacyScriptedId: null }),
          bot,
        ),
      ).toEqual({ kind: "unavailable" });
    });
  });
});

describe("resolveShapeBot", () => {
  const config = puzzle().config;

  it("is pending before the first answer", () => {
    expect(resolveShapeBot({ isPending: true, bots: [] }, false, config)).toBe(
      "pending",
    );
  });

  it("returns the declaring official bot once settled", () => {
    expect(
      resolveShapeBot(
        { isPending: false, bots: [declaringBot] },
        false,
        config,
      ),
    ).toBe(declaringBot);
  });

  it("stays PENDING during a deliberate refetch, even with cached data", () => {
    // THE race. A refused launch means the cached bot is known to be wrong,
    // but a refetch keeps the old data and leaves isPending false — so reading
    // the query alone would hand back the very bot that just refused, in time
    // for the launch effect to try it again.
    expect(
      resolveShapeBot({ isPending: false, bots: [declaringBot] }, true, config),
    ).toBe("pending");
  });

  it("gives the settled answer once the refetch finishes", () => {
    expect(
      resolveShapeBot({ isPending: false, bots: [] }, false, config),
    ).toBeUndefined();
  });

  it("ignores a bot that is not the analysis bot, and one that does not declare the shape", () => {
    const unofficial = {
      ...declaringBot,
      isOfficial: false,
      isAnalysisBot: false,
    } as ListedBot;
    // Ours, badged as ours, listed above the analysis bot - and still not
    // allowed to play a puzzle. This is the case the split exists for: Easy
    // Bot became official, and "official" used to be the whole test.
    const officialButWeak = {
      ...declaringBot,
      isOfficial: true,
      isAnalysisBot: false,
    } as ListedBot;
    const wrongSize = {
      ...declaringBot,
      variants: {
        "custom-setup-classic": {
          boardWidth: { min: 6, max: 12 },
          boardHeight: { min: 6, max: 10 },
          recommended: [],
        },
      },
    } as unknown as ListedBot;
    expect(
      resolveShapeBot(
        { isPending: false, bots: [unofficial, officialButWeak, wrongSize] },
        false,
        config,
      ),
    ).toBeUndefined();
  });
});

describe("isForcedToAuthoredLine", () => {
  const puzzleA = puzzle({ id: "A" });
  const puzzleB = puzzle({ id: "B" });

  it("honours the choice made for THIS puzzle", () => {
    expect(isForcedToAuthoredLine(puzzleA, undefined, "A")).toBe(true);
  });

  it("does not leak that choice onto the next puzzle", () => {
    // "Next" changes only the route param, so the component can be reused. A
    // bare boolean would carry the decision across and skip bot discovery for
    // a puzzle a bot is sitting there ready to play.
    expect(isForcedToAuthoredLine(puzzleB, undefined, "A")).toBe(false);
  });

  it("honours an explicit ?play=authored arrival", () => {
    expect(isForcedToAuthoredLine(puzzleA, "authored", null)).toBe(true);
  });

  it("returns to bot-first once the intent is dropped from the URL", () => {
    // Which is why Next navigates with an empty search rather than inheriting.
    expect(isForcedToAuthoredLine(puzzleB, undefined, null)).toBe(false);
  });
});
