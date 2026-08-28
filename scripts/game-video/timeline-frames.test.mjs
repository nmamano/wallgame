import { describe, expect, test } from "bun:test";
import { allocateFrameRanges } from "./timeline-frames.mjs";

describe("video timeline frame allocation", () => {
  test("maps each move to a positive ordered frame and time range", () => {
    const timeline = Array.from({ length: 6 }, (_, ply) => ({
      kind: ply === 0 ? "initial" : "move",
      ply: ply - 1,
      seconds: 0.05,
      file: `${ply}.png`,
    }));
    const ranges = allocateFrameRanges(timeline, 30);

    expect(ranges.map((range) => range.endFrame - range.startFrame)).toEqual([
      2, 1, 2, 1, 2, 1,
    ]);
    expect(ranges.map((range) => range.ply)).toEqual([-1, 0, 1, 2, 3, 4]);
    expect(ranges.at(-1)?.endFrame).toBe(9);
    expect(ranges.every((range) => range.endFrame > range.startFrame)).toBe(
      true,
    );
  });

  test("refuses a zero-duration output range", () => {
    expect(() =>
      allocateFrameRanges(
        [{ kind: "move", ply: 0, seconds: 0.001, file: "0.png" }],
        30,
      ),
    ).toThrow("zero frames");
  });
});
