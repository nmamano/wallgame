import type { GameResult } from "../../../shared/domain/game-types";

export interface CaptureFeedbackSnapshot {
  status: "loading" | "waiting" | "playing" | "finished" | "aborted";
  result: GameResult | null;
  historyCursor: number | null;
}

export interface CaptureFeedbackState {
  wasLivePlaying: boolean;
  emittedResult: GameResult | null;
}

export const initialCaptureFeedbackState = (): CaptureFeedbackState => ({
  wasLivePlaying: false,
  emittedResult: null,
});

export const advanceCaptureFeedback = (
  state: CaptureFeedbackState,
  snapshot: CaptureFeedbackSnapshot,
): { state: CaptureFeedbackState; emit: boolean } => {
  const isLive = snapshot.historyCursor === null;
  const emit =
    state.wasLivePlaying &&
    isLive &&
    snapshot.status === "finished" &&
    snapshot.result?.reason === "capture" &&
    snapshot.result !== state.emittedResult;

  return {
    state: {
      wasLivePlaying: isLive && snapshot.status === "playing",
      emittedResult: emit ? snapshot.result : state.emittedResult,
    },
    emit,
  };
};
