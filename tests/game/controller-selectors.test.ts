import { describe, expect, it } from "bun:test";
import {
  canActNow,
  isViewingHistory,
  shouldQueueAsPremove,
  type ControllerSelectorState,
} from "../../frontend/src/game/controller-selectors";

const baseState: ControllerSelectorState = {
  historyCursor: null,
  isReadOnlySession: false,
  controllerAllowsInteraction: true,
  gameStatus: "playing",
  gameTurn: 1,
  actionablePlayerId: 1,
  activeLocalPlayerId: 1,
};

describe("isViewingHistory", () => {
  it("returns true when cursor is set", () => {
    expect(isViewingHistory({ historyCursor: 0 })).toBe(true);
  });

  it("returns false when cursor is null", () => {
    expect(isViewingHistory({ historyCursor: null })).toBe(false);
  });
});

describe("canActNow", () => {
  it("returns true when all gates are satisfied", () => {
    expect(canActNow(baseState)).toBe(true);
  });

  it("returns false when turn does not match", () => {
    expect(
      canActNow({
        ...baseState,
        gameTurn: 2,
      }),
    ).toBe(false);
  });

  it("returns false when viewing history", () => {
    expect(
      canActNow({
        ...baseState,
        historyCursor: 3,
      }),
    ).toBe(false);
  });

  it("returns false when controller is read-only", () => {
    expect(
      canActNow({
        ...baseState,
        isReadOnlySession: true,
      }),
    ).toBe(false);
  });
});

describe("shouldQueueAsPremove", () => {
  it("returns true when the seat can interact but not act now", () => {
    expect(
      shouldQueueAsPremove({
        ...baseState,
        gameTurn: 2,
        activeLocalPlayerId: 2,
        actionablePlayerId: 2,
      }),
    ).toBe(true);
  });

  it("returns false when interaction is disabled", () => {
    expect(
      shouldQueueAsPremove({
        ...baseState,
        controllerAllowsInteraction: false,
      }),
    ).toBe(false);
  });

  it("returns false when viewing history", () => {
    expect(
      shouldQueueAsPremove({
        ...baseState,
        historyCursor: 1,
      }),
    ).toBe(false);
  });
});
