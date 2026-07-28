import { describe, expect, it } from "bun:test";
import {
  PUZZLE_ACTION_LABELS,
  PUZZLE_ACTION_SIZING_LABEL,
  puzzleActionLabel,
} from "./puzzle-action-label";

/**
 * Puzzle cards share one grid, so their buttons must not vary in width. The
 * button reserves room for the widest steady-state label instead of a guessed
 * size; that only holds while the sizing label really is the widest, which is
 * what breaks silently if a label is reworded.
 *
 * Character count stands in for rendered width here — the labels share a font,
 * and the alternative (measuring text) needs a browser.
 */

describe("puzzle action labels", () => {
  it("labels an unsolved puzzle Solve and a solved one Replay", () => {
    expect(puzzleActionLabel(false)).toBe("Solve");
    expect(puzzleActionLabel(true)).toBe("Replay");
  });

  it("sizes buttons against the widest label a resting card can show", () => {
    const steadyLabels: string[] = Object.values(PUZZLE_ACTION_LABELS);
    const widest = steadyLabels.reduce((a, b) => (b.length > a.length ? b : a));
    const sizingLabel: string = PUZZLE_ACTION_SIZING_LABEL;

    expect(sizingLabel).toBe(widest);
    for (const label of steadyLabels) {
      expect(label.length).toBeLessThanOrEqual(sizingLabel.length);
    }
  });

  it("covers every label the card can render at rest", () => {
    const steadyLabels: string[] = Object.values(PUZZLE_ACTION_LABELS);
    for (const label of [puzzleActionLabel(false), puzzleActionLabel(true)]) {
      expect(steadyLabels).toContain(label);
    }
  });
});
