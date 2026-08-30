import { describe, expect, it } from "bun:test";
import {
  PLAYER_COLORS,
  resolvePlayerColor,
  resolvePlayerColorPair,
} from "./player-colors";

describe("player color normalization", () => {
  it.each([undefined, null, "", "default", "unknown"])(
    "maps %p to red",
    (value) => {
      expect(resolvePlayerColor(value)).toBe("red");
    },
  );

  it("preserves a valid color", () => {
    expect(resolvePlayerColor("green")).toBe("green");
  });
});

describe("seat-based game display colors", () => {
  it("preserves every non-collision pair", () => {
    for (const player1 of PLAYER_COLORS) {
      for (const player2 of PLAYER_COLORS) {
        if (player1 === player2) continue;
        expect(resolvePlayerColorPair(player1, player2)).toEqual({
          1: player1,
          2: player2,
        });
      }
    }
  });

  it("local Animal Cycle keeps seat 1 blue and makes colliding seat 2 red", () => {
    expect(resolvePlayerColorPair("blue", "blue")).toEqual({
      1: "blue",
      2: "red",
    });
  });

  it("stored online colors keep seat 1 green and make colliding seat 2 blue", () => {
    expect(resolvePlayerColorPair("green", "green")).toEqual({
      1: "green",
      2: "blue",
    });
  });

  it("keeps the both-default display pair red/blue", () => {
    expect(resolvePlayerColorPair("default", "default")).toEqual({
      1: "red",
      2: "blue",
    });
  });

  it.each([
    [undefined, null],
    ["", "default"],
    ["unknown", "not-a-color"],
  ])("resolves invalid/default pair %p/%p to red/blue", (player1, player2) => {
    expect(resolvePlayerColorPair(player1, player2)).toEqual({
      1: "red",
      2: "blue",
    });
  });

  it("is seat-based: a local human at seat 2 yields to blue against default-red seat 1", () => {
    expect(resolvePlayerColorPair("default", "red")).toEqual({
      1: "red",
      2: "blue",
    });
  });
});
