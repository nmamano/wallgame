/**
 * Deciding a score from stored rows, with no database attached.
 *
 * This lives apart from game-queries.ts because `server/db/index.ts` opens a
 * Postgres pool at import time: anything reached through that file needs a
 * live DATABASE_URL, including a test that only adds up four rows. The rules
 * here are arithmetic over rows, not a query concern, so they belong on this
 * side of that line.
 */
import type {
  GameResult,
  MatchScore,
  PlayerId,
  WinReason,
} from "../../shared/domain/game-types";

const winReasonValues: WinReason[] = [
  "capture",
  "timeout",
  "resignation",
  "draw-agreement",
  "one-move-rule",
  "survival",
];

export const normalizeWinReason = (value?: string | null): WinReason => {
  if (!value) {
    return "draw-agreement";
  }
  return winReasonValues.includes(value as WinReason)
    ? (value as WinReason)
    : "draw-agreement";
};

/** The stored fields of one player of one game that bear on the result. */
export interface ScoredPlayerRow {
  playerOrder: number;
  playerRole: string;
  outcomeRank: number;
  outcomeReason: string;
}

export const resolveResultFromPlayers = (
  players: Pick<
    ScoredPlayerRow,
    "playerOrder" | "outcomeRank" | "outcomeReason"
  >[],
): GameResult | undefined => {
  if (!players.length) {
    return undefined;
  }
  const allWinners = players.every((player) => player.outcomeRank === 1);
  if (allWinners) {
    return {
      reason: normalizeWinReason(players[0]?.outcomeReason),
    };
  }
  const winner = players.find((player) => player.outcomeRank === 1);
  if (!winner) {
    return {
      reason: normalizeWinReason(players[0]?.outcomeReason),
    };
  }
  return {
    winner: winner.playerOrder as PlayerId,
    reason: normalizeWinReason(winner.outcomeReason),
  };
};

/** The score of a single game, ignoring any series it belongs to. */
export const buildMatchScore = (result: GameResult | undefined): MatchScore => {
  if (!result?.winner) {
    return { 1: 0.5, 2: 0.5 };
  }
  return result.winner === 1 ? { 1: 1, 2: 0 } : { 1: 0, 2: 1 };
};

/** One player of one stored game in a rematch series. */
export interface SeriesStandingRow {
  gameId: string;
  rematchNumber: number | null;
  playerRole: string;
  outcomeRank: number;
}

/** The series fields of the game being scored. */
export interface ScoredGameRow {
  seriesId: string | null;
  rematchNumber: number | null;
}

/**
 * The running score of a rematch series, as it stood at the end of one game.
 *
 * A live game reads this off the in-memory session, which counts every game of
 * the series. A replay had no such thing and scored the single game it was
 * showing, so watching any past game reported 1-0 however the series really
 * stood (board a3a3c457).
 *
 * Summed per ROLE, never per seat. Sides swap on a rematch - measured
 * 2026-08-16, one series stored its host on seat 2 in game 1 and on seat 1 in
 * game 2 - so a seat number means a different person from one game of a series
 * to the next, while host and joiner do not.
 *
 * A draw contributes half to each. That case is real rather than defensive:
 * `buildOutcomeRank` in server/games/persistence.ts writes rank 1 for BOTH
 * players when there is no winner, which is also how `resolveResultFromPlayers`
 * recognises a draw when reading.
 *
 * Games of the series that were never stored simply do not count. A game that
 * ends with zero moves is never persisted, so the score is over the games that
 * exist, which is the same set the past-games list shows.
 */
export const buildSeriesMatchScore = (input: {
  standings: SeriesStandingRow[];
  upToRematchNumber: number;
  seatByRole: { host: PlayerId; joiner: PlayerId };
}): MatchScore => {
  const byGame = new Map<string, SeriesStandingRow[]>();
  for (const row of input.standings) {
    if (row.rematchNumber === null) continue;
    if (row.rematchNumber > input.upToRematchNumber) continue;
    const existing = byGame.get(row.gameId);
    if (existing) {
      existing.push(row);
    } else {
      byGame.set(row.gameId, [row]);
    }
  }

  const totals = { host: 0, joiner: 0 };
  for (const rows of byGame.values()) {
    const winners = rows.filter((row) => row.outcomeRank === 1);
    // Both ranked first is the stored shape of a draw.
    if (winners.length === rows.length) {
      totals.host += 0.5;
      totals.joiner += 0.5;
      continue;
    }
    const winner = winners[0];
    if (!winner) continue;
    if (winner.playerRole === "host") {
      totals.host += 1;
    } else {
      totals.joiner += 1;
    }
  }

  return {
    [input.seatByRole.host]: totals.host,
    [input.seatByRole.joiner]: totals.joiner,
  } as MatchScore;
};

/**
 * The score to show beside a past game: the series running total where the
 * series is known, and this one game otherwise.
 *
 * The fallback is not a formality. `series_id` and `rematch_number` arrived
 * after games were already being stored, so an older row belongs to no
 * recorded series. Scoring such a row as a series of one states what is
 * actually known rather than inventing a chain.
 */
export const resolveReplayMatchScore = (
  game: ScoredGameRow,
  players: ScoredPlayerRow[],
  seriesStandings: SeriesStandingRow[],
): MatchScore => {
  const single = buildMatchScore(resolveResultFromPlayers(players));
  if (game.seriesId === null || game.rematchNumber === null) {
    return single;
  }
  const host = players.find((player) => player.playerRole === "host");
  const joiner = players.find((player) => player.playerRole !== "host");
  if (!host || !joiner) {
    return single;
  }
  return buildSeriesMatchScore({
    standings: seriesStandings,
    upToRematchNumber: game.rematchNumber,
    seatByRole: {
      host: host.playerOrder as PlayerId,
      joiner: joiner.playerOrder as PlayerId,
    },
  });
};
