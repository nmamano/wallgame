import { describe, expect, it } from "bun:test";
import {
  introWalkPlan,
  introWalkSeconds,
  walkAlphaAt,
  walkDisc,
  walkDots,
  walkDrawSeconds,
  walkDrawnAt,
  WALK_DRAW_MAX_SECONDS,
  WALK_DRAW_MIN_SECONDS,
  WALK_FADE_SECONDS,
  WALK_INTRO_GAP_SECONDS,
  WALK_INTRO_HOLD_SECONDS,
} from "../../shared/domain/walk-animation";

/** A walk along row `row` of an 8x8 board, from column `from` to `to`. */
const CELL = 1 / 8;
const rowWalk = (row: number, from: number, to: number) =>
  Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => ({
    x: (from + Math.sign(to - from) * i + 0.5) * CELL,
    y: (row + 0.5) * CELL,
  }));
const steps = (n: number) => Array.from({ length: n + 1 }, () => 0);

describe("walkDrawSeconds", () => {
  it("is 0.06 s a step, between its floor and its cap", () => {
    expect(walkDrawSeconds(steps(10))).toBeCloseTo(0.6);
    expect(walkDrawSeconds(steps(2))).toBe(WALK_DRAW_MIN_SECONDS);
    expect(walkDrawSeconds(steps(40))).toBe(WALK_DRAW_MAX_SECONDS);
  });
});

describe("introWalkPlan", () => {
  const plan = introWalkPlan([{ points: steps(10) }, { points: steps(5) }]);

  it("starts the second walk a gap after the first has drawn", () => {
    expect(plan[0].start).toBe(0);
    expect(plan[1].start).toBeCloseTo(0.6 + WALK_INTRO_GAP_SECONDS);
  });

  it("fades the first as the second has drawn, the last after its hold", () => {
    expect(plan[0].fadeAt).toBeCloseTo(plan[1].start + plan[1].draw);
    expect(plan[1].fadeAt).toBeCloseTo(
      plan[1].start +
        plan[1].draw +
        WALK_INTRO_HOLD_SECONDS -
        WALK_FADE_SECONDS,
    );
    expect(introWalkSeconds(plan)).toBeCloseTo(
      plan[1].start + plan[1].draw + WALK_INTRO_HOLD_SECONDS,
    );
  });

  it("draws and fades each walk on its own clock", () => {
    expect(walkDrawnAt(plan[1], 0.5)).toBe(0);
    expect(walkDrawnAt(plan[0], 0.3)).toBeCloseTo(0.5);
    expect(walkDrawnAt(plan[0], 5)).toBe(1);
    expect(walkAlphaAt(plan[0], plan[0].fadeAt)).toBe(1);
    expect(walkAlphaAt(plan[0], plan[0].fadeAt + WALK_FADE_SECONDS)).toBe(0);
  });

  it("has no walks and no time with no walks", () => {
    expect(introWalkSeconds(introWalkPlan([]))).toBe(0);
  });
});

describe("walkDots", () => {
  const points = rowWalk(3, 0, 6);

  it("puts no dot on the hunter's cell, the target's or a hole", () => {
    const holes = [points[3]];
    const dots = walkDots({ points, holes, drawn: 1 }, CELL);
    expect(dots.length).toBeGreaterThan(0);
    for (const pawn of [points[0], points[6], points[3]]) {
      expect(
        dots.some(
          (d) =>
            Math.abs(d.x - pawn.x) < CELL / 2 &&
            Math.abs(d.y - pawn.y) < CELL / 2,
        ),
      ).toBe(false);
    }
  });

  it("draws from the hunter: half drawn is the hunter's half", () => {
    const half = walkDots({ points, drawn: 0.5 }, CELL);
    const whole = walkDots({ points, drawn: 1 }, CELL);
    expect(half.length).toBeLessThan(whole.length);
    expect(Math.max(...half.map((d) => d.x))).toBeLessThanOrEqual(
      points[3].x + 1e-9,
    );
    expect(walkDots({ points, drawn: 0 }, CELL)).toEqual([]);
  });
});

describe("walkDisc", () => {
  const points = rowWalk(3, 0, 6);
  const pawns = [points[0], points[6]].map((p) => ({ ...p, w: CELL, h: CELL }));

  it("shows no number while the walk draws, or on a cut walk", () => {
    expect(walkDisc({ points, drawn: 0.9 }, CELL, pawns)).toBeNull();
    expect(walkDisc({ points, drawn: 1, cut: true }, CELL, pawns)).toBeNull();
  });

  it("puts the number across the last step, towards the board's middle", () => {
    const disc = walkDisc({ points, drawn: 1 }, CELL, pawns)!;
    expect(disc.clear).toBe(true);
    // Row 3 is above the middle, so the number goes down, below the target.
    expect(disc.at.x).toBeCloseTo(points[6].x);
    expect(disc.at.y).toBeGreaterThan(points[6].y);
  });
});
