import { describe, it, expect } from "bun:test";
import {
  BOTS_AWAY_REFETCH_MS,
  refetchWhileBotsAway,
} from "./bots-availability";

/**
 * The maintenance message must clear by itself when the bots come back, with
 * no reload, and the site must not poll the bot list while they are online.
 */
describe("refetchWhileBotsAway", () => {
  it("asks again every 30 s while the official bots are away", () => {
    expect(
      refetchWhileBotsAway({ state: { data: { officialBots: "away" } } }),
    ).toBe(BOTS_AWAY_REFETCH_MS);
  });

  it("does not poll while they are online, or before the first answer", () => {
    expect(
      refetchWhileBotsAway({ state: { data: { officialBots: "online" } } }),
    ).toBe(false);
    expect(refetchWhileBotsAway({ state: {} })).toBe(false);
  });
});
