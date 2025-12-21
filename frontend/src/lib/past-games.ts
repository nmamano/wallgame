import type { PastGameSummary } from "../../../shared/contracts/games";
import {
  getBoardSizeBucket,
  resolvePastGameWinner,
} from "../../../shared/domain/past-games";

export interface PastGameRowView {
  gameId: string;
  variant: PastGameSummary["variant"];
  rated: boolean;
  timeControlLabel: string;
  boardSizeLabel: string;
  playersLabel: string;
  winnerLabel: string | null;
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

const formatPlayers = (game: PastGameSummary): string => {
  return [...game.players]
    .sort((a, b) => a.playerOrder - b.playerOrder)
    .map((player) => {
      const rating =
        player.ratingAtStart != null ? ` (${player.ratingAtStart})` : "";
      return `${player.displayName}${rating}`;
    })
    .join(" vs ");
};

const formatDate = (timestamp: number): string => {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
};

export const presentPastGameRow = (game: PastGameSummary): PastGameRowView => {
  const winner = resolvePastGameWinner(game.players)?.displayName ?? null;
  const timeControlLabel =
    game.timeControl === "custom" ? "Custom" : formatLabel(game.timeControl);

  return {
    gameId: game.gameId,
    variant: game.variant,
    rated: game.rated,
    timeControlLabel,
    boardSizeLabel: formatBoardSize(game),
    playersLabel: formatPlayers(game),
    winnerLabel: winner,
    movesCount: game.movesCount,
    views: game.views,
    dateLabel: formatDate(game.startedAt),
  };
};
