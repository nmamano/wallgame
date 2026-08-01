import type { PastGameSummary } from "../../../shared/contracts/games";
import {
  getBoardSizeBucket,
  resolvePastGameWinner,
} from "../../../shared/domain/past-games";

export interface PastGamePlayerView {
  label: string;
  isWinner: boolean;
}

export interface PastGameRowView {
  gameId: string;
  variant: PastGameSummary["variant"];
  rated: boolean;
  timeControlLabel: string;
  boardSizeLabel: string;
  players: PastGamePlayerView[];
  movesCount: number;
  views: number;
  dateLabel: string;
}

const formatLabel = (value: string): string => {
  if (!value) {
    return "";
  }
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
};

const formatBoardSize = (game: PastGameSummary): string => {
  const bucket = getBoardSizeBucket(game.boardWidth, game.boardHeight);
  return `${bucket} (${game.boardWidth}x${game.boardHeight})`;
};

const formatPlayers = (game: PastGameSummary): PastGamePlayerView[] => {
  // Null unless exactly one side ranked first, so draws mark nobody.
  const winner = resolvePastGameWinner(game.players);
  return [...game.players]
    .sort((a, b) => a.playerOrder - b.playerOrder)
    .map((player) => {
      const rating =
        player.ratingAtStart != null ? ` (${player.ratingAtStart})` : "";
      return {
        label: `${player.displayName}${rating}`,
        isWinner: winner !== null && player.outcomeRank === 1,
      };
    });
};

const formatDate = (timestamp: number): string => {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
};

export const presentPastGameRow = (game: PastGameSummary): PastGameRowView => {
  const timeControlLabel =
    game.timeControl === "custom" ? "Custom" : formatLabel(game.timeControl);

  return {
    gameId: game.gameId,
    variant: game.variant,
    rated: game.rated,
    timeControlLabel,
    boardSizeLabel: formatBoardSize(game),
    players: formatPlayers(game),
    movesCount: game.movesCount,
    views: game.views,
    dateLabel: formatDate(game.startedAt),
  };
};
