import { describe, expect, test } from "bun:test";
import {
  defaultPawnDisplayLabel,
  dogPawnDisplayLabel,
} from "../frontend/src/lib/pawn-labels";
import {
  DEFAULT_PAWN_STYLES,
  normalizePawnStyleSelection,
  type PawnStyleType,
} from "../frontend/src/lib/pawn-style";

describe("PawnSelector labels and default previews", () => {
  test("resolves the default preview for all five pawn types", () => {
    for (const type of [
      "dog",
      "cat",
      "mouse",
      "elephant",
      "home",
    ] as const satisfies readonly PawnStyleType[]) {
      expect(normalizePawnStyleSelection(undefined, type)).toBe("default");
    }
    expect(DEFAULT_PAWN_STYLES).toEqual({
      dog: "pawns/animal-cycle/dog.svg",
      cat: "cat3.svg",
      mouse: "mouse20.svg",
      elephant: "pawns/animal-cycle/elephant.svg",
      home: "home2.svg",
    });
  });

  test("gives every Dog option a unique pack-aware selected and alt label", () => {
    const names = [
      ...Array.from(
        { length: 25 },
        (_, index) => `dog-one-line-${String(index + 1).padStart(2, "0")}.svg`,
      ),
      ...Array.from(
        { length: 25 },
        (_, index) => `dog-puppy-${String(index + 1).padStart(2, "0")}.svg`,
      ),
    ];
    const selectedLabels = names.map(dogPawnDisplayLabel);
    const altLabels = names.map(dogPawnDisplayLabel);
    expect(new Set(selectedLabels).size).toBe(50);
    expect(new Set(altLabels).size).toBe(50);
    expect(selectedLabels[0]).toBe("One Line 01");
    expect(selectedLabels[25]).toBe("Puppy 01");
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
