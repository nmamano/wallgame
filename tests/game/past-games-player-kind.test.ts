import { describe, expect, it } from "bun:test";
import { classifyPastGamePlayer } from "../../server/db/past-game-player-kind";

describe("classifyPastGamePlayer", () => {
  it("classifies current and historical bot storage before account identity", () => {
    expect(classifyPastGamePlayer("bot", 42)).toBe("bot");
    expect(classifyPastGamePlayer("custom bot", 42)).toBe("bot");
  });

  it("distinguishes members from guests", () => {
    expect(classifyPastGamePlayer("matched user", 42)).toBe("member");
    expect(classifyPastGamePlayer("friend", null)).toBe("guest");
  });
});
