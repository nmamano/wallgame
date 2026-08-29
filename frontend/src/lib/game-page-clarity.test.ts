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

  test("capture shake targets one inner stage inside each fixed page surface", () => {
    const route = readFileSync(
      new URL("../routes/game.$id.tsx", import.meta.url),
      "utf8",
    );

    expect(route.match(/data-capture-feedback-surface/g)).toHaveLength(2);
    expect(route.match(/data-capture-shake-stage/g)).toHaveLength(2);
    expect(route.match(/onAnimationEnd=/g)).toHaveLength(2);
    expect(route.match(/game-capture-shake/g)).toHaveLength(2);
  });
});
