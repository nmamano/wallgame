import { describe, expect, it } from "bun:test";
import type { Variant } from "../../shared/domain/game-types";
import {
  executableRulesFor,
  helpRulesFor,
} from "../../shared/domain/variant-rules";

describe("authoritative variant rules", () => {
  it("covers all four executable variants but exposes three HELP variants", () => {
    const variants: Variant[] = [
      "standard",
      "classic",
      "animal-cycle",
      "survival",
    ];

    expect(
      variants.map((variant) => executableRulesFor(variant).pawnFamily),
    ).toEqual(["standard", "classic", "animal-cycle", "survival"]);
    expect(helpRulesFor("standard").variant).toBe("standard");
    expect(helpRulesFor("classic").variant).toBe("classic");
    expect(helpRulesFor("animal-cycle").variant).toBe("animal-cycle");
  });

  it("selects Classic HELP content from Classic rules", () => {
    expect(helpRulesFor("classic").captureKind).toBe("reach-home");
  });

  it("keeps Survival executable behavior explicit", () => {
    const survival = executableRulesFor("survival");
    expect(survival.pawnSet).toEqual([
      { playerId: 1, type: "cat" },
      { playerId: 2, type: "mouse" },
    ]);
    expect(survival.goalTargets).toEqual({
      1: { player: 2, type: "mouse" },
      2: { player: 2, type: "mouse" },
    });
    expect(survival.captureKind).toBe("cat-captures-mouse");
    expect(survival.mouseMovement).toBe("survival-config");
    expect(survival.oneMoveDraw).toBe(false);
  });
});
