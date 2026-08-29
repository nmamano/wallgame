import { describe, expect, test } from "bun:test";
import { captureFeedbackPlan } from "./capture-feedback.mjs";

describe("video capture feedback authority", () => {
  test("capture has one stage shake and zero app shakes", () => {
    expect(
      captureFeedbackPlan({ isFinalPly: true, resultReason: "capture" }),
    ).toEqual({
      stageShakeCount: 1,
      appShakeCount: 0,
      appReducedMotion: true,
    });
  });

  test("a non-capture ending has no shake", () => {
    expect(
      captureFeedbackPlan({ isFinalPly: true, resultReason: "resignation" }),
    ).toEqual({
      stageShakeCount: 0,
      appShakeCount: 0,
      appReducedMotion: true,
    });
  });
});
