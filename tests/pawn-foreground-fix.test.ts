import { describe, expect, test } from "bun:test";
import { resolvePawnForegroundFixSrc } from "../frontend/src/lib/pawn-foreground-fix";

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
