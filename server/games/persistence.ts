import { db } from "../db";
import { gamesTable } from "../db/schema/games";
import { gameDetailsTable } from "../db/schema/game-details";
import { gamePlayersTable } from "../db/schema/game-players";
import { userAuthTable } from "../db/schema/users";
import { eq } from "drizzle-orm";
import { moveToStandardNotation } from "../../shared/domain/standard-notation";
import type { GameSession, SessionPlayer } from "./store";
import type { PlayerId } from "../../shared/domain/game-types";

const resolveUserId = async (
  authUserId: string | undefined,
): Promise<number | null> => {
  if (!authUserId) {
    return null;
  }
  const rows = await db
    .select({ userId: userAuthTable.userId })
    .from(userAuthTable)
    .where(eq(userAuthTable.authUserId, authUserId))
    .limit(1);
  return rows[0]?.userId ?? null;
};

const buildPlayerConfigType = (
  session: GameSession,
  player: SessionPlayer,
): string => {
  if (player.configType === "bot") {
    return "bot";
  }
  if (player.role === "host") {
    return "you";
  }
  return session.matchType === "friend" ? "friend" : "matched user";
};

/**
 * Returns the bot's composite ID (clientId:botId) for storage.
 * The composite ID uniquely identifies a bot across different clients.
 */
const getBotId = (compositeId: string | undefined): string | null => {
  return compositeId ?? null;
};

const buildOutcomeRank = (
  winner: PlayerId | undefined,
  playerId: PlayerId,
): number => {
  if (!winner) {
    return 1;
  }
  return winner === playerId ? 1 : 2;
};

const normalizeRating = (rating: number | undefined): number | null => {
  if (rating == null) {
    return null;
  }
  return Math.round(rating);
};

export const persistCompletedGame = async (
  session: GameSession,
): Promise<void> => {
  const state = session.gameState;
  if (state.status !== "finished") {
    return;
  }
  if (state.moveCount < 2) {
    return;
  }
  const startedAt = session.startedAt;
  if (startedAt == null) {
    return;
  }

  const result = state.result;
  const outcomeReason = result?.reason ?? "draw-agreement";
  const winner = result?.winner;

  const [hostUserId, joinerUserId] = await Promise.all([
    resolveUserId(session.players.host.authUserId),
    resolveUserId(session.players.joiner.authUserId),
  ]);

  const moveNotations = state.history.map((entry) =>
    moveToStandardNotation(entry.move, session.config.boardHeight),
  );

  await db.transaction(async (tx) => {
    const [insertedGame] = await tx
      .insert(gamesTable)
      .values({
        gameId: session.id,
        variant: session.config.variant,
        timeControl: session.config.timeControl.preset ?? "custom",
        rated: session.config.rated,
        matchType: session.matchType,
        boardWidth: session.config.boardWidth,
        boardHeight: session.config.boardHeight,
        startedAt: new Date(startedAt),
        movesCount: state.moveCount,
      })
      .onConflictDoNothing()
      .returning({ gameId: gamesTable.gameId });

    if (!insertedGame) {
      return;
    }

    await tx.insert(gameDetailsTable).values({
      gameId: session.id,
      configParameters: {
        timeControl: session.config.timeControl,
        initialState: state.getInitialState(),
      },
      moves: moveNotations,
    });

    await tx.insert(gamePlayersTable).values([
      {
        gameId: session.id,
        playerOrder: session.players.host.playerId,
        playerRole: session.players.host.role,
        playerConfigType: buildPlayerConfigType(session, session.players.host),
        userId: hostUserId,
        botId: getBotId(session.players.host.botCompositeId),
        ratingAtStart: normalizeRating(session.players.host.ratingAtStart),
        outcomeRank: buildOutcomeRank(winner, session.players.host.playerId),
        outcomeReason,
      },
      {
        gameId: session.id,
        playerOrder: session.players.joiner.playerId,
        playerRole: session.players.joiner.role,
        playerConfigType: buildPlayerConfigType(
          session,
          session.players.joiner,
        ),
        userId: joinerUserId,
        botId: getBotId(session.players.joiner.botCompositeId),
        ratingAtStart: normalizeRating(session.players.joiner.ratingAtStart),
        outcomeRank: buildOutcomeRank(winner, session.players.joiner.playerId),
        outcomeReason,
      },
    ]);
  });
};
