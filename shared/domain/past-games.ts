export type BoardSizeBucket = "small" | "medium" | "large";

export const BOARD_SIZE_AREA_SMALL_MAX = 36;
export const BOARD_SIZE_AREA_MEDIUM_MAX = 81;

export const getBoardSizeBucket = (
  boardWidth: number,
  boardHeight: number,
): BoardSizeBucket => {
  const area = boardWidth * boardHeight;
  if (area <= BOARD_SIZE_AREA_SMALL_MAX) {
    return "small";
  }
  if (area <= BOARD_SIZE_AREA_MEDIUM_MAX) {
    return "medium";
  }
  return "large";
};

export interface PastGameOutcomePlayer {
  displayName: string;
  outcomeRank: number;
}

export const resolvePastGameWinner = (
  players: PastGameOutcomePlayer[],
): PastGameOutcomePlayer | null => {
  const winners = players.filter((player) => player.outcomeRank === 1);
  if (!winners.length || winners.length === players.length) {
    return null;
  }
  return winners[0] ?? null;
};
