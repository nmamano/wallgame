import { describe, expect, it } from "bun:test";
import {
  botsQuerySchema,
  createGameSchema,
  pastGamesFilterSchema,
  variantValues,
} from "../../shared/contracts/games";
import { rankingQuerySchema } from "../../shared/contracts/ranking";
import {
  updateDefaultVariantSchema,
  updateVariantParametersSchema,
} from "../../shared/contracts/settings";
import { rulesVariantFor } from "../../shared/domain/game-types";

describe("runtime rules variants and legacy setup compatibility", () => {
  it("exposes only active pawn-rules variants on runtime selection contracts", () => {
    expect(variantValues).toEqual(["standard", "animal-cycle", "classic"]);
    expect(
      pastGamesFilterSchema.safeParse({ variant: "freestyle" }).success,
    ).toBe(false);
    expect(
      rankingQuerySchema.safeParse({
        scope: "variant",
        variant: "freestyle",
        timeControl: "rapid",
      }).success,
    ).toBe(false);
    expect(
      updateDefaultVariantSchema.safeParse({ variant: "freestyle" }).success,
    ).toBe(false);
    expect(
      updateVariantParametersSchema.safeParse({
        variant: "freestyle",
        parameters: {
          boardWidth: 8,
          boardHeight: 8,
          randomStart: true,
        },
      }).success,
    ).toBe(false);
  });

  it("keeps legacy create and bot capability identifiers readable", () => {
    expect(
      createGameSchema.parse({
        config: {
          variant: "freestyle",
          randomStart: true,
          boardWidth: 8,
          boardHeight: 8,
          rated: false,
          timeControl: { initialSeconds: 0, incrementSeconds: 0 },
        },
      }).config,
    ).toMatchObject({ variant: "standard", randomStart: true });
    for (const variant of [
      "freestyle",
      "custom-setup-standard",
      "custom-setup-classic",
    ] as const) {
      expect(botsQuerySchema.safeParse({ variant }).success).toBe(true);
    }
    expect(rulesVariantFor("freestyle")).toBe("standard");
    expect(rulesVariantFor("custom-setup-standard")).toBe("standard");
    expect(rulesVariantFor("custom-setup-classic")).toBe("classic");
  });
});
