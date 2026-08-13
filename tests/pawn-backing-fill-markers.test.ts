import { describe, expect, test } from "bun:test";
import { restoreBackingFillMarkers } from "../scripts/browser-harness/pawn-backing-fill-markers";

describe("Puppy backing-fill marker restoration", () => {
  test("restores the runtime-transparent marker for backing generation", () => {
    expect(
      restoreBackingFillMarkers(
        '<path fill="none" data-pawn-backing-fill="white"/>',
        "puppy.svg",
      ),
    ).toBe('<path fill="rgb(255, 255, 255)"/>');
  });

  test("known-bad attribute drift stops instead of hollowing the backing", () => {
    expect(() =>
      restoreBackingFillMarkers(
        '<path data-pawn-backing-fill="white" fill="none"/>',
        "drifted.svg",
      ),
    ).toThrow("drifted.svg: 1 backing-fill marker(s) were not restored");
  });
});
