/**
 * The rating arithmetic, with no database in sight.
 *
 * Both the live path (a game just finished) and the backfill (replay all of
 * history) go through `applyRatedGame`, so "the backfill agrees with live
 * updates" is true by construction rather than by inspection - there is one
 * implementation of the arithmetic and two callers of it.
 *
 * Keeping it pure is also what makes it testable here at all: the DB-backed
 * integration suite needs a container runtime, which the office box does not
 * have, so anything that only exists behind a database connection cannot be
 * checked before it ships.
 */
import {
  Outcome,
  newRatingsAfterGame,
  initialRating,
  type RatingState,
} from "./rating-system";

/** Win/loss totals move by half a game each on a tie, matching `ratings`. */
export interface RecordDelta {
  wins: number;
  losses: number;
}

export interface RatedGameResult {
  a: RatingState;
  b: RatingState;
  recordA: RecordDelta;
  recordB: RecordDelta;
}

export const complementOf = (outcome: Outcome): Outcome => {
  switch (outcome) {
    case Outcome.Win:
      return Outcome.Loss;
    case Outcome.Loss:
      return Outcome.Win;
    case Outcome.Tie:
      return Outcome.Tie;
  }
};

const recordDeltaFor = (outcome: Outcome): RecordDelta => ({
  wins: outcome === Outcome.Win ? 1 : outcome === Outcome.Tie ? 0.5 : 0,
  losses: outcome === Outcome.Loss ? 1 : outcome === Outcome.Tie ? 0.5 : 0,
});

/**
 * Advances two existing rating states by one game.
 *
 * Takes the CURRENT states rather than a whole history, because the live path
 * starts from whatever the two players already have. The replay below is a fold
 * of this same function starting from `initialRating()`.
 */
export const applyRatedGame = (
  current: { a: RatingState; b: RatingState },
  outcomeForA: Outcome,
): RatedGameResult => {
  const next = newRatingsAfterGame(current.a, current.b, outcomeForA);
  return {
    a: next.a,
    b: next.b,
    recordA: recordDeltaFor(outcomeForA),
    recordB: recordDeltaFor(complementOf(outcomeForA)),
  };
};

/** One rated game, as the replay needs to see it. */
export interface ReplayGame {
  gameId: string;
  /** Sort key. Only `started_at` is stored; see plans/combined-elo.md §5. */
  startedAt: Date;
  userIdA: number;
  userIdB: number;
  outcomeForA: Outcome;
}

/** Everything the ranking needs about one player, derived from the replay. */
export interface ReplayedPlayer {
  state: RatingState;
  peakRating: number;
  recordWins: number;
  recordLosses: number;
  lastGameAt: Date;
  gamesPlayed: number;
}

/**
 * Folds `applyRatedGame` over a game sequence, from initial ratings.
 *
 * Sorting happens here, on `(startedAt, gameId)`. The tiebreak is not
 * decoration: Glicko-2 is path-dependent, so two games with an identical
 * timestamp would otherwise produce different answers on different runs
 * depending on how the database happened to return them. This makes the replay
 * reproducible. It does NOT make it identical to the live sequence, which
 * applied in completion order - a time this schema never recorded.
 */
export const replayRatedGames = (
  games: readonly ReplayGame[],
): Map<number, ReplayedPlayer> => {
  const ordered = [...games].sort((x, y) => {
    const byTime = x.startedAt.getTime() - y.startedAt.getTime();
    return byTime !== 0 ? byTime : x.gameId.localeCompare(y.gameId);
  });

  const players = new Map<number, ReplayedPlayer>();
  const seed = (userId: number, at: Date): ReplayedPlayer => {
    const existing = players.get(userId);
    if (existing) return existing;
    const fresh: ReplayedPlayer = {
      state: initialRating(),
      peakRating: initialRating().rating,
      recordWins: 0,
      recordLosses: 0,
      lastGameAt: at,
      gamesPlayed: 0,
    };
    players.set(userId, fresh);
    return fresh;
  };

  for (const game of ordered) {
    const a = seed(game.userIdA, game.startedAt);
    const b = seed(game.userIdB, game.startedAt);

    const result = applyRatedGame({ a: a.state, b: b.state }, game.outcomeForA);

    players.set(game.userIdA, {
      state: result.a,
      peakRating: Math.max(a.peakRating, result.a.rating),
      recordWins: a.recordWins + result.recordA.wins,
      recordLosses: a.recordLosses + result.recordA.losses,
      lastGameAt: game.startedAt,
      gamesPlayed: a.gamesPlayed + 1,
    });
    players.set(game.userIdB, {
      state: result.b,
      peakRating: Math.max(b.peakRating, result.b.rating),
      recordWins: b.recordWins + result.recordB.wins,
      recordLosses: b.recordLosses + result.recordB.losses,
      lastGameAt: game.startedAt,
      gamesPlayed: b.gamesPlayed + 1,
    });
  }

  return players;
};
