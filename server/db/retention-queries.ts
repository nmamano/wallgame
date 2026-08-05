/**
 * Do players come back?
 *
 * This is the question the whole measurement effort exists for, and until the
 * anonymous id landed it could not be asked at all: `game_players.user_id` is
 * NULL for the roughly 99% of players who never sign in, so a returning guest
 * was indistinguishable from a new one.
 *
 * WHAT THIS MEASURES, EXACTLY - read this before quoting a number from it:
 *
 * - **Returning BROWSERS, not people.** The identity is the anonymous id in
 *   one browser's storage. One person on a laptop and a phone is two players;
 *   one person who clears their storage becomes a new player; two people
 *   sharing a browser are one. It measures what it can measure.
 * - **Players with COUNTED COMPLETED games.** `server/games/persistence.ts`
 *   writes nothing for a game that was abandoned before both players moved, so
 *   the tables only ever held real finished games. Someone who opened the site,
 *   started a game and wandered off is not in here at all, and the number is
 *   therefore about people who finished something - not about all visitors.
 * - **Match play, not puzzles.** Games with a `puzzle_id` are excluded. Puzzle
 *   solving is real engagement but a different funnel, and mixing the two
 *   changes what "a player came back" means.
 * - **Local hot-seat games are invisible**, because they never reach a server.
 *
 * A return is a game on a LATER CALENDAR DAY (UTC). Calendar days rather than
 * elapsed hours is the load-bearing choice: most games come from rematch
 * sittings a couple of minutes apart, so any "played again within 24 hours"
 * rule would score one sitting as retention and report a number several times
 * too high. Same-day games can never count as a return. UTC because no player
 * timezone is stored anywhere, and it is the only boundary that gives the same
 * answer twice.
 */

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/** A cohort is not asked to have returned before it could have. */
const DAYS_BEFORE_NEXT_DAY_IS_KNOWN = 2;
const DAYS_BEFORE_WITHIN_7_IS_KNOWN = 8;
const RETURN_WINDOW_DAYS = 7;

export interface RetentionCohort {
  /** UTC date of these players' first counted game, `YYYY-MM-DD`. */
  cohortDay: string;
  players: number;
  /** Counted games these players have played, lifetime to date - not capped
   *  to any window, so it keeps growing after the cohort's day. */
  games: number;
  returnedNextDay: number;
  returnedWithin7d: number;
  /**
   * Null when the cohort is too young for the question to have an answer yet.
   * Null rather than zero: a cohort from yesterday has not FAILED to return on
   * day seven, and scoring it zero is how a dashboard reports a collapse every
   * morning.
   */
  nextDayRate: number | null;
  within7dRate: number | null;
}

export interface RetentionReport {
  /** The UTC day the report was taken on; every maturity test is relative to it. */
  asOfUtcDay: string;
  cohorts: RetentionCohort[];
  /**
   * The pooled figures, with a SEPARATE denominator per rate. The two
   * questions have different eligible populations - more cohorts are old
   * enough to answer "did they come back the next day" than "within a week" -
   * so a single `players` total under both counts would be wrong.
   */
  pooled: {
    players: number;
    games: number;
    d1EligiblePlayers: number;
    returnedNextDay: number;
    nextDayRate: number | null;
    within7dEligiblePlayers: number;
    returnedWithin7d: number;
    within7dRate: number | null;
  };
}

interface PlayerRow {
  player: string;
  cohort_day: string;
  games: number;
  returned_next_day: boolean;
  returned_within_7d: boolean;
}

/**
 * One row per player: when they first played, how much they have played, and
 * whether they came back.
 *
 * The per-player facts come from the database and the cohort arithmetic
 * happens in TypeScript, deliberately. The maturity rules are where this kind
 * of report goes wrong, and they are far easier to read - and to test - as
 * code than as another layer of SQL.
 */
const PLAYER_FACTS = sql`
  WITH seats AS (
    SELECT
      gp.anonymous_id AS player,
      g.game_id AS game_id,
      (g.started_at AT TIME ZONE 'UTC')::date AS play_day
    FROM game_players gp
    JOIN games g ON g.game_id = gp.game_id
    WHERE gp.anonymous_id IS NOT NULL
      AND g.puzzle_id IS NULL
  ),
  -- A window rather than a self-join back onto seats, and the reason is not
  -- performance. Joining on s.player = pp.player silently dropped every seat
  -- with no anonymous id, because NULL never equals NULL - so deleting the
  -- IS NOT NULL filter above changed no result and no test could tell. The
  -- exclusion was real and completely untested, resting on an accident of SQL
  -- rather than on the line that claims to do it. Partitioning gives a NULL
  -- player its own partition, which puts the filter back in charge of its own
  -- job and lets a test prove it.
  marked AS (
    SELECT
      player,
      game_id,
      play_day,
      MIN(play_day) OVER (PARTITION BY player) AS cohort_day
    FROM seats
  )
  SELECT
    player::text AS player,
    cohort_day::text AS cohort_day,
    COUNT(DISTINCT game_id)::int AS games,
    BOOL_OR(play_day = cohort_day + 1) AS returned_next_day,
    BOOL_OR(
      play_day > cohort_day
      AND play_day <= cohort_day + ${RETURN_WINDOW_DAYS}::int
    ) AS returned_within_7d
  FROM marked
  GROUP BY player, cohort_day
  ORDER BY cohort_day, player
`;

/** `YYYY-MM-DD` for a UTC instant. */
const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** The UTC day this many days before `at`. */
const utcDayBefore = (at: Date, days: number): string =>
  utcDay(new Date(at.getTime() - days * 24 * 60 * 60 * 1000));

export async function retentionReport(
  db: PostgresJsDatabase<Record<string, never>>,
  /** Taken as a parameter rather than read from the clock, so a test can ask
   *  what the report said on a given day. */
  now: Date,
): Promise<RetentionReport> {
  const rows = (await db.execute(PLAYER_FACTS)) as unknown as PlayerRow[];

  const lastDayD1IsKnownFor = utcDayBefore(now, DAYS_BEFORE_NEXT_DAY_IS_KNOWN);
  const lastDayWithin7IsKnownFor = utcDayBefore(
    now,
    DAYS_BEFORE_WITHIN_7_IS_KNOWN,
  );

  const byDay = new Map<string, PlayerRow[]>();
  for (const row of rows) {
    const day = byDay.get(row.cohort_day);
    if (day) day.push(row);
    else byDay.set(row.cohort_day, [row]);
  }

  const cohorts: RetentionCohort[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohortDay, players]) => {
      // String comparison is the date comparison here: ISO days sort
      // lexicographically, which is the one thing that format is for.
      const d1Known = cohortDay <= lastDayD1IsKnownFor;
      const within7Known = cohortDay <= lastDayWithin7IsKnownFor;
      const returnedNextDay = players.filter((p) => p.returned_next_day).length;
      const returnedWithin7d = players.filter(
        (p) => p.returned_within_7d,
      ).length;
      return {
        cohortDay,
        players: players.length,
        games: players.reduce((total, p) => total + p.games, 0),
        returnedNextDay,
        returnedWithin7d,
        nextDayRate: d1Known ? returnedNextDay / players.length : null,
        within7dRate: within7Known ? returnedWithin7d / players.length : null,
      };
    });

  const d1Cohorts = cohorts.filter((c) => c.nextDayRate !== null);
  const within7Cohorts = cohorts.filter((c) => c.within7dRate !== null);
  const sum = (xs: number[]) => xs.reduce((total, x) => total + x, 0);

  const d1EligiblePlayers = sum(d1Cohorts.map((c) => c.players));
  const pooledNextDay = sum(d1Cohorts.map((c) => c.returnedNextDay));
  const within7dEligiblePlayers = sum(within7Cohorts.map((c) => c.players));
  const pooledWithin7d = sum(within7Cohorts.map((c) => c.returnedWithin7d));

  return {
    asOfUtcDay: utcDay(now),
    cohorts,
    pooled: {
      players: sum(cohorts.map((c) => c.players)),
      games: sum(cohorts.map((c) => c.games)),
      d1EligiblePlayers,
      returnedNextDay: pooledNextDay,
      nextDayRate:
        d1EligiblePlayers > 0 ? pooledNextDay / d1EligiblePlayers : null,
      within7dEligiblePlayers,
      returnedWithin7d: pooledWithin7d,
      within7dRate:
        within7dEligiblePlayers > 0
          ? pooledWithin7d / within7dEligiblePlayers
          : null,
    },
  };
}
