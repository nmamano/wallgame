import { db } from "./index";
import { gamesTable } from "./schema/games";
import { gameDetailsTable } from "./schema/game-details";
import { gamePlayersTable } from "./schema/game-players";
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { GameState } from "../../shared/domain/game-state";
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
  SurvivalInitialState,
  StandardInitialState,
} from "../../shared/domain/game-types";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import { buildClassicInitialState } from "../../shared/domain/classic-setup";
import { timeControlConfigFromPreset } from "../../shared/domain/game-utils";
import { moveFromStandardNotation } from "../../shared/domain/standard-notation";
import {
  BOARD_SIZE_AREA_MEDIUM_MAX,
  BOARD_SIZE_AREA_SMALL_MAX,
} from "../../shared/domain/past-games";
import type { PastGamesResponse } from "../../shared/contracts/games";

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
    value === "survival"
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
 * Handles backward compatibility with old data format.
 */
const resolveVariantConfig = (
  configParameters: unknown,
  variant: Variant,
  boardWidth: number,
  boardHeight: number,
): GameInitialState => {
  const parameters = configParameters as {
    initialState?: GameInitialState;
    // Legacy format: survival settings stored separately
    survival?: {
      turnsToSurvive: number;
      mouseCanMove: boolean;
      initialWalls?: { cell: readonly [number, number]; orientation: string }[];
      initialPawns?: {
        p1Cat?: readonly [number, number];
        p2Mouse?: readonly [number, number];
      };
    };
  };

  // If initialState exists and is the new unified format, use it directly
  if (parameters?.initialState) {
    // Check if this is old StandardInitialState format for survival variant
    // (old format had pawns structure, new format has flat cat/mouse)
    if (variant === "survival" && "pawns" in parameters.initialState) {
      // Old format - need to merge with survival settings
      const oldState = parameters.initialState as StandardInitialState;
      const survival = parameters.survival;
      if (survival) {
        const survivalConfig: SurvivalInitialState = {
          cat: survival.initialPawns?.p1Cat ?? oldState.pawns[1].cat,
          mouse: survival.initialPawns?.p2Mouse ?? oldState.pawns[2].mouse,
          turnsToSurvive: survival.turnsToSurvive,
          mouseCanMove: survival.mouseCanMove,
          walls: oldState.walls,
        };
        return survivalConfig;
      }
    }
    return parameters.initialState;
  }

  // No initialState - build defaults based on variant
  if (variant === "classic") {
    return buildClassicInitialState(boardWidth, boardHeight);
  }
  return buildStandardInitialState(boardWidth, boardHeight);
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

const buildReplayGameFromRow = async (
  game: ReplayGameRow,
): Promise<ReplayGameData> => {
  const [details] = await db
    .select({
      configParameters: gameDetailsTable.configParameters,
      moves: gameDetailsTable.moves,
    })
    .from(gameDetailsTable)
    .where(eq(gameDetailsTable.gameId, game.gameId))
    .limit(1);

  const players = await db
    .select({
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
    .where(eq(gamePlayersTable.gameId, game.gameId));

  const result = resolveResultFromPlayers(players);
  const matchScore = buildMatchScore(result);

  const timeControl = resolveTimeControl(
    game.timeControl,
    details?.configParameters,
  );
  const variant = normalizeVariant(game.variant);
  const variantConfig = resolveVariantConfig(
    details?.configParameters,
    variant,
    game.boardWidth,
    game.boardHeight,
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
  moves.forEach((notation, index) => {
    const move = moveFromStandardNotation(String(notation), config.boardHeight);
    const playerId = (index % 2 === 0 ? 1 : 2) as PlayerId;
    replayState = replayState.applyGameAction({
      kind: "move",
      move,
      playerId,
      timestamp: startTimestamp + index,
    });
  });

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
    pawns: {
      1: {
        cat: replayState.pawns[1].cat,
        mouse: replayState.pawns[1].mouse,
      },
      2: {
        cat: replayState.pawns[2].cat,
        mouse: replayState.pawns[2].mouse,
      },
    },
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

export const getRandomShowcaseGame =
  async (): Promise<ReplayGameData | null> => {
    const [game] = await db
      .select(replayGameSelect)
      .from(gamesTable)
      .where(gte(gamesTable.movesCount, 10))
      .orderBy(sql`random()`)
      .limit(1);

    if (!game) {
      return null;
    }

    return buildReplayGameFromRow(game);
  };

export const queryPastGames = async (args: {
  page: number;
  pageSize: number;
  variant?: string;
  rated?: "yes" | "no";
  timeControl?: string;
  boardSize?: "small" | "medium" | "large";
  minElo?: number;
  maxElo?: number;
  dateFrom?: Date;
  dateTo?: Date;
  player1?: string;
  player2?: string;
}): Promise<PastGamesResponse> => {
  const conditions: SQL[] = [gte(gamesTable.movesCount, 2)];

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

  const playerFilter = (playerName: string) =>
    sql`EXISTS (
      SELECT 1 FROM ${gamePlayersTable} gp_filter
      WHERE gp_filter.game_id = ${gamesTable.gameId}
        AND lower(gp_filter.display_name) = ${playerName}
    )`;

  if (args.player1) {
    conditions.push(playerFilter(args.player1));
  }

  if (args.player2) {
    conditions.push(playerFilter(args.player2));
  }

  const whereClause = and(...conditions);
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
