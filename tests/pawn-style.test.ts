import { describe, expect, test } from "bun:test";
import { resolvePawnBackingSrc } from "../frontend/src/lib/pawn-style";

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
  });

  test("does not invent a backing for an off-site or non-pawn image", () => {
    expect(resolvePawnBackingSrc("https://example.com/cat.svg")).toBeNull();
    expect(resolvePawnBackingSrc("/avatars/cat1.svg")).toBeNull();
  });
});
