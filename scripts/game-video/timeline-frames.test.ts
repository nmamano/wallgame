import { describe, expect, test } from "bun:test";
import { allocateFrameRanges, videoTimeline } from "./timeline-frames.mjs";

// Frames at 30 fps, as the renderer emits them one by one.
const FPS = 30;
const frames = (n: number, kind: string, ply: number) =>
  Array.from({ length: n }, () => ({ seconds: 1 / FPS, kind, ply, file: "f" }));

describe("allocateFrameRanges for a draft (sample)", () => {
  test("a 30 fps timeline at 15 fps keeps every other frame, on the same seconds", () => {
    const timeline = [
      ...frames(4, "move", 0),
      { seconds: 0.5, kind: "move", ply: 1, file: "g" },
    ];
    expect(() => allocateFrameRanges(timeline, 15)).toThrow("zero frames");
    const ranges = allocateFrameRanges(timeline, 15, { sample: true });
    // 1/30 s items end on frames 0.5, 1, 1.5, 2 at 15 fps: two get one.
    expect(ranges).toHaveLength(3);
    expect(ranges[0]).toMatchObject({
      timelineIndex: 0,
      startFrame: 0,
      endFrame: 1,
    });
    expect(ranges[1]).toMatchObject({
      timelineIndex: 2,
      startFrame: 1,
      endFrame: 2,
    });
    expect(ranges[2]).toMatchObject({
      timelineIndex: 4,
      startFrame: 2,
      endFrame: 10,
    });
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
