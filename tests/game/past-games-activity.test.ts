/**
 * The calendar arithmetic behind the Past Games activity plot.
 *
 * Pure functions, no database: the window bounds and the buckets are derived
 * from the same anchor, and this is where that agreement is pinned down. A
 * rolling `now() - 90 days` window would start partway through a 91st calendar
 * day and feed the plot a bucket it has no column for.
 */

import { describe, it, expect } from "bun:test";
import {
  PAST_GAMES_ACTIVITY_DAYS,
  densifyPastGamesActivity,
  pastGamesActivityWindow,
  utcDayKey,
} from "../../shared/domain/past-games";
import { buildActivityAxis } from "../../frontend/src/lib/past-games";

const at = (iso: string) => new Date(iso);

describe("past games activity window", () => {
  it("spans today plus the preceding days, anchored to UTC midnight", () => {
    const { start, endExclusive } = pastGamesActivityWindow(
      at("2026-08-06T13:45:12.345Z"),
    );

    // Aug 7 00:00Z minus 90 days.
    expect(start.toISOString()).toBe("2026-05-09T00:00:00.000Z");
    // Exclusive: the midnight that opens tomorrow, so nothing dated in the
    // future can slip in either.
    expect(endExclusive.toISOString()).toBe("2026-08-07T00:00:00.000Z");
  });

  it("covers exactly PAST_GAMES_ACTIVITY_DAYS days", () => {
    const { start, endExclusive } = pastGamesActivityWindow(
      at("2026-08-06T13:45:12.345Z"),
    );
    const spanDays =
      (endExclusive.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBe(PAST_GAMES_ACTIVITY_DAYS);
  });

  it("gives the same window anywhere inside one UTC day", () => {
    const first = pastGamesActivityWindow(at("2026-08-06T00:00:00.000Z"));
    const last = pastGamesActivityWindow(at("2026-08-06T23:59:59.999Z"));
    expect(first.start.getTime()).toBe(last.start.getTime());
    expect(first.endExclusive.getTime()).toBe(last.endExclusive.getTime());
  });

  it("crosses a month boundary without drifting", () => {
    const { start, endExclusive } = pastGamesActivityWindow(
      at("2026-03-01T09:00:00Z"),
    );
    expect(endExclusive.toISOString()).toBe("2026-03-02T00:00:00.000Z");
    expect(start.toISOString()).toBe("2025-12-02T00:00:00.000Z");
  });
});

describe("densifyPastGamesActivity", () => {
  const anchor = at("2026-08-06T13:45:12.345Z");

  it("returns one ascending entry per day in the window", () => {
    const days = densifyPastGamesActivity(new Map(), anchor);

    expect(days.length).toBe(PAST_GAMES_ACTIVITY_DAYS);
    expect(days[0]?.date).toBe("2026-05-09");
    expect(days[days.length - 1]?.date).toBe("2026-08-06");

    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
    expect(days.map((d) => d.date)).toEqual(sorted.map((d) => d.date));
  });

  it("fills days the database did not return with zero", () => {
    const days = densifyPastGamesActivity(
      new Map([
        ["2026-08-06", 7],
        ["2026-05-09", 3],
      ]),
      anchor,
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
        ["2026-05-08", 99], // one day before the window opens
        ["2026-08-07", 99], // tomorrow
      ]),
      anchor,
    );
    expect(days.every((day) => day.count === 0)).toBe(true);
  });

  it("keys the first bucket on the window start", () => {
    const { start } = pastGamesActivityWindow(anchor);
    const days = densifyPastGamesActivity(new Map(), anchor);
    expect(days[0]?.date).toBe(utcDayKey(start));
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
