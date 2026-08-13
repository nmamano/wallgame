import { describe, expect, mock, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_PAWN_STYLES,
  normalizePawnStyleSelection,
  type PawnStyleType,
} from "../frontend/src/lib/pawn-style";

const pawnTypes = ["dog", "cat", "mouse", "elephant", "home"] as const;
void mock.module("virtual:pawn-manifest", () => ({
  default: Object.fromEntries(
    pawnTypes.map((type) => [
      type,
      readdirSync(
        path.join(import.meta.dir, "../frontend/public/pawns", type),
      ).filter((name) => name.endsWith(".svg")),
    ]),
  ),
}));
const { defaultPawnDisplayLabel, dogPawnDisplayLabel } =
  await import("../frontend/src/lib/pawn-labels");
const { DOG_PAWNS } = await import("../frontend/src/lib/pawns");

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
      dog: "dog-puppy-03.svg",
      cat: "cat3.svg",
      mouse: "mouse20.svg",
      elephant: "elephant-14.svg",
      home: "home2.svg",
    });
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
    const altLabels = names.map(dogPawnDisplayLabel);
    expect(new Set(selectedLabels).size).toBe(49);
    expect(new Set(altLabels).size).toBe(49);
    expect(selectedLabels).toEqual(names.map((_, index) => `Dog ${index + 1}`));
    expect(selectedLabels[0]).toBe("Dog 1");
    expect(selectedLabels[23]).toBe("Dog 24");
    expect(selectedLabels[24]).toBe("Dog 25");
    expect(selectedLabels[48]).toBe("Dog 49");
    expect(dogPawnDisplayLabel("unknown-dog.svg")).toBe("unknown-dog.svg");
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
