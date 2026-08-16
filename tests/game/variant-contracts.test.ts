/**
 * Which variants the public request contracts accept, in one place.
 *
 * Merged 2026-08-16 from runtime-variant-contract.test.ts,
 * random-start-contract.test.ts, and the contract half of
 * animal-cycle-surfaces.test.ts, which all asked the same question of
 * different schemas. Two classes of assertion were dropped in the merge:
 * literal-list equalities on `variantValues` (a constant compared to itself
 * catches no behavior - the schema REJECTIONS below are what a leaked variant
 * would break), and source-string scrapes of frontend routes (retired
 * repo-wide; real rendering is the browser harnesses' job).
 *
 * The product rule under test: variants define pawn rules - Standard, Classic,
 * Animal Cycle. Random Start and custom setups are initial CONDITIONS under
 * those rules, not variants (Nil, 2026-08-14), so setup-shaped identifiers
 * like "freestyle" must be refused everywhere a variant is named.
 */

import { describe, expect, it } from "bun:test";
import {
  botsQuerySchema,
  createBotGameDirectSchema,
  createGameSchema,
  pastGamesFilterSchema,
} from "../../shared/contracts/games";
import { rankingQuerySchema } from "../../shared/contracts/ranking";
import {
  updateDefaultVariantSchema,
  updatePawnSchema,
  updateVariantParametersSchema,
} from "../../shared/contracts/settings";
import { botConfigBaseSchema } from "../../shared/contracts/custom-bot-config-schema";
import { botCapabilityVariant } from "../../shared/domain/bot-capability";
import { variantDisplayName } from "../../shared/domain/game-types";
import type { SerializedGameState } from "../../shared/domain/game-types";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";
import { buildGameConfigurationFromSerialized } from "../../frontend/src/lib/game-state-utils";

const base = {
  timeControl: { initialSeconds: 180, incrementSeconds: 2 },
  rated: false,
  boardWidth: 8,
  boardHeight: 8,
};

describe("variant selection contracts", () => {
  it("refuses setup-shaped identifiers on every runtime selection contract", () => {
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

  it("refuses removed setup-shaped identifiers on game creation and bot listing", () => {
    expect(
      createGameSchema.safeParse({
        config: {
          variant: "freestyle",
          randomStart: true,
          boardWidth: 8,
          boardHeight: 8,
          rated: false,
          timeControl: { initialSeconds: 0, incrementSeconds: 0 },
        },
      }).success,
    ).toBe(false);
    for (const variant of [
      "freestyle",
      "custom-setup-standard",
      "custom-setup-classic",
    ] as const) {
      expect(botsQuerySchema.safeParse({ variant }).success).toBe(false);
    }
  });

  it("accepts Animal Cycle on ordinary and direct-bot creation contracts", () => {
    const directConfig = {
      variant: "animal-cycle",
      randomStart: false,
      boardWidth: 8,
      boardHeight: 8,
    };
    expect(
      createGameSchema.safeParse({
        config: {
          ...directConfig,
          rated: false,
          timeControl: { initialSeconds: 180, incrementSeconds: 2 },
        },
        matchType: "friend",
      }).success,
    ).toBe(true);
    expect(
      createBotGameDirectSchema.safeParse({
        botId: "naive-cycle",
        config: directConfig,
      }).success,
    ).toBe(true);
  });

  it("allows a naive bot registration to advertise Animal Cycle", () => {
    const parsed = botConfigBaseSchema.safeParse({
      botId: "naive-cycle",
      name: "Naive Animal Cycle",
      username: null,
      appearance: {
        dogStyle: "dog-puppy-07.svg",
        elephantStyle: "elephant-19.svg",
      },
      variants: {
        "animal-cycle": {
          boardWidth: { min: 4, max: 20 },
          boardHeight: { min: 4, max: 20 },
          recommended: [{ boardWidth: 8, boardHeight: 8 }],
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.appearance).toEqual({
      dogStyle: "dog-puppy-07.svg",
      elephantStyle: "elephant-19.svg",
    });
  });

  it("accepts Dog and Elephant account-setting updates", () => {
    expect(
      updatePawnSchema.parse({
        pawnType: "dog",
        pawnShape: "dog-puppy-07.svg",
      }),
    ).toEqual({ pawnType: "dog", pawnShape: "dog-puppy-07.svg" });
    expect(
      updatePawnSchema.parse({
        pawnType: "elephant",
        pawnShape: "elephant-19.svg",
      }),
    ).toEqual({ pawnType: "elephant", pawnShape: "elephant-19.svg" });
  });

  it("ships the four animal silhouettes the variant renders with", async () => {
    for (const animal of ["dog", "cat", "mouse", "elephant"]) {
      expect(
        await Bun.file(
          `frontend/public/pawns/animal-cycle/${animal}.svg`,
        ).exists(),
      ).toBe(true);
    }
  });
});

describe("Random Start contracts", () => {
  it("requires randomStart on current create inputs", () => {
    expect(
      createGameSchema.safeParse({
        config: { ...base, variant: "standard" },
        matchType: "friend",
      }).success,
    ).toBe(false);
  });

  it("accepts Standard Random Start create inputs", () => {
    const parsed = createGameSchema.parse({
      config: { ...base, variant: "standard", randomStart: true },
      matchType: "friend",
    });
    expect(parsed.config.variant).toBe("standard");
    expect(parsed.config.randomStart).toBe(true);
  });

  it("accepts an arbitrary supplied Standard position without changing its coordinates", () => {
    const initialState = buildStandardInitialState(8, 8);
    initialState.pawns.p1.cat = [3, 5];
    initialState.pawns.p2.mouse = [6, 1];
    initialState.walls.push({ cell: [4, 2], orientation: "vertical" });

    const parsed = createGameSchema.parse({
      config: {
        ...base,
        variant: "standard",
        randomStart: false,
        initialState,
      },
    });

    expect("variantConfig" in parsed.config).toBe(true);
    if (!("variantConfig" in parsed.config))
      throw new Error("missing position");
    expect(parsed.config.variantConfig).toEqual(initialState);
  });

  it("accepts enabled Classic and rejects undersized Animal Cycle", () => {
    expect(
      createGameSchema.safeParse({
        config: { ...base, variant: "classic", randomStart: true },
      }).success,
    ).toBe(true);
    expect(
      createGameSchema.safeParse({
        config: {
          ...base,
          variant: "animal-cycle",
          randomStart: true,
          boardWidth: 3,
        },
      }).success,
    ).toBe(false);
    expect(
      createGameSchema.safeParse({
        config: {
          ...base,
          variant: "animal-cycle",
          randomStart: false,
          boardWidth: 3,
        },
      }).success,
    ).toBe(true);
  });

  it("routes setup modes through their pawn-rules capability", () => {
    expect(botCapabilityVariant("standard", false)).toBe("standard");
    expect(botCapabilityVariant("standard", true)).toBe("standard");
    expect(botCapabilityVariant("animal-cycle", true)).toBe("animal-cycle");
  });

  it("uses the required player-visible name", () => {
    expect(variantDisplayName("standard", false)).toBe("Standard");
    expect(variantDisplayName("standard", true)).toBe(
      "Standard · Random Start",
    );
    expect(variantDisplayName("standard")).toBe("Standard");
  });

  it("reconstructs a current stored Random Start game without changing its initial state", () => {
    const initialState = buildStandardInitialState(8, 8);
    initialState.walls.push({ cell: [3, 3], orientation: "vertical" });
    const serialized = {
      status: "finished",
      turn: 1,
      moveCount: 0,
      timeLeft: { 1: 0, 2: 0 },
      lastMoveTime: 0,
      pawns: {
        kind: "standard",
        pawns: { 1: initialState.pawns.p1, 2: initialState.pawns.p2 },
      },
      walls: initialState.walls,
      initialState,
      history: [],
      config: {
        variant: "standard",
        rated: false,
        timeControl: { initialSeconds: 0, incrementSeconds: 0 },
        boardWidth: 8,
        boardHeight: 8,
        randomStart: true,
        variantConfig: initialState,
      },
    } as unknown as SerializedGameState;

    const normalized = buildGameConfigurationFromSerialized(serialized);
    expect(normalized.variant).toBe("standard");
    expect(normalized.randomStart).toBe(true);
    expect(normalized.variantConfig).toBe(initialState);
    expect(serialized.initialState).toBe(initialState);
  });
});
