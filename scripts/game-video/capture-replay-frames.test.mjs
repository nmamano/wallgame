import { describe, expect, test } from "bun:test";
import {
  assertCompleteCapture,
  captureReplayFrames,
} from "./capture-replay-frames.mjs";

describe("replay frame capture", () => {
  test("waits for and records every authoritative replay position", async () => {
    let committed = -1;
    const result = await captureReplayFrames({
      moveCount: 5,
      selectInitial: async () => {
        committed = -1;
      },
      selectPly: async (ply) => {
        committed = ply;
      },
      readCommittedPly: async () => committed,
      capture: async () => null,
    });

    expect(() => assertCompleteCapture(result)).not.toThrow();
    expect(result.expected).toEqual([-1, 0, 1, 2, 3, 4]);
    expect(result.committed).toEqual(result.expected);
    expect(result.omissions).toEqual([]);
    expect(result.duplicates).toEqual([]);
    expect(result.reordered).toBe(false);
  });

  test("the shared oracle rejects an omitted final move and duplicate start", async () => {
    const committed = [-1, -1, 0, 1, 2, 3];
    let captureIndex = 0;
    const result = await captureReplayFrames({
      moveCount: 5,
      selectInitial: async () => {},
      selectPly: async () => {},
      readCommittedPly: async () => committed[captureIndex++],
      capture: async () => null,
    });

    expect(() => assertCompleteCapture(result)).toThrow(
      "replay capture mismatch",
    );
    expect(result.omissions).toEqual([4]);
    expect(result.duplicates).toEqual([-1]);
    expect(result.reordered).toBe(true);
  });
});
