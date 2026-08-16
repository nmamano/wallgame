import { describe, it, expect } from "bun:test";
import {
  historyKeyDirection,
  type HistoryKeyContext,
} from "./use-history-keyboard";

const context = (over: Partial<HistoryKeyContext> = {}): HistoryKeyContext => ({
  gameStatus: "finished",
  historyCursor: null,
  targetIsTextEntry: false,
  hasModifier: false,
  ...over,
});

describe("historyKeyDirection", () => {
  it("steps through a finished game", () => {
    expect(historyKeyDirection("ArrowLeft", context())).toBe("back");
    expect(historyKeyDirection("ArrowRight", context())).toBe("forward");
  });

  it("stays inert during a live game", () => {
    const live = context({ gameStatus: "playing" });
    expect(historyKeyDirection("ArrowLeft", live)).toBeNull();
    expect(historyKeyDirection("ArrowRight", live)).toBeNull();
  });

  /**
   * The one exception, and the reason the rule is not simply "not playing":
   * a player who clicked a past move in a live game is reading the history,
   * so the arrows follow them - including the step that returns them to the
   * live position.
   */
  it("follows a player who already opened the history of a live game", () => {
    const browsing = context({ gameStatus: "playing", historyCursor: 3 });
    expect(historyKeyDirection("ArrowLeft", browsing)).toBe("back");
    expect(historyKeyDirection("ArrowRight", browsing)).toBe("forward");
  });

  it("leaves typing alone", () => {
    expect(
      historyKeyDirection("ArrowLeft", context({ targetIsTextEntry: true })),
    ).toBeNull();
  });

  it("leaves browser and OS shortcuts alone", () => {
    expect(
      historyKeyDirection("ArrowLeft", context({ hasModifier: true })),
    ).toBeNull();
  });

  it("ignores every other key", () => {
    for (const key of ["ArrowUp", "ArrowDown", "a", "Enter", " ", "Home"]) {
      expect(historyKeyDirection(key, context())).toBeNull();
    }
  });

  it("works before the first state arrives and on a replay", () => {
    expect(
      historyKeyDirection("ArrowLeft", context({ gameStatus: null })),
    ).toBe("back");
  });
});
