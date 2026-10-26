import { describe, expect, test } from "bun:test";
import { allocateFrameRanges, movesUnderOverlay } from "./timeline-frames.mjs";

// A daily opening at 30 fps: a 1 s cold open, then the 4 s VS overlay over
// the opening position (ply -1), as the renderer emits it frame by frame.
const FPS = 30;
const frames = (n: number, kind: string, ply: number) =>
  Array.from({ length: n }, () => ({ seconds: 1 / FPS, kind, ply, file: "f" }));

describe("movesUnderOverlay", () => {
  test("finds a move that lands while the banners slide out", () => {
    // The old timing: the first move at the START of the 0.6 s exit.
    const timeline = [
      ...frames(30, "cold-open", 34),
      ...frames(102, "vs-overlay", -1),
      ...frames(18, "vs-overlay", 0),
      { seconds: 0.3, kind: "move", ply: 0, file: "f" },
    ];
    const ranges = allocateFrameRanges(timeline, FPS);
    expect(movesUnderOverlay(ranges, -1)).toHaveLength(18);
    expect(movesUnderOverlay(ranges, -1)).toContainEqual(
      expect.objectContaining({ ply: 0, startFrame: 132 }),
    );
  });

  test("passes when the first move waits for the end of the exit", () => {
    const timeline = [
      ...frames(30, "cold-open", 34),
      ...frames(120, "vs-overlay", -1),
      { seconds: 0.3, kind: "move", ply: 0, file: "f" },
    ];
    expect(movesUnderOverlay(allocateFrameRanges(timeline, FPS), -1)).toEqual(
      [],
    );
  });

  test("takes the opening label of a video that starts at startPly", () => {
    const timeline = [
      ...frames(120, "vs-overlay", 8),
      { seconds: 0.3, kind: "move", ply: 9, file: "f" },
    ];
    const ranges = allocateFrameRanges(timeline, FPS);
    expect(movesUnderOverlay(ranges, 8)).toEqual([]);
    expect(movesUnderOverlay(ranges, -1)).toHaveLength(120);
  });
});
