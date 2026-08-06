import { db } from "./index";
import { gamesTable } from "./schema/games";
import { gameDetailsTable } from "./schema/game-details";
import { gamePlayersTable } from "./schema/game-players";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { customSetupVariantValues } from "../../shared/contracts/games";
import { GameState } from "../../shared/domain/game-state";
import { clonePawns } from "../../shared/domain/pawns";
import type {
  GameConfiguration,
  GameResult,
  GameSnapshot,
  GameInitialState,
  MatchScore,
  PlayerId,
  SerializedGameState,
  TimeControlConfig,
  TimeControlPreset,
  Variant,
  WinReason,
} from "../../shared/domain/game-types";
import { timeControlConfigFromPreset } from "../../shared/domain/game-utils";
import { moveFromStandardNotation } from "../../shared/domain/standard-notation";
import {
  BOARD_SIZE_AREA_MEDIUM_MAX,
  BOARD_SIZE_AREA_SMALL_MAX,
  densifyPastGamesActivity,
  pastGamesActivityWindow,
} from "../../shared/domain/past-games";
import type {
  PastGamesActivityResponse,
  PastGamesFilter,
  PastGamesResponse,
} from "../../shared/contracts/games";

const buildMatchScore = (result: GameResult | undefined): MatchScore => {
  if (!result?.winner) {
    return { 1: 0.5, 2: 0.5 };
  }
  return result.winner === 1 ? { 1: 1, 2: 0 } : { 1: 0, 2: 1 };
};

const winReasonValues: WinReason[] = [
  "capture",
  "timeout",
  "resignation",
  "draw-agreement",
  "one-move-rule",
  "survival",
];

const normalizeWinReason = (value?: string | null): WinReason => {
  if (!value) {
    return "draw-agreement";
  }
  return winReasonValues.includes(value as WinReason)
    ? (value as WinReason)
    : "draw-agreement";
};

const normalizeVariant = (value: string): Variant => {
  if (
    value === "standard" ||
    value === "classic" ||
    value === "freestyle" ||
    value === "survival" ||
    value === "custom-setup-standard" ||
    value === "custom-setup-classic"
  ) {
    return value;
  }
  return "standard";
};

const resolveResultFromPlayers = (
  players: {
    playerOrder: number;
    outcomeRank: number;
    outcomeReason: string;
  }[],
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

const resolveTimeControl = (
  stored: string,
  configParameters: unknown,
): TimeControlConfig => {
  const parameters = configParameters as { timeControl?: TimeControlConfig };
  if (parameters?.timeControl) {
    return parameters.timeControl;
  }
  if (stored !== "custom") {
    return timeControlConfigFromPreset(stored as TimeControlPreset);
  }
  return timeControlConfigFromPreset("rapid");
};

/**
 * Resolve variant config from DB configParameters.
 * Throws if initialState is missing - all games must have their initial state saved.
 */
const resolveVariantConfig = (
  configParameters: unknown,
  gameId: string,
): GameInitialState => {
  const parameters = configParameters as {
    initialState?: GameInitialState;
  };

  if (!parameters?.initialState) {
    throw new Error(
      `Game ${gameId} is missing initialState in configParameters. Run backfill migration.`,
    );
  }

  return parameters.initialState;
};

export interface ReplayGameData {
  matchStatus: GameSnapshot;
  state: SerializedGameState;
  views: number;
}

const replayGameSelect = {
  gameId: gamesTable.gameId,
  variant: gamesTable.variant,
  timeControl: gamesTable.timeControl,
  rated: gamesTable.rated,
  matchType: gamesTable.matchType,
  boardWidth: gamesTable.boardWidth,
  boardHeight: gamesTable.boardHeight,
  startedAt: gamesTable.startedAt,
  views: gamesTable.views,
  movesCount: gamesTable.movesCount,
};

interface ReplayGameRow {
  gameId: string;
  variant: string;
  timeControl: string;
  rated: boolean;
  matchType: string;
  boardWidth: number;
  boardHeight: number;
  startedAt: Date;
  views: number;
  movesCount: number;
}

/**
 * Details and players for a set of games, fetched by id so a batch of N games
 * costs two queries rather than 2N. Selecting gameId lets the rows be grouped
 * back onto their game in memory.
 */
const fetchReplayDetails = (gameIds: string[]) =>
  db
    .select({
      gameId: gameDetailsTable.gameId,
      configParameters: gameDetailsTable.configParameters,
      moves: gameDetailsTable.moves,
    })
    .from(gameDetailsTable)
    .where(inArray(gameDetailsTable.gameId, gameIds));

const fetchReplayPlayers = (gameIds: string[]) =>
  db
    .select({
      gameId: gamePlayersTable.gameId,
      playerOrder: gamePlayersTable.playerOrder,
      playerRole: gamePlayersTable.playerRole,
      playerConfigType: gamePlayersTable.playerConfigType,
      displayName: gamePlayersTable.displayName,
      ratingAtStart: gamePlayersTable.ratingAtStart,
      pawnColor: gamePlayersTable.pawnColor,
      catSkin: gamePlayersTable.catSkin,
      mouseSkin: gamePlayersTable.mouseSkin,
      homeSkin: gamePlayersTable.homeSkin,
      outcomeRank: gamePlayersTable.outcomeRank,
      outcomeReason: gamePlayersTable.outcomeReason,
    })
    .from(gamePlayersTable)
    .where(inArray(gamePlayersTable.gameId, gameIds));

type ReplayDetailsRow = Awaited<ReturnType<typeof fetchReplayDetails>>[number];
type ReplayPlayerRow = Awaited<ReturnType<typeof fetchReplayPlayers>>[number];

/** Pure assembly: replays the moves and shapes the response. Touches no tables. */
const assembleReplayGame = (
  game: ReplayGameRow,
  details: ReplayDetailsRow | undefined,
  players: ReplayPlayerRow[],
): ReplayGameData => {
  const result = resolveResultFromPlayers(players);
  const matchScore = buildMatchScore(result);

  const timeControl = resolveTimeControl(
    game.timeControl,
    details?.configParameters,
  );
  const variant = normalizeVariant(game.variant);
  const variantConfig = resolveVariantConfig(
    details?.configParameters,
    game.gameId,
  );

  const config: GameConfiguration = {
    variant,
    timeControl,
    rated: game.rated,
    boardWidth: game.boardWidth,
    boardHeight: game.boardHeight,
    variantConfig,
  };

  const startTimestamp = game.startedAt.getTime();
  const moves = Array.isArray(details?.moves) ? details.moves : [];
  let replayState = new GameState(config, startTimestamp);
  try {
    moves.forEach((notation, index) => {
      const move = moveFromStandardNotation(
        String(notation),
        config.boardHeight,
      );
      // The acting player comes from the replay state itself, not move-index
      // parity: custom-setup games have an authored turn, so half the puzzles
      // start with player 2. GameState seeds `turn` from variantConfig.turn.
      const playerId = replayState.turn;
      replayState = replayState.applyGameAction({
        kind: "move",
        move,
        playerId,
        timestamp: startTimestamp + index,
      });
    });
  } catch (error) {
    console.error(
      `Failed to replay game ${game.gameId} (variant: ${game.variant}):`,
      error,
    );
    console.error(`Moves: ${JSON.stringify(moves)}`);
    console.error(`Initial state: ${JSON.stringify(variantConfig)}`);
    throw error;
  }

  if (result) {
    replayState.status = "finished";
    replayState.result = result;
  }

  const history = moves.map((notation, index) => ({
    index: index + 1,
    notation: String(notation),
  }));

  const serialized: SerializedGameState = {
    status: replayState.status,
    result: replayState.result,
    turn: replayState.turn,
    moveCount: replayState.moveCount,
    timeLeft: { ...replayState.timeLeft },
    lastMoveTime: replayState.lastMoveTime,
    pawns: clonePawns(replayState.pawns),
    walls: replayState.grid.getWalls(),
    initialState: replayState.getInitialState(),
    history,
    config,
  };

  const orderedPlayers = [...players].sort((a, b) => {
    if (a.playerRole === b.playerRole) {
      return a.playerOrder - b.playerOrder;
    }
    return a.playerRole === "host" ? -1 : 1;
  });

  const matchStatus: GameSnapshot = {
    id: game.gameId,
    status: "completed",
    config,
    matchType: game.matchType as GameSnapshot["matchType"],
    createdAt: startTimestamp,
    updatedAt: startTimestamp,
    players: orderedPlayers.map((player) => {
      const pawnColor = player.pawnColor ?? "default";
      const catSkin = player.catSkin ?? "default";
      const mouseSkin = player.mouseSkin ?? "default";
      const homeSkin = player.homeSkin ?? "default";
      return {
        role: player.playerRole as "host" | "joiner",
        playerId: player.playerOrder as PlayerId,
        displayName: player.displayName,
        connected: false,
        ready: true,
        configType: player.playerConfigType === "bot" ? "bot" : "human",
        appearance: {
          pawnColor,
          catSkin,
          mouseSkin,
          homeSkin,
        },
        elo: player.ratingAtStart ?? undefined,
      };
    }),
    matchScore,
  };

  return {
    matchStatus,
    state: serialized,
    views: game.views,
  };
};

// What to do with a stored game the current rules can no longer replay. `assembleReplayGame`
// throws on one, and the choice is not a detail of the batch - it is the caller's, so it is
// required rather than defaulted. A caller asked for ONE specific game must fail loudly, because
// there is nothing else to return. A caller filling a decorative list must not: a single bad row
// out of thousands took the whole showcase down roughly 8% of the time (board task eeaab7c1).
type UnreplayableGamePolicy = "throw" | "skip";

const buildReplayGamesFromRows = async (
  games: ReplayGameRow[],
  onUnreplayable: UnreplayableGamePolicy,
): Promise<ReplayGameData[]> => {
  if (games.length === 0) {
    return [];
  }

  const gameIds = games.map((game) => game.gameId);
  const [details, players] = await Promise.all([
    fetchReplayDetails(gameIds),
    fetchReplayPlayers(gameIds),
  ]);

  const detailsByGameId = new Map(details.map((row) => [row.gameId, row]));
  const playersByGameId = new Map<string, ReplayPlayerRow[]>();
  for (const player of players) {
    const existing = playersByGameId.get(player.gameId);
    if (existing) {
      existing.push(player);
    } else {
      playersByGameId.set(player.gameId, [player]);
    }
  }

  const built: ReplayGameData[] = [];
  for (const game of games) {
    try {
      built.push(
        assembleReplayGame(
          game,
          detailsByGameId.get(game.gameId),
          playersByGameId.get(game.gameId) ?? [],
        ),
      );
    } catch (error) {
      if (onUnreplayable === "throw") {
        throw error;
      }
      // assembleReplayGame has already logged the id, the moves and the initial state, which is
      // what a fix needs; this line only records that the batch carried on without it.
      console.error(
        `Skipping unreplayable game ${game.gameId} (${built.length}/${games.length} built so far)`,
      );
    }
  }

  return built;
};

const buildReplayGameFromRow = async (
  game: ReplayGameRow,
): Promise<ReplayGameData> => {
  const [built] = await buildReplayGamesFromRows([game], "throw");
  return built;
};

export const getReplayGame = async (
  gameId: string,
): Promise<ReplayGameData | null> => {
  const [game] = await db
    .update(gamesTable)
    .set({
      views: sql`${gamesTable.views} + 1`,
    })
    .where(eq(gamesTable.gameId, gameId))
    .returning(replayGameSelect);

  if (!game) {
    return null;
  }

  return buildReplayGameFromRow(game);
};

/**
 * Like getReplayGame but without incrementing the view counter.
 * Used by the eval bar to load game data without side effects.
 */
export const getReplayGameReadonly = async (
  gameId: string,
): Promise<ReplayGameData | null> => {
  const [game] = await db
    .select(replayGameSelect)
    .from(gamesTable)
    .where(eq(gamesTable.gameId, gameId))
    .limit(1);

  if (!game) {
    return null;
  }

  return buildReplayGameFromRow(game);
};

export const getRandomShowcaseGames = async (
  count: number,
): Promise<ReplayGameData[]> => {
  const games = await db
    .select(replayGameSelect)
    .from(gamesTable)
    .where(
      and(
        gte(gamesTable.movesCount, 10),
        notInArray(gamesTable.variant, [...customSetupVariantValues]),
      ),
    )
    .orderBy(sql`random()`)
    .limit(count);

  return buildReplayGamesFromRows(games, "skip");
};

/**
 * Every condition that decides which games Past Games is about - the base
 * exclusions plus the caller's filters.
 *
 * Shared by the listing and the activity plot on purpose. "The plot shows the
 * same games as the list" is a promise that two hand-maintained WHERE clauses
 * would break the first time a filter was added to one of them; here a new
 * filter reaches both projections or neither. Its input is the shared filter
 * schema's own type, so the field list cannot drift from the API either.
 *
 * Note this is the *selection*, not the window: the plot's 90-day bound is
 * specific to that projection and is applied by its own query.
 */
const buildPastGamesConditions = (args: PastGamesFilter): SQL[] => {
  // Puzzle attempts (custom-setup variants) are solo practice, not match
  // history - they never appear in Past Games.
  const conditions: SQL[] = [
    gte(gamesTable.movesCount, 2),
    notInArray(gamesTable.variant, [...customSetupVariantValues]),
  ];

  if (args.variant) {
    conditions.push(eq(gamesTable.variant, args.variant));
  }

  if (args.rated) {
    conditions.push(eq(gamesTable.rated, args.rated === "yes"));
  }

  if (args.timeControl) {
    conditions.push(eq(gamesTable.timeControl, args.timeControl));
  }

  if (args.boardSize) {
    const area = sql`${gamesTable.boardWidth} * ${gamesTable.boardHeight}`;
    if (args.boardSize === "small") {
      conditions.push(sql`${area} <= ${BOARD_SIZE_AREA_SMALL_MAX}`);
    } else if (args.boardSize === "medium") {
      conditions.push(
        sql`${area} > ${BOARD_SIZE_AREA_SMALL_MAX} AND ${area} <= ${BOARD_SIZE_AREA_MEDIUM_MAX}`,
      );
    } else {
      conditions.push(sql`${area} > ${BOARD_SIZE_AREA_MEDIUM_MAX}`);
    }
  }

  if (args.dateFrom) {
    conditions.push(gte(gamesTable.startedAt, args.dateFrom));
  }

  if (args.dateTo) {
    conditions.push(lte(gamesTable.startedAt, args.dateTo));
  }

  if (args.minElo != null || args.maxElo != null) {
    const minElo = args.minElo ?? 0;
    const maxElo = args.maxElo ?? Number.MAX_SAFE_INTEGER;
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM ${gamePlayersTable} gp_elo
        WHERE gp_elo.game_id = ${gamesTable.gameId}
          AND gp_elo.rating_at_start IS NOT NULL
          AND gp_elo.rating_at_start >= ${minElo}
          AND gp_elo.rating_at_start <= ${maxElo}
      )`,
    );
  }

  // Normalized here rather than at the route, so both projections match names
  // the same way however they were called.
  const playerFilter = (playerName: string) =>
    sql`EXISTS (
      SELECT 1 FROM ${gamePlayersTable} gp_filter
      WHERE gp_filter.game_id = ${gamesTable.gameId}
        AND lower(gp_filter.display_name) = ${playerName.trim().toLowerCase()}
    )`;

  if (args.player1) {
    conditions.push(playerFilter(args.player1));
  }

  if (args.player2) {
    conditions.push(playerFilter(args.player2));
  }

  return conditions;
};

export const queryPastGames = async (
  args: PastGamesFilter & { page: number; pageSize: number },
): Promise<PastGamesResponse> => {
  const whereClause = and(...buildPastGamesConditions(args));
  const limit = args.pageSize + 1;
  const offset = (args.page - 1) * args.pageSize;

  const games = await db
    .select({
      gameId: gamesTable.gameId,
      variant: gamesTable.variant,
      rated: gamesTable.rated,
      timeControl: gamesTable.timeControl,
      boardWidth: gamesTable.boardWidth,
      boardHeight: gamesTable.boardHeight,
      startedAt: gamesTable.startedAt,
      movesCount: gamesTable.movesCount,
      views: gamesTable.views,
    })
    .from(gamesTable)
    .where(whereClause)
    .orderBy(desc(gamesTable.startedAt))
    .limit(limit)
    .offset(offset);

  const hasMore = games.length > args.pageSize;
  const pageGames = hasMore ? games.slice(0, args.pageSize) : games;
  const gameIds = pageGames.map((game) => game.gameId);

  const players =
    gameIds.length > 0
      ? await db
          .select({
            gameId: gamePlayersTable.gameId,
            playerOrder: gamePlayersTable.playerOrder,
            displayName: gamePlayersTable.displayName,
            ratingAtStart: gamePlayersTable.ratingAtStart,
            outcomeRank: gamePlayersTable.outcomeRank,
            outcomeReason: gamePlayersTable.outcomeReason,
          })
          .from(gamePlayersTable)
          .where(inArray(gamePlayersTable.gameId, gameIds))
      : [];

  const playersByGame = new Map<
    string,
    {
      playerOrder: number;
      displayName: string;
      ratingAtStart: number | null;
      outcomeRank: number;
      outcomeReason: string;
    }[]
  >();

  players.forEach((player) => {
    const entry = {
      playerOrder: player.playerOrder,
      displayName: player.displayName,
      ratingAtStart: player.ratingAtStart,
      outcomeRank: player.outcomeRank,
      outcomeReason: player.outcomeReason,
    };
    const list = playersByGame.get(player.gameId) ?? [];
    list.push(entry);
    playersByGame.set(player.gameId, list);
  });

  return {
    games: pageGames.map((game) => ({
      gameId: game.gameId,
      variant: normalizeVariant(game.variant),
      rated: game.rated,
      timeControl: game.timeControl,
      boardWidth: game.boardWidth,
      boardHeight: game.boardHeight,
      movesCount: game.movesCount,
      startedAt: game.startedAt.getTime(),
      views: game.views,
      players: (playersByGame.get(game.gameId) ?? [])
        .sort((a, b) => a.playerOrder - b.playerOrder)
        .map((player) => ({
          ...player,
          playerOrder: player.playerOrder as PlayerId,
        })),
    })),
    page: args.page,
    pageSize: args.pageSize,
    hasMore,
  };
};

/**
 * The same selection as `queryPastGames`, counted per UTC day over the fixed
 * activity window instead of paged. Paging deliberately has no effect here: the
 * plot is about every matching game, not the page you happen to be looking at.
 *
 * `at` is passed in rather than read from the clock inside, so the SQL bounds
 * and the densified buckets are derived from one anchor and cannot land on
 * different sides of a UTC midnight.
 */
export const queryPastGamesActivity = async (
  args: PastGamesFilter,
  at: Date,
): Promise<PastGamesActivityResponse> => {
  const { start, endExclusive } = pastGamesActivityWindow(at);
  const dayExpr = sql`to_char(${gamesTable.startedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

  const rows = await db
    .select({
      date: sql<string>`${dayExpr}`.as("day"),
      count: sql<number>`count(*)::int`,
    })
    .from(gamesTable)
    .where(
      and(
        ...buildPastGamesConditions(args),
        gte(gamesTable.startedAt, start),
        lt(gamesTable.startedAt, endExclusive),
      ),
    )
    .groupBy(dayExpr);

  const countsByDay = new Map(rows.map((row) => [row.date, row.count]));
  const days = densifyPastGamesActivity(countsByDay, at);

  // Counted twice on purpose, from the two sides that must agree: the rows the
  // database matched, and the buckets the chart will draw. Deriving the total
  // from the buckets would make "every matching game has a column" true by
  // construction, so a window that admitted a day the densifier cannot
  // represent would silently drop those games instead of showing up here.
  const rowTotal = rows.reduce((sum, row) => sum + row.count, 0);
  const bucketTotal = days.reduce((sum, day) => sum + day.count, 0);
  if (rowTotal !== bucketTotal) {
    throw new Error(
      `Past games activity window and buckets disagree: ${rowTotal} matched rows vs ${bucketTotal} in buckets`,
    );
  }

  return { days, total: rowTotal };
};
