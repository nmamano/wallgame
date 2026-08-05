/**
 * "Do players come back?" - the query, against a real Postgres.
 *
 * Every case here exists because getting it wrong produces a plausible number
 * rather than an error, which is the dangerous kind of bug for a metric. The
 * two that matter most:
 *
 *   - two games in ONE SITTING must not read as a return. Most games on this
 *     site come from rematch sittings minutes apart, so a definition measured
 *     in elapsed hours instead of calendar days would report a retention rate
 *     several times too high and nobody would be able to tell from the number.
 *   - a cohort too young to have had the chance must be ABSENT from the
 *     denominator, not counted as having failed to return.
 *
 * The clock is a parameter, so these are fixed dates rather than offsets from
 * today, and the report says the same thing whenever it is run.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import {
  setupEphemeralDb,
  teardownEphemeralDb,
  type TestDbHandle,
} from "../setup-db";
import { retentionReport } from "../../server/db/retention-queries";

/** Every maturity question in these tests is asked as of this instant. */
const NOW = new Date("2026-07-15T12:00:00.000Z");

let handle: TestDbHandle;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<Record<string, never>>;

/** A uuid per browser, since `anonymous_id` is a native uuid column. */
const BROWSER = {
  sitting: "11111111-1111-4111-8111-111111111111",
  nextDay: "22222222-2222-4222-8222-222222222222",
  sixDaysLater: "33333333-3333-4333-8333-333333333333",
  nineDaysLater: "44444444-4444-4444-8444-444444444444",
  puzzleOnly: "55555555-5555-4555-8555-555555555555",
  immatureBusy: "66666666-6666-4666-8666-666666666666",
  immatureQuiet: "77777777-7777-4777-8777-777777777777",
  d1MatureOnly: "88888888-8888-4888-8888-888888888888",
} as const;

let nextGameId = 0;

/**
 * One counted game, played on `day` by the given browsers.
 *
 * A NULL browser is a seat with no anonymous id - a bot, or any row written
 * before that column shipped, which is what all of production looks like
 * today.
 */
async function seedGame(
  day: string,
  browsers: (string | null)[],
  options: { puzzleId?: string } = {},
) {
  const gameId = `g${++nextGameId}`;
  await db.execute(sql`
    INSERT INTO games (
      game_id, variant, time_control, rated, match_type,
      board_width, board_height, started_at, puzzle_id
    ) VALUES (
      ${gameId}, 'standard', 'rapid', false, 'friend',
      8, 8, ${`${day}T12:00:00.000Z`}::timestamptz, ${options.puzzleId ?? null}
    )
  `);
  for (const [index, browser] of browsers.entries()) {
    await db.execute(sql`
      INSERT INTO game_players (
        game_id, player_order, player_role, player_config_type,
        display_name, anonymous_id, outcome_rank, outcome_reason
      ) VALUES (
        ${gameId}, ${index + 1}, ${index === 0 ? "host" : "joiner"}, 'you',
        'Guest', ${browser}::uuid, ${index + 1}, 'resignation'
      )
    `);
  }
}

beforeAll(async () => {
  handle = await setupEphemeralDb();
  client = postgres(handle.connectionUrl);
  db = drizzle(client);

  // A puzzle to hang the excluded game off, since games.puzzle_id is a real
  // foreign key.
  await db.execute(sql`
    INSERT INTO saved_puzzles (id, display_name, sort_index, config)
    VALUES ('puz1', 'Test puzzle', 1, '{}'::jsonb)
  `);

  // --- the 2026-07-01 cohort: old enough for every question ---------------
  // Plays twice on its first day and never again. Two games in one sitting is
  // the shape most games on this site have, and it is not a return.
  await seedGame("2026-07-01", [BROWSER.sitting, null]);
  await seedGame("2026-07-01", [BROWSER.sitting, null]);
  // Came back the next day.
  await seedGame("2026-07-01", [BROWSER.nextDay, null]);
  await seedGame("2026-07-02", [BROWSER.nextDay, null]);
  // Came back inside the week, but not the next day.
  await seedGame("2026-07-01", [BROWSER.sixDaysLater, null]);
  await seedGame("2026-07-07", [BROWSER.sixDaysLater, null]);
  // Came back, but too late to count for either window.
  await seedGame("2026-07-01", [BROWSER.nineDaysLater, null]);
  await seedGame("2026-07-10", [BROWSER.nineDaysLater, null]);
  // A puzzle the next day by a player of the same cohort: different funnel,
  // so it must not rescue anyone's retention.
  await seedGame("2026-07-02", [BROWSER.sitting, null], { puzzleId: "puz1" });

  // --- puzzles only: never a player at all --------------------------------
  await seedGame("2026-07-01", [BROWSER.puzzleOnly, null], {
    puzzleId: "puz1",
  });

  // --- a cohort mature for the next-day question but not the week ---------
  await seedGame("2026-07-10", [BROWSER.d1MatureOnly, null]);
  await seedGame("2026-07-11", [BROWSER.d1MatureOnly, null]);

  // --- yesterday's cohort: too young for either question ------------------
  // One busy browser and one quiet one, so a mutation that counted GAMES
  // where it should count PLAYERS would give three where it should give two.
  await seedGame("2026-07-14", [BROWSER.immatureBusy, null]);
  await seedGame("2026-07-14", [BROWSER.immatureBusy, null]);
  await seedGame("2026-07-14", [BROWSER.immatureQuiet, null]);
});

afterAll(async () => {
  await client.end();
  await teardownEphemeralDb(handle.container);
});

describe("retentionReport", () => {
  it("does not count a second game in the same sitting as coming back", async () => {
    const report = await retentionReport(db, NOW);
    const july1 = report.cohorts.find((c) => c.cohortDay === "2026-07-01");

    // Two games, one day, one sitting. Present as a player, absent from both
    // return counts.
    expect(july1?.players).toBe(4);
    expect(july1?.returnedNextDay).toBe(1);
    expect(july1?.returnedWithin7d).toBe(2);
  });

  it("counts lifetime games, not games inside the window", async () => {
    const report = await retentionReport(db, NOW);
    const july1 = report.cohorts.find((c) => c.cohortDay === "2026-07-01");

    // Four browsers, two games each - including the one that came back nine
    // days later, which is outside every window but still played.
    expect(july1?.games).toBe(8);
  });

  it("rates a mature cohort against its own players", async () => {
    const report = await retentionReport(db, NOW);
    const july1 = report.cohorts.find((c) => c.cohortDay === "2026-07-01");

    expect(july1?.nextDayRate).toBeCloseTo(1 / 4);
    expect(july1?.within7dRate).toBeCloseTo(2 / 4);
  });

  it("leaves a cohort too young for a question unrated rather than at zero", async () => {
    const report = await retentionReport(db, NOW);
    const yesterday = report.cohorts.find((c) => c.cohortDay === "2026-07-14");

    // Two browsers, three games. The count is of PLAYERS.
    expect(yesterday?.players).toBe(2);
    expect(yesterday?.games).toBe(3);
    expect(yesterday?.nextDayRate).toBeNull();
    expect(yesterday?.within7dRate).toBeNull();
  });

  it("answers the next-day question for a cohort still too young for the week", async () => {
    const report = await retentionReport(db, NOW);
    const july10 = report.cohorts.find((c) => c.cohortDay === "2026-07-10");

    expect(july10?.nextDayRate).toBeCloseTo(1);
    expect(july10?.within7dRate).toBeNull();
  });

  it("pools each rate over its own eligible players", async () => {
    const report = await retentionReport(db, NOW);

    // Next-day is answerable for 2026-07-01 (4 players) and 2026-07-10 (1),
    // but not for yesterday's cohort. The week is answerable only for
    // 2026-07-01. Two questions, two denominators.
    expect(report.pooled.d1EligiblePlayers).toBe(5);
    expect(report.pooled.returnedNextDay).toBe(2);
    expect(report.pooled.nextDayRate).toBeCloseTo(2 / 5);

    expect(report.pooled.within7dEligiblePlayers).toBe(4);
    expect(report.pooled.returnedWithin7d).toBe(2);
    expect(report.pooled.within7dRate).toBeCloseTo(2 / 4);
  });

  it("ignores puzzles and seats with no browser id", async () => {
    const report = await retentionReport(db, NOW);

    // The puzzle-only browser is not a player anywhere, and no bot or
    // pre-deploy seat became one either.
    const players = report.cohorts.flatMap((c) => c.players);
    expect(report.pooled.players).toBe(7);
    expect(players.reduce((a, b) => a + b, 0)).toBe(7);
  });

  it("reports the day it was taken, so a stale copy is obvious", async () => {
    const report = await retentionReport(db, NOW);

    expect(report.asOfUtcDay).toBe("2026-07-15");
  });
});
