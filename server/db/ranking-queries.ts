import { and, eq, sql } from "drizzle-orm";
import { db } from "./index";
import { ratingsTable } from "./schema/ratings";
import { usersTable } from "./schema/users";
import type { RankingResponse } from "../../shared/contracts/ranking";

const buildRankedQuery = (args: { variant: string; timeControl: string }) =>
  db
    .select({
      userId: ratingsTable.userId,
      displayName: usersTable.displayName,
      capitalizedDisplayName: usersTable.capitalizedDisplayName,
      rating: ratingsTable.rating,
      peakRating: ratingsTable.peakRating,
      recordWins: ratingsTable.recordWins,
      recordLosses: ratingsTable.recordLosses,
      createdAt: usersTable.createdAt,
      lastGameAt: ratingsTable.lastGameAt,
      rank: sql<number>`ROW_NUMBER() OVER (ORDER BY ${ratingsTable.rating} DESC, ${usersTable.createdAt})`.as(
        "rank",
      ),
    })
    .from(ratingsTable)
    .innerJoin(usersTable, eq(ratingsTable.userId, usersTable.userId))
    .where(
      and(
        eq(ratingsTable.variant, args.variant),
        eq(ratingsTable.timeControl, args.timeControl),
      ),
    )
    .as("ranked");

export const queryRanking = async (args: {
  variant: string;
  timeControl: string;
  page: number;
  pageSize: number;
  player?: string;
}): Promise<RankingResponse> => {
  const ranked = buildRankedQuery({
    variant: args.variant,
    timeControl: args.timeControl,
  });

  let offset = (args.page - 1) * args.pageSize;
  let resolvedPage = args.page;

  if (args.player) {
    const [match] = await db
      .select({ rank: ranked.rank })
      .from(ranked)
      .where(eq(ranked.displayName, args.player))
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
    })),
    page: resolvedPage,
    pageSize: args.pageSize,
    hasMore,
  };
};
