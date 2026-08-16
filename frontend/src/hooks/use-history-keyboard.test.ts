import { describe, it, expect } from "bun:test";
import {
  historyKeyDirection,
  type HistoryKeyContext,
} from "./use-history-keyboard";

const context = (over: Partial<HistoryKeyContext> = {}): HistoryKeyContext => ({
  gameStatus: "finished",
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
   * No exception for a player already browsing a live game's history.
   * Reviewer 2 rejected that on 2026-08-16 as a widening of a board task that
   * says exactly "only when game is not active"; the earlier version of this
   * file asserted the opposite.
   */
  it("stays inert during a live game even while the history is open", () => {
    const live = context({ gameStatus: "playing" });
    expect(historyKeyDirection("ArrowLeft", live)).toBeNull();
    expect(historyKeyDirection("ArrowRight", live)).toBeNull();
  });

  it("steps through an aborted game as well as a finished one", () => {
    expect(
      historyKeyDirection("ArrowLeft", context({ gameStatus: "aborted" })),
    ).toBe("back");
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

  /**
   * Before the first state arrives the page has not established that the game
   * is over, so it must not claim the keys on a guess.
   */
  it("stays inert until the status is known", () => {
    expect(
      historyKeyDirection("ArrowLeft", context({ gameStatus: null })),
    ).toBeNull();
  });
});
