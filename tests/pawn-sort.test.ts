import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { sortPawnNames } from "../frontend/src/lib/pawn-sort";

/**
 * The pawn lists used to be `Object.keys(import.meta.glob(...))`, sorted. That
 * glob also pulled 385 files from `public/` into the bundle, so it was replaced
 * by `vite-plugin-pawn-manifest.ts`, which reads the same directories with `fs`.
 *
 * A glob hands its keys over already sorted lexicographically; `readdirSync`
 * promises no order at all. These tests exist because the ORDER the player sees
 * must not depend on that difference.
 *
 * This lives in `tests/` rather than beside the helper because
 * `scripts/run-tests.ts` globs `tests/**` only - a test under `frontend/src`
 * never runs in CI.
 */

const PAWN_DIR = join(import.meta.dir, "../frontend/public/pawns");
const readPawnDir = (type: string) =>
  readdirSync(join(PAWN_DIR, type)).filter((name) => name.endsWith(".svg"));

const leadingNumber = (name: string) => parseInt(/\d+/.exec(name)?.[0] ?? "0");

describe("sortPawnNames", () => {
  test("orders by number, not lexicographically", () => {
    expect(sortPawnNames(["cat10.svg", "cat2.svg", "cat1.svg"])).toEqual([
      "cat1.svg",
      "cat2.svg",
      "cat10.svg",
    ]);
  });

  test("breaks ties by name, so directory order cannot leak through", () => {
    const forwards = sortPawnNames(["cat1b.svg", "cat1a.svg"]);
    const backwards = sortPawnNames(["cat1a.svg", "cat1b.svg"]);
    expect(forwards).toEqual(["cat1a.svg", "cat1b.svg"]);
    expect(backwards).toEqual(forwards);
  });

  test("does not drop or invent names", () => {
    const input = ["mouse3.svg", "mouse1.svg", "mouse2.svg"];
    expect(sortPawnNames(input).toSorted()).toEqual(input.toSorted());
  });

  test("leaves the input array alone", () => {
    const input = ["cat2.svg", "cat1.svg"];
    sortPawnNames(input);
    expect(input).toEqual(["cat2.svg", "cat1.svg"]);
  });
});

describe("the real pawn art", () => {
  for (const [type, expectedCount] of [
    ["cat", 290],
    ["mouse", 85],
    ["home", 10],
  ] as const) {
    describe(type, () => {
      const sorted = sortPawnNames(readPawnDir(type));

      test(`ships ${String(expectedCount)} files`, () => {
        expect(sorted.length).toBe(expectedCount);
      });

      test("gives every file a distinct number", () => {
        // Without this, the tie-break below decides the order, and a player
        // would see two pawns whose position depends on the art's filenames
        // rather than on its numbering.
        const numbers = sorted.map(leadingNumber);
        expect(new Set(numbers).size).toBe(numbers.length);
      });

      test("is strictly ascending by number", () => {
        const numbers = sorted.map(leadingNumber);
        expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
      });

      test("keeps every file the directory holds", () => {
        expect(sorted.toSorted()).toEqual(readPawnDir(type).toSorted());
      });
    });
  }

  // Captured from the shipped bundle at 9d5ee2e, before the glob was removed:
  // the exact lists the old `Object.keys(import.meta.glob(...))` path produced.
  test("matches the order the glob produced", () => {
    expect(sortPawnNames(readPawnDir("cat")).slice(0, 6)).toEqual([
      "cat1.svg",
      "cat2.svg",
      "cat3.svg",
      "cat4.svg",
      "cat5.svg",
      "cat6.svg",
    ]);
    expect(sortPawnNames(readPawnDir("cat")).slice(-3)).toEqual([
      "cat309.svg",
      "cat310.svg",
      "cat311.svg",
    ]);
    expect(sortPawnNames(readPawnDir("mouse")).slice(-3)).toEqual([
      "mouse83.svg",
      "mouse84.svg",
      "mouse85.svg",
    ]);
    expect(sortPawnNames(readPawnDir("home")).slice(-3)).toEqual([
      "home8.svg",
      "home9.svg",
      "home10.svg",
    ]);
  });
});
