/**
 * The calendar arithmetic behind the Past Games activity plot, plus its axis.
 *
 * Pure functions, no database. Two things are pinned down here: the days are
 * the READER'S calendar days rather than Greenwich's - the deployed chart drew
 * a column for a tomorrow that Los Angeles had not reached - and the window is
 * a count of days rather than a span of hours, since a rolling 90x24 hours
 * starts partway through a 91st day and feeds the plot a bucket it cannot draw.
 */

import { describe, it, expect } from "bun:test";
import {
  PAST_GAMES_ACTIVITY_DAYS,
  civilDayIn,
  densifyPastGamesActivity,
  isValidTimeZone,
  pastGamesActivityDays,
  shiftCivilDay,
} from "../../shared/domain/past-games";
import { buildActivityAxis } from "../../frontend/src/lib/past-games";

const LA = "America/Los_Angeles";

describe("civilDayIn", () => {
  it("reports the reader's day, not Greenwich's", () => {
    // 23:30 UTC on Aug 6 is still Aug 6 in Los Angeles...
    expect(civilDayIn(new Date("2026-08-06T23:30:00Z"), LA)).toBe("2026-08-06");
    // ...and 01:30 UTC on Aug 7 is STILL Aug 6 there. This is exactly the bug
    // that was visible on the deployed chart: a column for a day LA had not
    // reached yet.
    expect(civilDayIn(new Date("2026-08-07T01:30:00Z"), LA)).toBe("2026-08-06");
    expect(civilDayIn(new Date("2026-08-07T01:30:00Z"), "UTC")).toBe(
      "2026-08-07",
    );
  });

  it("handles a zone ahead of Greenwich too", () => {
    expect(civilDayIn(new Date("2026-08-06T22:00:00Z"), "Asia/Tokyo")).toBe(
      "2026-08-07",
    );
  });
});

describe("shiftCivilDay", () => {
  it("does plain calendar arithmetic", () => {
    expect(shiftCivilDay("2026-08-06", 1)).toBe("2026-08-07");
    expect(shiftCivilDay("2026-08-06", -1)).toBe("2026-08-05");
  });

  it("crosses month, year and leap-day boundaries", () => {
    expect(shiftCivilDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftCivilDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftCivilDay("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("is unaffected by daylight saving", () => {
    // US DST began 2026-03-08. A shift that went through an instant would land
    // 23 or 25 hours away and could repeat or skip a date.
    expect(shiftCivilDay("2026-03-07", 1)).toBe("2026-03-08");
    expect(shiftCivilDay("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftCivilDay("2026-11-01", 1)).toBe("2026-11-02");
  });
});

describe("pastGamesActivityDays", () => {
  it("ends on the anchor and runs the full length, ascending", () => {
    const days = pastGamesActivityDays("2026-08-06");
    expect(days.length).toBe(PAST_GAMES_ACTIVITY_DAYS);
    expect(days[days.length - 1]).toBe("2026-08-06");
    expect(days[0]).toBe("2026-05-09");
    expect([...days].sort()).toEqual(days);
  });

  it("has no duplicate or missing day across a DST change", () => {
    const days = pastGamesActivityDays("2026-04-30");
    expect(new Set(days).size).toBe(PAST_GAMES_ACTIVITY_DAYS);
    days.forEach((day, i) => {
      if (i > 0) expect(day).toBe(shiftCivilDay(days[i - 1], 1));
    });
  });
});

describe("isValidTimeZone", () => {
  it("accepts real zones and rejects junk", () => {
    expect(isValidTimeZone(LA)).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Europe/Madrid")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("nonsense")).toBe(false);
  });
});

describe("densifyPastGamesActivity", () => {
  it("returns one entry per day in the window", () => {
    const days = densifyPastGamesActivity(new Map(), "2026-08-06");
    expect(days.length).toBe(PAST_GAMES_ACTIVITY_DAYS);
    expect(days[0]?.date).toBe("2026-05-09");
    expect(days[days.length - 1]?.date).toBe("2026-08-06");
  });

  it("fills days the database did not return with zero", () => {
    const days = densifyPastGamesActivity(
      new Map([
        ["2026-08-06", 7],
        ["2026-05-09", 3],
      ]),
      "2026-08-06",
    );
    expect(days[0]).toEqual({ date: "2026-05-09", count: 3 });
    expect(days[days.length - 1]).toEqual({ date: "2026-08-06", count: 7 });
    expect(days.filter((day) => day.count === 0).length).toBe(
      PAST_GAMES_ACTIVITY_DAYS - 2,
    );
  });

  it("ignores counts for days outside the window", () => {
    const days = densifyPastGamesActivity(
      new Map([
        ["2026-05-08", 99],
        ["2026-08-07", 99],
      ]),
      "2026-08-06",
    );
    expect(days.every((day) => day.count === 0)).toBe(true);
  });
});

describe("buildActivityAxis", () => {
  it("keeps an empty range at a real axis rather than scaling nothing up", () => {
    expect(buildActivityAxis(0)).toEqual({ max: 1, ticks: [0, 1] });
  });

  it("lets a low-volume peak fill the plot", () => {
    // The point of the small-peak branch: a busiest day of one game draws at
    // full height, not at a quarter of it.
    expect(buildActivityAxis(1)).toEqual({ max: 1, ticks: [0, 1] });
    expect(buildActivityAxis(2)).toEqual({ max: 2, ticks: [0, 1, 2] });
    expect(buildActivityAxis(4)).toEqual({ max: 4, ticks: [0, 1, 2, 3, 4] });
  });

  it("rounds a large peak up to clean gridlines", () => {
    expect(buildActivityAxis(310)).toEqual({
      max: 400,
      ticks: [0, 100, 200, 300, 400],
    });
  });

  it("never labels a fraction of a game", () => {
    for (let peak = 0; peak <= 400; peak++) {
      const { max, ticks } = buildActivityAxis(peak);
      expect(ticks.every(Number.isInteger)).toBe(true);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBe(max);
    }
  });

  it("never crops the tallest bar", () => {
    for (let peak = 0; peak <= 400; peak++) {
      expect(buildActivityAxis(peak).max).toBeGreaterThanOrEqual(peak);
    }
  });
});
