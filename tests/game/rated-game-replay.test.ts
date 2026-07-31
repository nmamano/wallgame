import { describe, expect, test } from "bun:test";
import {
  applyRatedGame,
  replayRatedGames,
  type ReplayGame,
} from "../../server/games/rated-game";
import { Outcome, initialRating } from "../../server/games/rating-system";

/**
 * The global rating's arithmetic, covered without a database.
 *
 * The DB-backed integration suite needs a container runtime the office box does
 * not have, so if this logic only existed behind a connection it could not be
 * checked before shipping. That constraint is why `rated-game.ts` is pure; these
 * are the tests that constraint bought.
 */

const game = (over: Partial<ReplayGame> & { gameId: string }): ReplayGame => ({
  startedAt: new Date("2026-01-01T00:00:00Z"),
  userIdA: 1,
  userIdB: 2,
  outcomeForA: Outcome.Win,
  ...over,
});

describe("applyRatedGame", () => {
  test("moves the winner up and the loser down", () => {
    const start = initialRating();
    const result = applyRatedGame({ a: start, b: start }, Outcome.Win);

    expect(result.a.rating).toBeGreaterThan(start.rating);
    expect(result.b.rating).toBeLessThan(start.rating);
  });

  test("a tie splits the record half and half", () => {
    const start = initialRating();
    const result = applyRatedGame({ a: start, b: start }, Outcome.Tie);

    expect(result.recordA).toEqual({ wins: 0.5, losses: 0.5 });
    expect(result.recordB).toEqual({ wins: 0.5, losses: 0.5 });
  });

  test("a win and the same game seen as a loss agree", () => {
    const start = initialRating();
    const asWin = applyRatedGame({ a: start, b: start }, Outcome.Win);
    const asLoss = applyRatedGame({ b: start, a: start }, Outcome.Loss);

    // Symmetric: whichever seat you call "a", both players end up the same.
    expect(asLoss.b.rating).toBeCloseTo(asWin.a.rating, 10);
    expect(asLoss.a.rating).toBeCloseTo(asWin.b.rating, 10);
  });

  test("every game shrinks the winner's uncertainty", () => {
    const start = initialRating();
    const result = applyRatedGame({ a: start, b: start }, Outcome.Win);

    expect(result.a.deviation).toBeLessThan(start.deviation);
  });
});

describe("replayRatedGames", () => {
  test("a player with no games does not appear", () => {
    const players = replayRatedGames([]);
    expect(players.size).toBe(0);
  });

  test("records, peak and last-played come out of the fold", () => {
    const players = replayRatedGames([
      game({ gameId: "g1", startedAt: new Date("2026-01-01T00:00:00Z") }),
      game({
        gameId: "g2",
        startedAt: new Date("2026-01-02T00:00:00Z"),
        outcomeForA: Outcome.Loss,
      }),
      game({
        gameId: "g3",
        startedAt: new Date("2026-01-03T00:00:00Z"),
        outcomeForA: Outcome.Tie,
      }),
    ]);

    const a = players.get(1)!;
    expect(a.gamesPlayed).toBe(3);
    expect(a.recordWins).toBe(1.5);
    expect(a.recordLosses).toBe(1.5);
    expect(a.lastGameAt).toEqual(new Date("2026-01-03T00:00:00Z"));
    // Peak is the running max, so it survives the later loss.
    expect(a.peakRating).toBeGreaterThan(a.state.rating);
  });

  test("input order does not matter; timestamps decide", () => {
    const games = [
      game({ gameId: "g1", startedAt: new Date("2026-01-01T00:00:00Z") }),
      game({
        gameId: "g2",
        startedAt: new Date("2026-01-02T00:00:00Z"),
        outcomeForA: Outcome.Loss,
      }),
    ];

    const forwards = replayRatedGames(games);
    const backwards = replayRatedGames([...games].reverse());

    expect(backwards.get(1)!.state.rating).toBeCloseTo(
      forwards.get(1)!.state.rating,
      10,
    );
  });

  test("games sharing a timestamp are ordered by id, not by arrival", () => {
    // Glicko-2 is path-dependent, so without the game_id tiebreak these two
    // orderings would disagree and the backfill would not be reproducible.
    const sameInstant = new Date("2026-01-01T00:00:00Z");
    const games = [
      game({ gameId: "aaa", startedAt: sameInstant }),
      game({
        gameId: "bbb",
        startedAt: sameInstant,
        outcomeForA: Outcome.Loss,
      }),
    ];

    const forwards = replayRatedGames(games);
    const backwards = replayRatedGames([...games].reverse());

    expect(backwards.get(1)!.state.rating).toBe(forwards.get(1)!.state.rating);
  });

  test("the tiebreak is load-bearing: swapping ids changes the answer", () => {
    // Guards against the tiebreak silently becoming a no-op. If ordering did
    // not matter, these two would agree and the test above would prove nothing.
    const sameInstant = new Date("2026-01-01T00:00:00Z");
    const winFirst = replayRatedGames([
      game({ gameId: "aaa", startedAt: sameInstant }),
      game({
        gameId: "bbb",
        startedAt: sameInstant,
        outcomeForA: Outcome.Loss,
      }),
    ]);
    const lossFirst = replayRatedGames([
      game({
        gameId: "aaa",
        startedAt: sameInstant,
        outcomeForA: Outcome.Loss,
      }),
      game({ gameId: "bbb", startedAt: sameInstant }),
    ]);

    expect(lossFirst.get(1)!.state.rating).not.toBe(
      winFirst.get(1)!.state.rating,
    );
  });

  test("replaying twice from scratch gives the same answer", () => {
    // This is what makes the cutover safe to run on both sides of the switch:
    // the backfill recomputes and overwrites, so a second run is a no-op rather
    // than a double count.
    const games = [
      game({ gameId: "g1", startedAt: new Date("2026-01-01T00:00:00Z") }),
      game({
        gameId: "g2",
        startedAt: new Date("2026-01-02T00:00:00Z"),
        userIdB: 3,
      }),
    ];

    const first = replayRatedGames(games);
    const second = replayRatedGames(games);

    for (const [userId, player] of first) {
      expect(second.get(userId)!.state).toEqual(player.state);
      expect(second.get(userId)!.recordWins).toBe(player.recordWins);
    }
  });

  test("a third player joins mid-history with a fresh rating", () => {
    const players = replayRatedGames([
      game({ gameId: "g1", startedAt: new Date("2026-01-01T00:00:00Z") }),
      game({
        gameId: "g2",
        startedAt: new Date("2026-01-05T00:00:00Z"),
        userIdA: 1,
        userIdB: 3,
      }),
    ]);

    expect(players.size).toBe(3);
    expect(players.get(3)!.gamesPlayed).toBe(1);
    // Player 2 never played again, so their last-played stays at the first game.
    expect(players.get(2)!.lastGameAt).toEqual(
      new Date("2026-01-01T00:00:00Z"),
    );
  });
});
