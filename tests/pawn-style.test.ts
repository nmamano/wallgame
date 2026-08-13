import { describe, expect, test } from "bun:test";
import { resolvePawnBackingSrc } from "../frontend/src/lib/pawn-style";
import {
  DEFAULT_PAWN_STYLES,
  isRetiredPawnStyle,
  normalizePawnStyleSelection,
} from "../frontend/src/lib/pawn-style";

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

describe("default pawn styles", () => {
  test("uses Nil's selected SVGs instead of browser icons", () => {
    expect(DEFAULT_PAWN_STYLES).toEqual({
      dog: "pawns/animal-cycle/dog.svg",
      cat: "cat3.svg",
      mouse: "mouse20.svg",
      elephant: "pawns/animal-cycle/elephant.svg",
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
});
