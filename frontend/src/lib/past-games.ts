import type { PastGameSummary } from "../../../shared/contracts/games";
import { variantDisplayName } from "../../../shared/domain/game-types";
import { resolvePastGameWinner } from "../../../shared/domain/past-games";

export interface PastGamesFilters {
  variant: "all" | "standard" | "animal-cycle" | "classic";
  rated: "all" | "yes" | "no";
  timeControl: "all" | "bullet" | "blitz" | "rapid" | "classical";
  boardSize: "all" | "small" | "medium" | "large";
  player1: string;
  player2: string;
  eloMin: string;
  eloMax: string;
}

export const defaultPastGamesFilters: PastGamesFilters = {
  variant: "all",
  rated: "all",
  timeControl: "all",
  boardSize: "all",
  player1: "",
  player2: "",
  eloMin: "",
  eloMax: "",
};

/**
 * The filters as query params, with "all" and blank fields left off entirely.
 *
 * Both the listing and the activity plot serialize through here. Serializing
 * them separately is how the two views would quietly stop agreeing about what
 * the reader asked for - the page promises the plot shows the same games the
 * list does, so there is exactly one function that decides what those are.
 */
export const buildPastGamesFilterQuery = (
  filters: PastGamesFilters,
): Record<string, string> => {
  const query: Record<string, string> = {};

  if (filters.variant !== "all") {
    query.variant = filters.variant;
  }
  if (filters.rated !== "all") {
    query.rated = filters.rated;
  }
  if (filters.timeControl !== "all") {
    query.timeControl = filters.timeControl;
  }
  if (filters.boardSize !== "all") {
    query.boardSize = filters.boardSize;
  }

  const minElo = Number.parseInt(filters.eloMin, 10);
  if (Number.isFinite(minElo) && minElo >= 0) {
    query.minElo = String(minElo);
  }
  const maxElo = Number.parseInt(filters.eloMax, 10);
  if (Number.isFinite(maxElo) && maxElo >= 0) {
    query.maxElo = String(maxElo);
  }

  const player1 = filters.player1.trim();
  if (player1) {
    query.player1 = player1;
  }
  const player2 = filters.player2.trim();
  if (player2) {
    query.player2 = player2;
  }

  return query;
};

/** The filter values a query is keyed on, in a stable order. */
export const pastGamesFilterKey = (filters: PastGamesFilters) => [
  filters.variant,
  filters.rated,
  filters.timeControl,
  filters.boardSize,
  filters.player1,
  filters.player2,
  filters.eloMin,
  filters.eloMax,
];

const AXIS_DIVISIONS = 4;

/**
 * The gap between gridlines, rounded up to a readable number.
 *
 * The axis top is derived from the step rather than the other way round, so
 * every tick is a whole number of games. Rounding the top first and dividing it
 * into four lands on values like 62.5, which then have to be displayed rounded
 * - a label that does not sit where its gridline does.
 */
const niceAxisStep = (rough: number): number => {
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  for (const step of [1, 1.25, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= rough) {
      return Math.max(1, Math.ceil(candidate));
    }
  }
  return Math.max(1, magnitude * 10);
};

export interface ActivityAxis {
  /** Value at the top of the plot area. */
  max: number;
  /** Ascending tick values, always whole games, starting at 0. */
  ticks: number[];
}

/**
 * The y-axis for a daily-activity plot whose busiest day holds `peak` games.
 *
 * Peaks of four or fewer get one tick per game instead of a fixed four
 * divisions. A filtered view whose busiest day saw a single game would
 * otherwise draw that day at a quarter of the plot height - technically true,
 * and unreadable. An empty range still floors at 1, so nothing scales up to
 * fill the chart when there is nothing to show.
 */
export const buildActivityAxis = (peak: number): ActivityAxis => {
  if (peak <= AXIS_DIVISIONS) {
    const max = Math.max(1, peak);
    return { max, ticks: Array.from({ length: max + 1 }, (_, i) => i) };
  }
  const step = niceAxisStep(peak / AXIS_DIVISIONS);
  return {
    max: step * AXIS_DIVISIONS,
    ticks: Array.from({ length: AXIS_DIVISIONS + 1 }, (_, i) => step * i),
  };
};

export interface PastGamePlayerView {
  label: string;
  kind: PastGameSummary["players"][number]["playerKind"];
  isWinner: boolean;
}

export interface PastGameRowView {
  gameId: string;
  variantLabel: string;
  randomStart: boolean;
  rated: boolean;
  timeControlLabel: string;
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
        kind: player.playerKind,
        isWinner: winner !== null && player.outcomeRank === 1,
      };
    });
};

/**
 * Date AND time of day, to the minute. Two games on the same day are otherwise
 * indistinguishable in the listing, and the order they were played in is one of
 * the first things you want when reading it.
 *
 * Locale is left to the browser (`undefined`), so the reader gets their own
 * conventions for month order and 12- vs 24-hour.
 */
const formatDate = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const presentPastGameRow = (game: PastGameSummary): PastGameRowView => {
  const timeControlLabel =
    game.timeControl === "custom" ? "Custom" : formatLabel(game.timeControl);

  return {
    gameId: game.gameId,
    variantLabel: `${variantDisplayName(game.variant)} (${game.boardWidth}x${game.boardHeight})`,
    randomStart: game.randomStart,
    rated: game.rated,
    timeControlLabel,
    players: formatPlayers(game),
    movesCount: game.movesCount,
    views: game.views,
    dateLabel: formatDate(game.startedAt),
  };
};
