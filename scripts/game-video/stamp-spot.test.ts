import { describe, expect, test } from "bun:test";
import { stampSpot } from "./stamp-spot.mjs";

// An 8x8 board with no margin: a cell is 1/8 on each side.
const C = 1 / 8;
const cellBox = (row: number, col: number) => [
  col * C,
  row * C,
  (col + 1) * C,
  (row + 1) * C,
];
const mid = (row: number, col: number) => ({
  x: (col + 0.5) * C,
  y: (row + 0.5) * C,
});
const word = { w: 0.6, h: 0.16 };
const spot = (avoid: number[][], focus: { x: number; y: number } | null) =>
  stampSpot({
    size: word,
    pad: 0,
    avoid,
    cellArea: C * C,
    focus,
    punchFrom: 1.9,
  });

describe("stampSpot", () => {
  test("leaves the band of the pawns it is about", () => {
    // Two cats and the move's cell in the middle rows, as with "NOPE".
    const avoid = [cellBox(3, 3), cellBox(4, 4), cellBox(4, 3)];
    const s = spot(avoid, mid(4, 3));
    expect(s.covered).toBe(0);
    expect(s.band).toBe("top");
  });

  test("on a tie, takes the band farther from the move", () => {
    expect(spot([], mid(1, 4)).band).toBe("bottom");
    expect(spot([], mid(6, 4)).band).toBe("top");
  });

  test("on a tie at rest, takes the band with the fuller slam", () => {
    // A pawn 0.01 under the top band: there the word, 0.16 high, reaches
    // it at 1.125 times its size. The middle and bottom bands slam fully,
    // so the middle wins, though the bottom is nearer the move.
    const s = spot([[0.4, 0.17, 0.5, 0.25]], mid(7, 4));
    expect(s.band).toBe("middle");
    expect(s.pop).toBe(1.9);
  });

  test("its pop is the size at which it first reaches a box", () => {
    // 0.1 from the middle band's centre: 0.1 / (0.16 / 2) = 1.25.
    const s = spot(
      [
        [0.4, 0.17, 0.5, 0.25],
        [0.4, 0.6, 0.5, 0.62],
        [0.4, 0.8, 0.5, 0.82],
      ],
      null,
    );
    expect(s.band).toBe("middle");
    expect(s.pop).toBeCloseTo(1.25, 9);
  });

  test("a box it covers at rest sets no limit on its slam", () => {
    const s = spot([cellBox(0, 3), cellBox(3, 3), cellBox(7, 3)], null);
    expect(s.covered).toBeGreaterThan(0);
    expect(s.pop).toBe(1.9);
  });

  test("hides the least when every band hides something", () => {
    const avoid = [
      cellBox(0, 3),
      cellBox(0, 4),
      cellBox(3, 3),
      cellBox(7, 2),
      cellBox(7, 3),
      cellBox(7, 4),
    ];
    const s = spot(avoid, null);
    expect(s.band).toBe("middle");
    // Row 3 spans 0.375..0.5; the middle band 0.42..0.58 covers 0.08 of its 0.125.
    expect(s.covered).toBeCloseTo(0.64, 9);
  });

  test("keeps the word inside the board's margin", () => {
    const s = stampSpot({
      size: word,
      pad: 0.01,
      avoid: [cellBox(3, 3), cellBox(4, 3)],
      cellArea: C * C,
      focus: mid(3, 3),
      punchFrom: 1.9,
    });
    expect(s.band).toBe("bottom");
    expect(s.at.y + word.h / 2).toBeCloseTo(0.99, 9);
  });
});
