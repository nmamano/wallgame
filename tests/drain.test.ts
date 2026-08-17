import { describe, expect, it } from "bun:test";
import {
  DRAIN_TTL_MS,
  NEW_GAMES_PAUSED_MESSAGE,
  NewGamesPausedError,
  drainStateFrom,
} from "../server/games/drain";

/**
 * The drain's expiry rule, with no filesystem in the way.
 *
 * The rule is the whole safety story of the feature: the drain is a DEADMAN
 * SWITCH, so a drain nobody re-touches has to lapse on its own. A drain that
 * outlived its sentinel would refuse every new game on the site until a person
 * noticed, which is a worse outage than the one the drain prevents.
 */
describe("drainStateFrom", () => {
  const touchedAt = 1_700_000_000_000;

  it("is off when no sentinel exists", () => {
    expect(drainStateFrom(null, touchedAt)).toEqual({
      draining: false,
      expiresAtMs: null,
    });
  });

  it("is on from the touch until the TTL lapses", () => {
    expect(drainStateFrom(touchedAt, touchedAt)).toEqual({
      draining: true,
      expiresAtMs: touchedAt + DRAIN_TTL_MS,
    });
    expect(
      drainStateFrom(touchedAt, touchedAt + DRAIN_TTL_MS - 1).draining,
    ).toBe(true);
  });

  it("is off at the expiry instant, not a millisecond after it", () => {
    // The boundary belongs to "off": a drain that is still on at its own
    // expiry has no last moment, and a poll reading exactly that timestamp
    // would report a drain that is already over.
    expect(drainStateFrom(touchedAt, touchedAt + DRAIN_TTL_MS)).toEqual({
      draining: false,
      expiresAtMs: null,
    });
    expect(
      drainStateFrom(touchedAt, touchedAt + DRAIN_TTL_MS + 60_000).draining,
    ).toBe(false);
  });

  it("re-touching moves the expiry, which is how a long wait is held", () => {
    const reTouchedAt = touchedAt + 15 * 60 * 1000;
    const state = drainStateFrom(reTouchedAt, touchedAt + 19 * 60 * 1000);
    expect(state.draining).toBe(true);
    expect(state.expiresAtMs).toBe(reTouchedAt + DRAIN_TTL_MS);
    // Twenty minutes after the FIRST touch the drain is still on, because the
    // clock runs from the last one. Real waits run longer than the TTL.
    expect(state.expiresAtMs).toBeGreaterThan(touchedAt + DRAIN_TTL_MS);
  });
});

describe("what a player is told", () => {
  /**
   * Nil's standing copy rule: user-facing text must not expose internal
   * mechanics. This is the one sentence a player sees from the whole feature,
   * so the rule is asserted rather than remembered.
   */
  it("names no deploy, restart or maintenance", () => {
    const forbidden = [
      "deploy",
      "restart",
      "maintenance",
      "server",
      "drain",
      "downtime",
    ];
    const lower = NEW_GAMES_PAUSED_MESSAGE.toLowerCase();
    expect(forbidden.filter((word) => lower.includes(word))).toEqual([]);
  });

  it("says their current game is safe, so nobody abandons one", () => {
    expect(NEW_GAMES_PAUSED_MESSAGE).toContain("in progress");
  });

  it("is what the error carries, so no surface writes its own wording", () => {
    expect(new NewGamesPausedError().message).toBe(NEW_GAMES_PAUSED_MESSAGE);
  });
});
