import { describe, expect, it } from "bun:test";
import { generateClassicRandomInitialState } from "../../shared/domain/classic-setup";
import { generateStandardRandomInitialState } from "../../shared/domain/random-start-setup";

const seededRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

describe("Classic Random Start", () => {
  it("uses the exact Standard generator and maps each home to the opponent mouse", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const standard = generateStandardRandomInitialState(
        12,
        10,
        seededRng(seed),
      );
      const classic = generateClassicRandomInitialState(
        12,
        10,
        seededRng(seed),
      );

      expect(classic).toEqual({
        pawns: {
          p1: { cat: standard.pawns.p1.cat, home: standard.pawns.p2.mouse },
          p2: { cat: standard.pawns.p2.cat, home: standard.pawns.p1.mouse },
        },
        walls: standard.walls,
      });
    }
  });

  it("does not change the existing Standard Random Start output", () => {
    const before = generateStandardRandomInitialState(
      8,
      8,
      seededRng(20260815),
    );
    generateClassicRandomInitialState(8, 8, seededRng(17));
    const after = generateStandardRandomInitialState(8, 8, seededRng(20260815));
    expect(after).toEqual(before);
  });
});
