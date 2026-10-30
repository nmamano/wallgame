import { describe, expect, it } from "bun:test";
import { formatClock, isLowOnTime } from "./clock-display";

describe("formatClock", () => {
  it("prints m:ss, and a dash for a clock that was never recorded", () => {
    expect(formatClock(150)).toBe("2:30");
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(-3)).toBe("0:00");
    expect(formatClock(null)).toBe("—");
  });
});

describe("isLowOnTime", () => {
  const low = { timeLeft: 12, isUnlimited: false };
  it("flags low time only while the clock is live", () => {
    expect(isLowOnTime({ ...low, clockLive: true })).toBe(true);
    expect(isLowOnTime({ ...low, clockLive: false })).toBe(false);
  });
  it("never flags enough time, an unlimited clock or an unrecorded one", () => {
    expect(
      isLowOnTime({ timeLeft: 45, isUnlimited: false, clockLive: true }),
    ).toBe(false);
    expect(isLowOnTime({ ...low, isUnlimited: true, clockLive: true })).toBe(
      false,
    );
    expect(
      isLowOnTime({ timeLeft: null, isUnlimited: false, clockLive: true }),
    ).toBe(false);
  });
});
