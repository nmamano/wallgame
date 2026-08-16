import { describe, expect, it } from "bun:test";
import {
  canActNow,
  isViewingHistory,
  shouldQueueAsPremove,
  resolveActiveLocalPlayerId,
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

/**
 * Board 97f9d99c. The premove bug lived in the gap between two ways of
 * answering one question: "gameState.turn" (from the server) and a cached
 * copy that only an inbound websocket message could refresh. These tests are
 * about the copy being gone for online seats, which the canActNow tests above
 * cannot show - they receive activeLocalPlayerId as an input.
 */
describe("resolveActiveLocalPlayerId", () => {
  it("says yes on an online seat when the server says it is that seat's turn", () => {
    expect(
      resolveActiveLocalPlayerId({
        remoteSeatPlayerId: 2,
        gameTurn: 2,
        localActivePlayerId: null,
      }),
    ).toBe(2);
  });

  it("says no on an online seat when it is the opponent's turn", () => {
    expect(
      resolveActiveLocalPlayerId({
        remoteSeatPlayerId: 2,
        gameTurn: 1,
        localActivePlayerId: 2,
      }),
    ).toBeNull();
  });

  /**
   * The regression itself. A cleared cache used to pin the page in premove
   * mode for the rest of the game, because the only thing that could restore
   * it was the opponent moving - which cannot happen while the turn is yours.
   * An online seat must now ignore the cache in BOTH directions.
   */
  it("ignores the local cache on an online seat", () => {
    expect(
      resolveActiveLocalPlayerId({
        remoteSeatPlayerId: 1,
        gameTurn: 1,
        localActivePlayerId: null,
      }),
    ).toBe(1);
    expect(
      resolveActiveLocalPlayerId({
        remoteSeatPlayerId: 1,
        gameTurn: 2,
        localActivePlayerId: 1,
      }),
    ).toBeNull();
  });

  it("says no before any game state has arrived", () => {
    expect(
      resolveActiveLocalPlayerId({
        remoteSeatPlayerId: 1,
        gameTurn: null,
        localActivePlayerId: 1,
      }),
    ).toBeNull();
  });

  it("keeps the cache for local play, where the page owns whose turn it is", () => {
    expect(
      resolveActiveLocalPlayerId({
        remoteSeatPlayerId: null,
        gameTurn: 1,
        localActivePlayerId: 2,
      }),
    ).toBe(2);
    expect(
      resolveActiveLocalPlayerId({
        remoteSeatPlayerId: null,
        gameTurn: 1,
        localActivePlayerId: null,
      }),
    ).toBeNull();
  });

  /**
   * The whole point, stated end to end: with the socket down and the cache
   * cleared, an online seat on its own turn can still act.
   */
  it("still lets an online seat act on its own turn after the cache is cleared", () => {
    const derived = resolveActiveLocalPlayerId({
      remoteSeatPlayerId: 1,
      gameTurn: 1,
      localActivePlayerId: null,
    });
    expect(
      canActNow({
        ...baseState,
        gameTurn: 1,
        actionablePlayerId: derived ?? 1,
        activeLocalPlayerId: derived,
      }),
    ).toBe(true);
  });
});
