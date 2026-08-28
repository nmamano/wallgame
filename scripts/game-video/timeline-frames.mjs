/** Convert timed timeline items to exact cumulative CFR frame ranges. */
export function allocateFrameRanges(timeline, fps) {
  const ranges = [];
  let endFrame = 0;
  let seconds = 0;
  for (const [timelineIndex, item] of timeline.entries()) {
    seconds += item.seconds;
    const targetEndFrame = Math.round(seconds * fps);
    if (targetEndFrame <= endFrame) {
      throw new Error(`timeline item ${timelineIndex} has zero frames`);
    }
    ranges.push({
      timelineIndex,
      kind: item.kind,
      ply: item.ply,
      startFrame: endFrame,
      endFrame: targetEndFrame,
      source: item.file,
    });
    endFrame = targetEndFrame;
  }
  return ranges;
}
