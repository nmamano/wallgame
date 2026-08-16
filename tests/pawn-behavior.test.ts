import { describe, expect, mock, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { sortPawnNames } from "../frontend/src/lib/pawn-sort";
import { resolvePawnForegroundFixSrc } from "../frontend/src/lib/pawn-foreground-fix";
import {
  DEFAULT_PAWN_STYLES,
  isRetiredPawnStyle,
  normalizeBoardPawnStyle,
  normalizePawnStyleSelection,
  resolvePawnBackingSrc,
  type PawnStyleType,
} from "../frontend/src/lib/pawn-style";

/**
 * Behavior of the pawn appearance helpers: the order the player sees art in,
 * style normalization and retirement fallbacks, backing/foreground URL
 * derivation, and the labels the PawnSelector shows. Consolidated from
 * pawn-sort.test.ts, pawn-style.test.ts, pawn-foreground-fix.test.ts and
 * pawn-selector.test.ts.
 *
 * The pawn lists used to be `Object.keys(import.meta.glob(...))`, sorted. That
 * glob also pulled 385 files from `public/` into the bundle, so it was replaced
 * by `vite-plugin-pawn-manifest.ts`, which reads the same directories with `fs`.
 *
 * A glob hands its keys over already sorted lexicographically; `readdirSync`
 * promises no order at all. The sort tests exist because the ORDER the player
 * sees must not depend on that difference.
 *
 * This lives in `tests/` rather than beside the helpers because
 * `scripts/run-tests.ts` globs `tests/**` only - a test under `frontend/src`
 * never runs in CI.
 */

const PAWN_DIR = path.join(import.meta.dir, "../frontend/public/pawns");
const readPawnDir = (type: string) =>
  readdirSync(path.join(PAWN_DIR, type)).filter((name) =>
    name.endsWith(".svg"),
  );

const pawnTypes = [
  "dog",
  "cat",
  "mouse",
  "elephant",
  "home",
] as const satisfies readonly PawnStyleType[];

void mock.module("virtual:pawn-manifest", () => ({
  default: Object.fromEntries(
    pawnTypes.map((type) => [type, readPawnDir(type)]),
  ),
}));
const { defaultPawnDisplayLabel, dogPawnDisplayLabel } =
  await import("../frontend/src/lib/pawn-labels");
const { DOG_PAWNS } = await import("../frontend/src/lib/pawns");

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
    ["cat", 277],
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

describe("resolvePawnBackingSrc", () => {
  test("maps each local pawn SVG to its generated backing", () => {
    expect(resolvePawnBackingSrc("/pawns/cat/cat1.svg")).toContain(
      "/pawn-backings/cat/cat1.png",
    );
    expect(resolvePawnBackingSrc("/pawns/mouse/mouse85.svg?v=1")).toContain(
      "/pawn-backings/mouse/mouse85.png",
    );
    expect(resolvePawnBackingSrc("/pawns/home/home10.svg#mark")).toContain(
      "/pawn-backings/home/home10.png",
    );
    expect(resolvePawnBackingSrc("/pawns/dog/dog-puppy-01.svg")).toContain(
      "/pawn-backings/dog/dog-puppy-01.png",
    );
    expect(resolvePawnBackingSrc("/pawns/elephant/elephant-25.svg")).toContain(
      "/pawn-backings/elephant/elephant-25.png",
    );
  });

  test("does not invent a backing for an off-site or non-pawn image", () => {
    expect(resolvePawnBackingSrc("https://example.com/cat.svg")).toBeNull();
    expect(resolvePawnBackingSrc("/avatars/cat1.svg")).toBeNull();
  });
});

describe("resolvePawnForegroundFixSrc", () => {
  test("maps only the two reviewed local cat drawings", () => {
    expect(resolvePawnForegroundFixSrc("/pawns/cat/cat9.svg")).toBe(
      "/pawn-foreground-fixes/cat/cat9.png",
    );
    expect(resolvePawnForegroundFixSrc("/pawns/cat/cat73.svg?v=1")).toBe(
      "/pawn-foreground-fixes/cat/cat73.png",
    );
    expect(resolvePawnForegroundFixSrc("/pawns/cat/cat74.svg")).toBeNull();
  });

  test("does not add a foreground layer to off-site images", () => {
    expect(
      resolvePawnForegroundFixSrc("https://example.com/pawns/cat/cat9.svg"),
    ).toBeNull();
  });
});

describe("default pawn styles", () => {
  test("uses Nil's selected SVGs instead of browser icons", () => {
    expect(DEFAULT_PAWN_STYLES).toEqual({
      dog: "dog-puppy-03.svg",
      cat: "cat3.svg",
      mouse: "mouse20.svg",
      elephant: "elephant-14.svg",
      home: "home2.svg",
    });
  });

  test("retired saved selections fall back to default", () => {
    for (const name of [
      "cat126.svg",
      "cat150.svg",
      "cat188.svg",
      "cat237.svg",
    ]) {
      expect(isRetiredPawnStyle(name, "cat")).toBe(true);
      expect(normalizePawnStyleSelection(name, "cat")).toBe("default");
    }
    for (const name of [
      "mouse26.svg",
      "mouse33.svg",
      "mouse68.svg",
      "mouse74.svg",
    ]) {
      expect(isRetiredPawnStyle(name, "mouse")).toBe(true);
      expect(normalizePawnStyleSelection(name, "mouse")).toBe("default");
    }
    expect(normalizePawnStyleSelection("cat3.svg", "cat")).toBe("cat3.svg");
  });

  test("removed Dog and Cat selections cannot form broken asset URLs", () => {
    expect(normalizePawnStyleSelection("dog-one-line-01.svg", "dog")).toBe(
      "default",
    );
    for (const number of [
      17, 31, 47, 52, 54, 94, 105, 168, 174, 179, 219, 244, 245,
    ]) {
      const name = `cat${String(number)}.svg`;
      expect(isRetiredPawnStyle(name, "cat")).toBe(true);
      expect(normalizePawnStyleSelection(name, "cat")).toBe("default");
    }
  });

  test("board default chain resolves Dog and Elephant backings", () => {
    // Board surfaces pass undefined for "default" and let the resolver pick
    // the type's default SVG; that SVG must in turn map to a real backing.
    expect(normalizeBoardPawnStyle("default")).toBeUndefined();
    for (const type of ["dog", "elephant"] as const) {
      const src = `/pawns/${type}/${DEFAULT_PAWN_STYLES[type]}`;
      expect(resolvePawnBackingSrc(src)).toBe(
        `/pawn-backings/${type}/${DEFAULT_PAWN_STYLES[type].replace(
          ".svg",
          ".png",
        )}`,
      );
    }
  });
});

describe("PawnSelector labels and default previews", () => {
  test("resolves the default preview for all five pawn types", () => {
    for (const type of pawnTypes) {
      expect(normalizePawnStyleSelection(undefined, type)).toBe("default");
    }
  });

  test("gives every remaining Dog a stable sequential selected and alt label", () => {
    const names = [
      ...Array.from(
        { length: 24 },
        (_, index) => `dog-one-line-${String(index + 2).padStart(2, "0")}.svg`,
      ),
      ...Array.from(
        { length: 25 },
        (_, index) => `dog-puppy-${String(index + 1).padStart(2, "0")}.svg`,
      ),
    ];
    expect(DOG_PAWNS).toEqual(names);
    const selectedLabels = names.map(dogPawnDisplayLabel);
    expect(new Set(selectedLabels).size).toBe(49);
    expect(selectedLabels).toEqual(names.map((_, index) => `Dog ${index + 1}`));
    expect(selectedLabels[0]).toBe("Dog 1");
    expect(selectedLabels[23]).toBe("Dog 24");
    expect(selectedLabels[24]).toBe("Dog 25");
    expect(selectedLabels[48]).toBe("Dog 49");
    expect(dogPawnDisplayLabel("unknown-dog.svg")).toBe("unknown-dog.svg");

    // A grid image's alt text goes through the same code path as the trigger
    // button's text: PawnSelector's getDisplayName, which is the caller's
    // `displayLabel` prop when wired and `defaultPawnDisplayLabel` otherwise.
    // settings.tsx wires `displayLabel={dogPawnDisplayLabel}` for the Dog
    // selector, so the shipped alt labels are exactly `selectedLabels` above.
    // That wiring is load-bearing: the fallback labels by the FIRST number in
    // the filename, and the two purchased packs reuse the numbers 01-25, so
    // without the prop 49 pawns would share 25 alt labels.
    const fallbackAltLabels = names.map((name) =>
      defaultPawnDisplayLabel(name, "Dog"),
    );
    expect(new Set(fallbackAltLabels).size).toBe(25);
    expect(fallbackAltLabels[0]).toBe("Dog 02"); // dog-one-line-02.svg
    expect(fallbackAltLabels[24]).toBe("Dog 01"); // dog-puppy-01.svg
  });

  test("keeps the existing default label behavior byte-for-byte", () => {
    expect(defaultPawnDisplayLabel("cat3.svg", "Cat")).toBe("Cat 3");
    expect(defaultPawnDisplayLabel("mouse20.svg", "Mouse")).toBe("Mouse 20");
    expect(defaultPawnDisplayLabel("home2.svg", "Home")).toBe("Home 2");
    expect(defaultPawnDisplayLabel("elephant-01.svg", "Elephant")).toBe(
      "Elephant 01",
    );
  });
});
