import { and, eq, sql } from "drizzle-orm";
import { db } from "./index";
import { ratingsTable } from "./schema/ratings";
import { globalRatingsTable } from "./schema/global-ratings";
import { usersTable } from "./schema/users";
import {
  PROVISIONAL_GAME_THRESHOLD,
  type RankingQuery,
  type RankingResponse,
} from "../../shared/contracts/ranking";

/**
 * The two branches differ only in which table they rank and whether they filter
 * by variant. Everything after - paging, jump-to-player, row shaping - is
 * shared, because a global row and a bucket row have the same shape.
 */
const buildRankedQuery = (
  scope:
    | { kind: "global" }
    | { kind: "variant"; variant: string; timeControl: string },
) => {
  const source = scope.kind === "global" ? globalRatingsTable : ratingsTable;

  const selection = {
    userId: source.userId,
    displayName: usersTable.displayName,
    capitalizedDisplayName: usersTable.capitalizedDisplayName,
    rating: source.rating,
    peakRating: source.peakRating,
    recordWins: source.recordWins,
    recordLosses: source.recordLosses,
    createdAt: usersTable.createdAt,
    lastGameAt: source.lastGameAt,
    rank: sql<number>`ROW_NUMBER() OVER (ORDER BY ${source.rating} DESC, ${usersTable.createdAt})`.as(
      "rank",
    ),
  };

  if (scope.kind === "global") {
    return db
      .select(selection)
      .from(globalRatingsTable)
      .innerJoin(usersTable, eq(globalRatingsTable.userId, usersTable.userId))
      .as("ranked");
  }

  return db
    .select(selection)
    .from(ratingsTable)
    .innerJoin(usersTable, eq(ratingsTable.userId, usersTable.userId))
    .where(
      and(
        eq(ratingsTable.variant, scope.variant),
        eq(ratingsTable.timeControl, scope.timeControl),
      ),
    )
    .as("ranked");
};

export const queryRanking = async (
  args: RankingQuery,
): Promise<RankingResponse> => {
  const ranked = buildRankedQuery(
    args.scope === "global"
      ? { kind: "global" }
      : {
          kind: "variant",
          variant: args.variant,
          timeControl: args.timeControl,
        },
  );

  const player = args.player?.trim().toLowerCase();
  let offset = (args.page - 1) * args.pageSize;
  let resolvedPage = args.page;

  if (player) {
    const [match] = await db
      .select({ rank: ranked.rank })
      .from(ranked)
      .where(eq(ranked.displayName, player))
      .limit(1);

    if (!match) {
      return {
        rows: [],
        page: 1,
        pageSize: args.pageSize,
        hasMore: false,
      };
    }

    offset = Math.floor((match.rank - 1) / args.pageSize) * args.pageSize;
    resolvedPage = Math.floor(offset / args.pageSize) + 1;
  }

  const limit = args.pageSize + 1;
  const rows = await db
    .select({
      rank: ranked.rank,
      displayName: ranked.displayName,
      capitalizedDisplayName: ranked.capitalizedDisplayName,
      rating: ranked.rating,
      peakRating: ranked.peakRating,
      recordWins: ranked.recordWins,
      recordLosses: ranked.recordLosses,
      createdAt: ranked.createdAt,
      lastGameAt: ranked.lastGameAt,
    })
    .from(ranked)
    .orderBy(ranked.rank)
    .limit(limit)
    .offset(offset);

  const hasMore = rows.length > args.pageSize;
  const pageRows = hasMore ? rows.slice(0, args.pageSize) : rows;

  return {
    rows: pageRows.map((row) => ({
      rank: Number(row.rank),
      displayName: row.displayName,
      displayLabel: row.capitalizedDisplayName ?? row.displayName,
      rating: row.rating,
      peakRating: row.peakRating,
      recordWins: row.recordWins,
      recordLosses: row.recordLosses,
      createdAt: row.createdAt.getTime(),
      lastGameAt: row.lastGameAt.getTime(),
      provisional:
        row.recordWins + row.recordLosses < PROVISIONAL_GAME_THRESHOLD,
    })),
    page: resolvedPage,
    pageSize: args.pageSize,
    hasMore,
  };
};
