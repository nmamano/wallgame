import { describe, expect, test } from "bun:test";
import {
  advanceCaptureFeedback,
  initialCaptureFeedbackState,
  type CaptureFeedbackSnapshot,
} from "./capture-feedback";

const snapshot = (
  status: CaptureFeedbackSnapshot["status"],
  reason: "capture" | "timeout" | "draw-agreement" | null,
  historyCursor: number | null = null,
): CaptureFeedbackSnapshot => ({
  status,
  historyCursor,
  result:
    reason === null
      ? null
      : reason === "draw-agreement"
        ? { reason }
        : { winner: 1, reason },
});

describe("live capture feedback", () => {
  test("emits once for a new authoritative live capture", () => {
    const playing = advanceCaptureFeedback(
      initialCaptureFeedbackState(),
      snapshot("playing", null),
    );
    const captured = advanceCaptureFeedback(
      playing.state,
      snapshot("finished", "capture"),
    );
    const duplicate = advanceCaptureFeedback(
      captured.state,
      snapshot("finished", "capture"),
    );

    expect(captured.emit).toBe(true);
    expect(duplicate.emit).toBe(false);
  });

  test("excludes hydration, replay, history, draws, and non-capture finishes", () => {
    const hydrated = advanceCaptureFeedback(
      initialCaptureFeedbackState(),
      snapshot("finished", "capture"),
    );
    const historyPlaying = advanceCaptureFeedback(
      initialCaptureFeedbackState(),
      snapshot("playing", null, 2),
    );
    const historyCapture = advanceCaptureFeedback(
      historyPlaying.state,
      snapshot("finished", "capture", 3),
    );
    const playing = advanceCaptureFeedback(
      initialCaptureFeedbackState(),
      snapshot("playing", null),
    );
    const leftLiveForHistory = advanceCaptureFeedback(
      playing.state,
      snapshot("playing", null, 1),
    );

    expect(hydrated.emit).toBe(false);
    expect(historyCapture.emit).toBe(false);
    expect(
      advanceCaptureFeedback(
        leftLiveForHistory.state,
        snapshot("finished", "capture", 2),
      ).emit,
    ).toBe(false);
    expect(
      advanceCaptureFeedback(playing.state, snapshot("finished", "timeout"))
        .emit,
    ).toBe(false);
    expect(
      advanceCaptureFeedback(
        playing.state,
        snapshot("finished", "draw-agreement"),
      ).emit,
    ).toBe(false);
  });

  test("remount and a fresh duplicate result object do not replay feedback", () => {
    const remounted = advanceCaptureFeedback(
      initialCaptureFeedbackState(),
      snapshot("finished", "capture"),
    );
    const playing = advanceCaptureFeedback(
      initialCaptureFeedbackState(),
      snapshot("playing", null),
    );
    const first = advanceCaptureFeedback(
      playing.state,
      snapshot("finished", "capture"),
    );
    const duplicate = advanceCaptureFeedback(
      first.state,
      snapshot("finished", "capture"),
    );

    expect(remounted.emit).toBe(false);
    expect(first.emit).toBe(true);
    expect(duplicate.emit).toBe(false);
  });
});
