import { describe, expect, test } from "bun:test";
import {
  cutByEdge,
  nameBox,
  nameMeetsDots,
  pawnUnderName,
} from "./mark-fit.mjs";

// An 8x8 board: one cell's pitch is 1/8 of the board.
const PITCH = 1 / 8;
const GRID = { letterWidth: 0.62, pitchX: PITCH, pitchY: PITCH };
/** The centre of a cell, by its column and row from the top (0-based). */
const centre = (col: number, row: number) => ({
  x: (col + 0.5) * PITCH,
  y: (row + 0.5) * PITCH,
});
/** A pawn as the page draws it: 0.8 of a cell, centred on its cell. */
const pawn = (col: number, row: number) => ({
  ...centre(col, row),
  w: 0.8 * PITCH,
  h: 0.8 * PITCH,
});
/** "Human" over a cat on h8 (col 7, row 0), its baseline in row 1. */
const human = (col: number, baselineRow: number) => ({
  text: "Human",
  x: centre(col, 0).x,
  y: baselineRow * PITCH + 0.1 * PITCH,
  size: 0.42 * PITCH,
});

describe("pawnUnderName (name-covers-pawn)", () => {
  test("a name in a row with no pawn under its letters covers nothing", () => {
    // The cat on h8 and the mouse on g7: the name sits in row 7's top, by
    // column e, clear of both.
    const paint = { ...human(4, 1), y: 1 * PITCH + 0.5 * PITCH };
    expect(pawnUnderName(paint, [pawn(7, 0), pawn(0, 7)], GRID)).toBe(
      undefined,
    );
  });

  test("a name whose letters run over another pawn finds that pawn", () => {
    const paint = { ...human(4, 1), y: 1 * PITCH + 0.5 * PITCH };
    const mouse = pawn(4, 1);
    expect(pawnUnderName(paint, [pawn(7, 0), mouse], GRID)).toBe(mouse);
  });

  test("a name that only touches a pawn's box (under a hundredth of a cell) covers it not", () => {
    const paint = { ...human(4, 1), y: 1 * PITCH + 0.5 * PITCH };
    const box = nameBox(paint, GRID.letterWidth);
    // A pawn whose left edge sits 0.005 cell inside the name's right end.
    const w = 0.8 * PITCH;
    const near = {
      x: box.x + box.w - 0.005 * PITCH + w / 2,
      y: paint.y,
      w,
      h: w,
    };
    expect(pawnUnderName(paint, [near], GRID)).toBe(undefined);
    const into = { ...near, x: near.x - 0.05 * PITCH };
    expect(pawnUnderName(paint, [into], GRID)).toBe(into);
  });
});

describe("cutByEdge (mark-cut)", () => {
  test("a box inside the board, or past it by a hair, is not cut", () => {
    expect(cutByEdge({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).toBe(false);
    expect(cutByEdge({ x: 0.8, y: 0.0, w: 0.2015, h: 0.1 })).toBe(false);
  });

  test("a box past any edge of the board is cut", () => {
    expect(cutByEdge({ x: 0.85, y: 0.4, w: 0.16, h: 0.1 })).toBe(true);
    expect(cutByEdge({ x: -0.01, y: 0.4, w: 0.1, h: 0.1 })).toBe(true);
    expect(cutByEdge({ x: 0.4, y: -0.01, w: 0.1, h: 0.1 })).toBe(true);
    expect(cutByEdge({ x: 0.4, y: 0.95, w: 0.1, h: 0.06 })).toBe(true);
  });
});

describe("nameMeetsDots (an opening name keeps off the walks' dots)", () => {
  const R = 0.17 * PITCH;
  // "Human" under a cat on a8 (wYcrCoxU, 2026-11-13): its baseline just
  // over row 7's middle, its letters across a7 and b7.
  const under = { ...human(0, 1), x: 0.1, y: 1 * PITCH + 0.5 * PITCH };

  test("a walk along the name's row meets it", () => {
    const row7 = [1, 2, 3].map((col) => centre(col, 1));
    expect(nameMeetsDots(under, row7, GRID.letterWidth, R, R)).toBe(true);
  });

  test("a walk two rows away does not", () => {
    const row5 = [0, 1, 2, 3].map((col) => centre(col, 3));
    expect(nameMeetsDots(under, row5, GRID.letterWidth, R, R)).toBe(false);
  });

  test("a dot whose edge only nears the letters' box does not", () => {
    const box = nameBox(under, GRID.letterWidth);
    const dot = { x: box.x + box.w + R + 0.001, y: box.y + box.h / 2 };
    expect(nameMeetsDots(under, [dot], GRID.letterWidth, R, R)).toBe(false);
  });
});
