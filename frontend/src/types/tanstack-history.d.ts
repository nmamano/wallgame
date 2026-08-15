export {};

declare module "@tanstack/history" {
  interface HistoryState {
    pastGamesFilters?: {
      variant?: "all" | "standard" | "animal-cycle" | "classic";
      rated?: "all" | "yes" | "no";
      timeControl?: "all" | "bullet" | "blitz" | "rapid" | "classical";
      boardSize?: "all" | "small" | "medium" | "large";
      player1?: string;
      player2?: string;
      eloMin?: string;
      eloMax?: string;
    };
    rankingFilters?: {
      variant?: "standard" | "animal-cycle" | "classic";
      timeControl?: "bullet" | "blitz" | "rapid" | "classical";
      player?: string;
    };
    replayPlyIndex?: number;
  }
}
