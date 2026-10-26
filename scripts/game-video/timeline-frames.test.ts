import { describe, expect, test } from "bun:test";
import {
  allocateFrameRanges,
  movesUnderOverlay,
  videoTimeline,
} from "./timeline-frames.mjs";

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

describe("videoTimeline", () => {
  test("puts moves and events on their frame, and sounds on their second", () => {
    const t = videoTimeline({
      fps: FPS,
      // 12.84 s is frame 385.2: allocateFrameRanges rounds it to 385.
      moves: [{ ply: 9, at: 12.84 }],
      events: [
        { index: 1, ply: 9, kind: "laugh", start: 12.85, end: 13.85 },
        { index: 0, ply: 9, kind: "zoom", start: 12.5, end: 14.2 },
      ],
      sounds: [
        { name: "seeya-3", role: "event", start: 12.851, event: 0 },
        { name: "pawn", role: "move", start: 12.85, event: null },
        { name: "music-slug", role: "music", start: 0, event: null },
      ],
    });
    expect(t.moves).toEqual([{ ply: 9, at: 12.83 }]);
    // In edl.events order, whatever order they played in.
    expect(t.events.map((e) => e.index)).toEqual([0, 1]);
    expect(t.events[0]).toEqual({
      index: 0,
      ply: 9,
      kind: "zoom",
      start: 12.5,
      end: 14.2,
    });
    expect(t.sounds).toEqual([
      { name: "music-slug", role: "music", start: 0, event: null },
      { name: "pawn", role: "move", start: 12.85, event: null },
      { name: "seeya-3", role: "event", start: 12.85, event: 0 },
    ]);
  });
});
