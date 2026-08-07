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
 * How many calendar days the Past Games activity plot covers, counting the
 * current day. Deliberately a constant and not a query parameter: the plot has
 * one job, and a knob nobody asked for is a knob to keep working.
 */
export const PAST_GAMES_ACTIVITY_DAYS = 90;

/** True if Postgres and `Intl` will both accept this as a time zone. */
export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
};

/**
 * The calendar day an instant falls on, `YYYY-MM-DD`, as seen from `timeZone`.
 *
 * The plot's days are the reader's own days. UTC would be defensible for an
 * internal report - it is what the retention query uses, since no player
 * timezone is stored anywhere - but this chart sits next to a list that already
 * prints every timestamp in the browser's local zone, and a reader in Los
 * Angeles seeing a column for a "tomorrow" that has not started is just wrong.
 */
export const civilDayIn = (at: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);

/** The civil date `offset` days after `day`, `YYYY-MM-DD`. */
export const shiftCivilDay = (day: string, offset: number): string => {
  const [year, month, date] = day.split("-").map(Number);
  // Pure calendar arithmetic on a date with no zone attached. UTC is only the
  // carrier here - the result is never converted back to an instant, so it
  // cannot pick up an offset.
  return new Date(Date.UTC(year, month - 1, date + offset))
    .toISOString()
    .slice(0, 10);
};

/**
 * The days the plot draws, ascending, ending on `anchorDay`.
 *
 * A count of days rather than a span of hours: a rolling 90x24-hour window
 * starts partway through a 91st calendar day, so it would count games into a
 * bucket the plot has no column for.
 */
export const pastGamesActivityDays = (anchorDay: string): string[] =>
  Array.from({ length: PAST_GAMES_ACTIVITY_DAYS }, (_, index) =>
    shiftCivilDay(anchorDay, index - (PAST_GAMES_ACTIVITY_DAYS - 1)),
  );

export interface PastGamesActivityDay {
  /** Calendar day in the requesting reader's time zone, `YYYY-MM-DD`. */
  date: string;
  count: number;
}

/**
 * Expand the days the database actually returned into every day in the window,
 * zeros included, so the client draws what it is handed instead of working out
 * which days are missing. Takes the same anchor day the query bounds are built
 * from, so the buckets and the bounds cannot disagree across a midnight.
 */
export const densifyPastGamesActivity = (
  countsByDay: Map<string, number>,
  anchorDay: string,
): PastGamesActivityDay[] =>
  pastGamesActivityDays(anchorDay).map((date) => ({
    date,
    count: countsByDay.get(date) ?? 0,
  }));

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
