/**
 * Seeds (and re-seeds) `global_ratings` by replaying every rated game.
 *
 * Safe to run more than once, and MEANT to be run twice - once before the live
 * writer is enabled and once after. See plans/combined-elo.md section 5a: the
 * gap between "backfill finished reading" and "writer is live" belongs to
 * nobody, and a game finishing in it would otherwise be lost forever. Because
 * this recomputes from persisted history and OVERWRITES rather than adds, a
 * second run folds in whatever the first one missed and double-counts nothing.
 *
 *   bun scripts/backfill-global-ratings.ts            # apply
 *   bun scripts/backfill-global-ratings.ts --dry-run  # report only
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../server/db";
import { gamesTable } from "../server/db/schema/games";
import { gamePlayersTable } from "../server/db/schema/game-players";
import { globalRatingsTable } from "../server/db/schema/global-ratings";
import { ratingEventsTable } from "../server/db/schema/rating-events";
import {
  replayRatedGames,
  type ReplayGame,
  type ReplayedPlayer,
} from "../server/games/rated-game";
import { Outcome } from "../server/games/rating-system";

const dryRun = Bun.argv.includes("--dry-run");

/** The db handle or a transaction: the replay reads through whichever it is given. */
type Db = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Turns the persisted rows into replay input, refusing anything malformed
 * rather than guessing. A backfill that quietly skips a bad row produces a
 * number nobody can reconcile later.
 */
const collectGames = async (tx: Db): Promise<ReplayGame[]> => {
  const rows = await tx
    .select({
      gameId: gamesTable.gameId,
      startedAt: gamesTable.startedAt,
      playerOrder: gamePlayersTable.playerOrder,
      userId: gamePlayersTable.userId,
      outcomeRank: gamePlayersTable.outcomeRank,
    })
    .from(gamesTable)
    .innerJoin(gamePlayersTable, eq(gamesTable.gameId, gamePlayersTable.gameId))
    .where(and(eq(gamesTable.rated, true), isNotNull(gamePlayersTable.userId)));

  const byGame = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = byGame.get(row.gameId) ?? [];
    bucket.push(row);
    byGame.set(row.gameId, bucket);
  }

  const games: ReplayGame[] = [];
  let skippedIncomplete = 0;

  for (const [gameId, players] of byGame) {
    // A rated game needs two identified humans. One row means the opponent was
    // a guest or a bot, which is not a rating-bearing seat - skip, do not fail.
    if (players.length !== 2) {
      skippedIncomplete++;
      continue;
    }

    const [first, second] = [...players].sort(
      (x, y) => x.playerOrder - y.playerOrder,
    );

    if (first.userId == null || second.userId == null) {
      throw new Error(`game ${gameId}: null user survived the NOT NULL filter`);
    }
    if (first.userId === second.userId) {
      throw new Error(`game ${gameId}: both seats are user ${first.userId}`);
    }

    // Ties give BOTH players outcomeRank 1; a decisive game gives the winner 1
    // and the loser 2 (server/games/persistence.ts buildOutcomeRank).
    let outcomeForA: Outcome;
    if (first.outcomeRank === 1 && second.outcomeRank === 1) {
      outcomeForA = Outcome.Tie;
    } else if (first.outcomeRank === 1 && second.outcomeRank === 2) {
      outcomeForA = Outcome.Win;
    } else if (first.outcomeRank === 2 && second.outcomeRank === 1) {
      outcomeForA = Outcome.Loss;
    } else {
      throw new Error(
        `game ${gameId}: unrecognised outcome ranks ${first.outcomeRank}/${second.outcomeRank}`,
      );
    }

    games.push({
      gameId,
      startedAt: first.startedAt,
      userIdA: first.userId,
      userIdB: second.userId,
      outcomeForA,
    });
  }

  if (skippedIncomplete > 0) {
    console.log(
      `skipped ${skippedIncomplete} rated game(s) without two identified users`,
    );
  }
  return games;
};

const describe = (players: Map<number, ReplayedPlayer>): string =>
  [...players.entries()]
    .sort((a, b) => b[1].state.rating - a[1].state.rating)
    .map(
      ([userId, p]) =>
        `  user ${userId}: ${p.state.rating.toFixed(1)} (rd ${p.state.deviation.toFixed(1)}, ` +
        `${p.recordWins}-${p.recordLosses} over ${p.gamesPlayed} games)`,
    )
    .join("\n");

const main = async () => {
  if (dryRun) {
    // Reads only, so no lock is needed and none is taken - a dry run must not
    // block live rating writes.
    const games = await collectGames(db);
    const players = replayRatedGames(games);
    console.log(`replaying ${games.length} rated game(s)`);
    console.log(`produced ratings for ${players.size} player(s)`);
    console.log(describe(players));
    console.log("\n--dry-run: nothing written");
    return;
  }

  const result = await db.transaction(async (tx) => {
    /*
    Lock FIRST, then read history through this same transaction.

    Two earlier versions of this were wrong, in the same way each time - a
    comment asserting a property the code did not have. First the read happened
    before the transaction opened at all. Then it was inside, but under SHARE
    ROW EXCLUSIVE, which does NOT do the job: per the PostgreSQL lock conflict
    table, SHARE ROW EXCLUSIVE conflicts with ROW EXCLUSIVE and above but NOT
    with ACCESS SHARE, and a plain SELECT takes ACCESS SHARE. So a live
    transaction could read the OLD global rows straight through the lock, block
    only later when its upsert asked for ROW EXCLUSIVE, and then - once this
    committed - write those stale states over the freshly replayed ones.

    ACCESS EXCLUSIVE is the mode that conflicts with every other mode including
    ACCESS SHARE, so a live transaction cannot even read global state until the
    rebuild commits. It also serialises two backfills. The cost is that ranking
    reads pause for the length of the rebuild, which for three rows is nothing.

    With reads genuinely blocked, the composition holds: a live transaction
    locks its user rows, writes its bucket, blocks here, and because persistence
    happens only AFTER rating completes, a game blocked at this point is not yet
    in `games` and so is not in the snapshot. When this commits, that
    transaction resumes, reads the rebuilt state, and applies itself once.
    */
    await tx.execute(
      sql`LOCK TABLE ${globalRatingsTable} IN ACCESS EXCLUSIVE MODE`,
    );

    const collected = await collectGames(tx);
    const replayed = replayRatedGames(collected);
    console.log(`replaying ${collected.length} rated game(s)`);
    console.log(`produced ratings for ${replayed.size} player(s)`);
    console.log(describe(replayed));

    /*
    Rebuild rather than upsert-only. "Recompute from scratch and overwrite" has
    to mean rows absent from the replay disappear too, or a global row left by
    some path the replay does not reproduce would survive forever and no
    re-run would ever remove it. Deleting under the lock is trivial at this
    scale and makes the claim honest.
    */
    await tx.delete(globalRatingsTable);

    for (const [userId, p] of replayed) {
      await tx.insert(globalRatingsTable).values({
        userId,
        rating: p.state.rating,
        ratingDeviation: p.state.deviation,
        volatility: p.state.volatility,
        peakRating: p.peakRating,
        recordWins: p.recordWins,
        recordLosses: p.recordLosses,
        lastGameAt: p.lastGameAt,
      });
    }

    // The ledger should account for every game embodied in the state above, so
    // the live writer treats these as already applied.
    if (collected.length > 0) {
      await tx
        .insert(ratingEventsTable)
        .values(collected.map((g) => ({ gameId: g.gameId })))
        .onConflictDoNothing();
    }

    /*
    Verify INSIDE the lock. Checking after commit looked equivalent and is not:
    on the second run the live writer is enabled, so a transaction that was
    blocked here resumes the moment this commits and can add a row before the
    count runs - which would throw and report a correct backfill as failed.
    Under the lock, what is counted is exactly what was written.
    */
    const [{ count: writtenRows }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(globalRatingsTable);
    if (writtenRows !== replayed.size) {
      throw new Error(
        `expected ${replayed.size} global rating row(s), wrote ${writtenRows}`,
      );
    }

    const ledger = await tx
      .select({ gameId: ratingEventsTable.gameId })
      .from(ratingEventsTable)
      .where(
        inArray(
          ratingEventsTable.gameId,
          collected.map((g) => g.gameId),
        ),
      );
    if (collected.length > 0 && ledger.length !== collected.length) {
      throw new Error(
        `ledger is short: ${ledger.length} of ${collected.length} replayed games recorded`,
      );
    }

    return {
      games: collected,
      players: replayed,
      writtenRows,
      ledgerRows: ledger.length,
    };
  });

  console.log(
    `\nwrote ${result.writtenRows} global rating row(s); ledger covers ` +
      `${result.ledgerRows}/${result.games.length} replayed game(s)`,
  );

  // Observed after the lock is released, so it can legitimately differ from the
  // verified numbers above once live writers are enabled. Logged, never
  // asserted - a live game landing here is correct behaviour, not a failure.
  const [{ count: observed }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(globalRatingsTable);
  console.log(`global_ratings now holds ${observed} row(s)`);
};

await main();
process.exit(0);
