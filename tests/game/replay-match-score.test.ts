import { describe, expect, it } from "bun:test";
import {
  buildSeriesMatchScore,
  resolveReplayMatchScore,
  type SeriesStandingRow,
} from "../../server/db/replay-match-score";

/**
 * Board a3a3c457: the match score shown beside a past game.
 *
 * The fixture is the series reproduced against a local server on 2026-08-16,
 * copied from the stored rows rather than invented, because its point is the
 * SEAT SWAP that a hand-written fixture would be unlikely to include:
 *
 *   game=BqeV_nMj series=BqeV_nMj n=0  seat=1 joiner rank=2 | seat=2 host rank=1
 *   game=midZtOqg series=BqeV_nMj n=1  seat=1 host   rank=1 | seat=2 joiner rank=2
 *
 * The same person - the host - won both games, and held a different seat
 * number in each. A score summed per seat cannot describe that; a score summed
 * per role can. Before the fix, watching game 2 reported {"1":1,"2":0}, the
 * result of that one game, whatever the series really stood at.
 */
const SERIES: SeriesStandingRow[] = [
  {
    gameId: "BqeV_nMj",
    rematchNumber: 0,
    playerRole: "joiner",
    outcomeRank: 2,
  },
  { gameId: "BqeV_nMj", rematchNumber: 0, playerRole: "host", outcomeRank: 1 },
  { gameId: "midZtOqg", rematchNumber: 1, playerRole: "host", outcomeRank: 1 },
  {
    gameId: "midZtOqg",
    rematchNumber: 1,
    playerRole: "joiner",
    outcomeRank: 2,
  },
];

/** The stored player rows of each game, in the seats they really occupied. */
const PLAYERS = {
  game1: [
    {
      playerOrder: 1,
      playerRole: "joiner",
      outcomeRank: 2,
      outcomeReason: "resignation",
    },
    {
      playerOrder: 2,
      playerRole: "host",
      outcomeRank: 1,
      outcomeReason: "resignation",
    },
  ],
  game2: [
    {
      playerOrder: 1,
      playerRole: "host",
      outcomeRank: 1,
      outcomeReason: "resignation",
    },
    {
      playerOrder: 2,
      playerRole: "joiner",
      outcomeRank: 2,
      outcomeReason: "resignation",
    },
  ],
};

describe("replay match score across a rematch series", () => {
  it("scores game 1 of the series as it stood then, on the seats game 1 used", () => {
    expect(
      resolveReplayMatchScore(
        { seriesId: "BqeV_nMj", rematchNumber: 0 },
        PLAYERS.game1,
        SERIES,
      ),
      // Host led 1-0 and sat in seat 2.
    ).toEqual({ 1: 0, 2: 1 });
  });

  it("scores game 2 as the running total, on the seats game 2 used", () => {
    expect(
      resolveReplayMatchScore(
        { seriesId: "BqeV_nMj", rematchNumber: 1 },
        PLAYERS.game2,
        SERIES,
      ),
      // Host led 2-0 and had swapped to seat 1.
    ).toEqual({ 1: 2, 2: 0 });
  });

  /**
   * The regression in one line. Game 2 read {"1":1,"2":0} before the fix, and
   * that is exactly what a per-game score still produces, so naming it keeps a
   * future rewrite from quietly going back to it.
   */
  it("does not report game 2 as a fresh one-nil", () => {
    const score = resolveReplayMatchScore(
      { seriesId: "BqeV_nMj", rematchNumber: 1 },
      PLAYERS.game2,
      SERIES,
    );
    expect(score).not.toEqual({ 1: 1, 2: 0 });
  });

  it("ignores games played later in the series", () => {
    expect(
      buildSeriesMatchScore({
        standings: SERIES,
        upToRematchNumber: 0,
        seatByRole: { host: 2, joiner: 1 },
      }),
    ).toEqual({ 1: 0, 2: 1 });
  });

  /**
   * A draw is stored as rank 1 for BOTH players (buildOutcomeRank in
   * server/games/persistence.ts writes that when there is no winner), so this
   * case is one the data really produces rather than one invented here.
   */
  it("splits a drawn game half each", () => {
    const withDraw: SeriesStandingRow[] = [
      ...SERIES,
      { gameId: "third", rematchNumber: 2, playerRole: "host", outcomeRank: 1 },
      {
        gameId: "third",
        rematchNumber: 2,
        playerRole: "joiner",
        outcomeRank: 1,
      },
    ];
    expect(
      buildSeriesMatchScore({
        standings: withDraw,
        upToRematchNumber: 2,
        seatByRole: { host: 1, joiner: 2 },
      }),
    ).toEqual({ 1: 2.5, 2: 0.5 });
  });

  /**
   * series_id and rematch_number arrived after games were already being
   * stored. An older row belongs to no recorded series, and scoring it as a
   * series of one says what is known instead of inventing a chain.
   */
  it("falls back to the single game when no series was recorded", () => {
    expect(
      resolveReplayMatchScore(
        { seriesId: null, rematchNumber: null },
        PLAYERS.game2,
        [],
      ),
    ).toEqual({ 1: 1, 2: 0 });
  });

  /**
   * A series with no ordinal. The database forbids this - games carries a
   * CHECK that (series_id IS NULL) = (rematch_number IS NULL), both or
   * neither - but the row type still says `number | null`, and narrowing it is
   * what lets the ordinal be used at all. Found by a break that reddened
   * nothing: the fallback test above passes BOTH fields as null, so it never
   * reached this half of the guard.
   */
  it("falls back on a half-written row the type permits and the schema does not", () => {
    // The joiner won THIS game, while the series so far belongs to the host.
    // The two answers have to differ, or the assertion cannot tell a fallback
    // from a series mapping that quietly treated the missing ordinal as zero -
    // which is what the first version of this test did.
    const joinerWon = [
      {
        playerOrder: 1,
        playerRole: "host",
        outcomeRank: 2,
        outcomeReason: "resignation",
      },
      {
        playerOrder: 2,
        playerRole: "joiner",
        outcomeRank: 1,
        outcomeReason: "resignation",
      },
    ];
    expect(
      resolveReplayMatchScore(
        { seriesId: "BqeV_nMj", rematchNumber: null },
        joinerWon,
        SERIES,
      ),
    ).toEqual({ 1: 0, 2: 1 });
  });

  /**
   * A game missing one of its seats cannot be mapped onto roles, so it falls
   * back to the single-game score. That score reads as a DRAW, and the reason
   * is worth stating: a draw is stored as rank 1 for both players, so a lone
   * rank-1 row satisfies "everyone won" and is indistinguishable from one.
   * Pre-existing single-game behaviour, unchanged here; the assertion is that
   * the series mapping is not attempted on half a game.
   */
  it("falls back when a stored game is missing one of its seats", () => {
    expect(
      resolveReplayMatchScore(
        { seriesId: "BqeV_nMj", rematchNumber: 1 },
        [PLAYERS.game2[0]],
        SERIES,
      ),
    ).toEqual({ 1: 0.5, 2: 0.5 });
  });
});
