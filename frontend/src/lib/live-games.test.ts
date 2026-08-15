import { describe, expect, it } from "bun:test";
import { formatTimeSince } from "./live-games";

describe("formatTimeSince", () => {
  const now = Date.UTC(2026, 7, 15, 12);

  it("shows recent activity without rounding up", () => {
    expect(formatTimeSince(now - 59_000, now)).toBe("just now");
    expect(formatTimeSince(now - 60_000, now)).toBe("1m ago");
    expect(formatTimeSince(now - 59 * 60_000, now)).toBe("59m ago");
  });

  it("uses compact hour and day labels", () => {
    expect(formatTimeSince(now - 2 * 60 * 60_000, now)).toBe("2h ago");
    expect(formatTimeSince(now - 3 * 24 * 60 * 60_000, now)).toBe("3d ago");
  });

  it("treats a future timestamp as current", () => {
    expect(formatTimeSince(now + 10_000, now)).toBe("just now");
  });
});
