export function captureFeedbackPlan({ isFinalPly, resultReason }) {
  const captureEnding = isFinalPly && resultReason === "capture";
  return {
    stageShakeCount: captureEnding ? 1 : 0,
    appShakeCount: 0,
    appReducedMotion: true,
  };
}
