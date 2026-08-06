export type BoardSizeBucket = "small" | "medium" | "large";

export const BOARD_SIZE_AREA_SMALL_MAX = 36;
export const BOARD_SIZE_AREA_MEDIUM_MAX = 81;

export const getBoardSizeBucket = (
  boardWidth: number,
  boardHeight: number,
): BoardSizeBucket => {
  const area = boardWidth * boardHeight;
  if (area <= BOARD_SIZE_AREA_SMALL_MAX) {
    return "small";
  }
  if (area <= BOARD_SIZE_AREA_MEDIUM_MAX) {
    return "medium";
  }
  return "large";
};

/**
 * How many UTC calendar days the Past Games activity plot covers, counting the
 * current day. Deliberately a constant and not a query parameter: the plot has
 * one job, and a knob nobody asked for is a knob to keep working.
 */
export const PAST_GAMES_ACTIVITY_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` for a UTC instant. */
export const utcDayKey = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * The instant bounds of the activity window, as a half-open `[start, end)`
 * interval that lines up exactly with the days the plot draws.
 *
 * Half-open and anchored to UTC midnight rather than `now() - 90 days`: a
 * rolling 90x24-hour window starts partway through a 91st calendar day, so it
 * would count games into a bucket the plot has no column for. The exclusive
 * upper bound is the midnight that opens tomorrow, which also drops any row
 * with a future timestamp.
 *
 * UTC because no player timezone is stored anywhere, so it is the only boundary
 * that gives every reader the same answer - the same reasoning as the retention
 * report in server/db/retention-queries.ts.
 */
export const pastGamesActivityWindow = (
  at: Date,
): { start: Date; endExclusive: Date } => {
  const endExclusive = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate() + 1,
  );
  return {
    start: new Date(endExclusive - PAST_GAMES_ACTIVITY_DAYS * DAY_MS),
    endExclusive: new Date(endExclusive),
  };
};

export interface PastGamesActivityDay {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  count: number;
}

/**
 * Expand the days the database actually returned into every day in the window,
 * zeros included, so the client draws what it is handed instead of working out
 * which days are missing. Takes the same anchor as `pastGamesActivityWindow`,
 * so the buckets and the SQL bounds cannot disagree across a UTC midnight.
 */
export const densifyPastGamesActivity = (
  countsByDay: Map<string, number>,
  at: Date,
): PastGamesActivityDay[] => {
  const { start } = pastGamesActivityWindow(at);
  return Array.from({ length: PAST_GAMES_ACTIVITY_DAYS }, (_, index) => {
    const date = utcDayKey(new Date(start.getTime() + index * DAY_MS));
    return { date, count: countsByDay.get(date) ?? 0 };
  });
};

export interface PastGameOutcomePlayer {
  displayName: string;
  outcomeRank: number;
}

export const resolvePastGameWinner = (
  players: PastGameOutcomePlayer[],
): PastGameOutcomePlayer | null => {
  const winners = players.filter((player) => player.outcomeRank === 1);
  if (!winners.length || winners.length === players.length) {
    return null;
  }
  return winners[0] ?? null;
};
