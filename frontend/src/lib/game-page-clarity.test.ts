import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { controlPanelVariantName } from "./game-page-clarity";
import { variantDisplayName } from "../../../shared/domain/game-types";

describe("game-page clarity", () => {
  test("the control panel alone omits Random Start", () => {
    expect(controlPanelVariantName("standard")).toBe("Standard");
    expect(variantDisplayName("standard", true)).toBe(
      "Standard · Random Start",
    );
  });

  test("capture shake is non-scaling and disabled for reduced motion", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const keyframes = css.slice(
      css.indexOf("@keyframes game-capture-shake"),
      css.indexOf(".game-capture-shake {", css.indexOf("@keyframes")),
    );
    const reducedMotion = css.slice(
      css.indexOf("@media (prefers-reduced-motion: reduce)"),
      css.indexOf("@keyframes game-capture-shake"),
    );

    expect(keyframes).toContain("translate(");
    expect(keyframes).toContain("rotate(");
    expect(keyframes).not.toContain("scale(");
    expect(reducedMotion).toContain(".game-capture-shake");
    expect(reducedMotion).toContain("animation: none !important");
  });
});
