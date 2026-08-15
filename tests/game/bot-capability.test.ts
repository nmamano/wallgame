import { describe, expect, it } from "bun:test";

import {
  botSupportsGameConfiguration,
  botSupportsPosition,
} from "../../shared/domain/bot-capability";

/**
 * One rule, asked by the client to decide what a puzzle card offers and by the
 * server again at launch. They must never disagree, which is why it is a
 * function rather than two similar-looking conditionals.
 *
 * The declarations below are PuzzleBot's real ones as of 2026-08-04.
 */
const puzzleBot = {
  standard: {
    boardWidth: { min: 4, max: 12 },
    boardHeight: { min: 4, max: 10 },
  },
  classic: {
    boardWidth: { min: 4, max: 12 },
    boardHeight: { min: 4, max: 10 },
  },
} as const;

const superhumanBot = {
  classic: {
    boardWidth: { min: 5, max: 12 },
    boardHeight: { min: 5, max: 10 },
  },
  standard: {
    boardWidth: { min: 5, max: 12 },
    boardHeight: { min: 5, max: 10 },
  },
} as const;

describe("botSupportsPosition", () => {
  it("accepts a position inside a declared range", () => {
    expect(botSupportsPosition(puzzleBot, "standard", 6, 6)).toBe(true);
    expect(botSupportsPosition(puzzleBot, "classic", 9, 6)).toBe(true);
  });

  it("reads a declared rules variant", () => {
    expect(botSupportsPosition(superhumanBot, "classic", 5, 5)).toBe(true);
  });

  it("refuses a board smaller than the bot will take", () => {
    // The three authored puzzles that are three rows tall.
    expect(botSupportsPosition(puzzleBot, "classic", 7, 3)).toBe(false);
    expect(botSupportsPosition(puzzleBot, "classic", 5, 3)).toBe(false);
  });

  it("checks both dimensions, not just one", () => {
    // A wide-but-short board must fail on height alone.
    expect(botSupportsPosition(puzzleBot, "classic", 12, 3)).toBe(false);
    // And a tall-but-narrow one on width alone.
    expect(botSupportsPosition(puzzleBot, "classic", 3, 10)).toBe(false);
  });

  it("is inclusive at both edges of a range", () => {
    // Off-by-one here would silently drop the 4x4 puzzles, which sit exactly
    // on the floor.
    expect(botSupportsPosition(puzzleBot, "classic", 4, 4)).toBe(true);
    expect(botSupportsPosition(puzzleBot, "classic", 12, 10)).toBe(true);
    expect(botSupportsPosition(puzzleBot, "classic", 13, 10)).toBe(false);
    expect(botSupportsPosition(puzzleBot, "classic", 12, 11)).toBe(false);
  });

  it("treats an omitted dimension as 'do not narrow on it'", () => {
    // The listing endpoint asks which variants a bot serves without naming a
    // board; that must not be read as a board of size undefined.
    expect(botSupportsPosition(puzzleBot, "classic")).toBe(true);
    expect(botSupportsPosition(puzzleBot, "classic", 4)).toBe(true);
    expect(botSupportsPosition(superhumanBot, "classic")).toBe(true);
  });
});

describe("Random Start bot capability", () => {
  const splitBot = {
    standard: {
      boardWidth: { min: 5, max: 12 },
      boardHeight: { min: 5, max: 10 },
    },
  } as const;

  it("uses one Standard rules capability for fixed and Random Start positions", () => {
    expect(
      botSupportsGameConfiguration(splitBot, {
        variant: "standard",
        randomStart: false,
        boardWidth: 5,
        boardHeight: 5,
      }),
    ).toBe(true);
    expect(
      botSupportsGameConfiguration(splitBot, {
        variant: "standard",
        randomStart: true,
        boardWidth: 5,
        boardHeight: 5,
      }),
    ).toBe(true);
    expect(
      botSupportsGameConfiguration(splitBot, {
        variant: "standard",
        randomStart: true,
        boardWidth: 8,
        boardHeight: 8,
      }),
    ).toBe(true);
  });

  it("does not treat Random Start as a separate rules family", () => {
    expect(
      botSupportsGameConfiguration(superhumanBot, {
        variant: "standard",
        randomStart: true,
        boardWidth: 8,
        boardHeight: 8,
      }),
    ).toBe(true);
  });
});
