import { describe, expect, it } from "bun:test";
import { createGameSchema } from "../../shared/contracts/games";
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

describe("Random Start contracts", () => {
  it("requires randomStart on current create inputs", () => {
    expect(
      createGameSchema.safeParse({
        config: { ...base, variant: "standard" },
        matchType: "friend",
      }).success,
    ).toBe(false);
  });

  it("accepts and normalizes legacy Freestyle create inputs", () => {
    const parsed = createGameSchema.parse({
      config: { ...base, variant: "freestyle" },
      matchType: "friend",
    });
    expect(parsed.config.variant).toBe("standard");
    expect(parsed.config.randomStart).toBe(true);
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
    expect(variantDisplayName("freestyle")).toBe("Standard · Random Start");
  });

  it("normalizes a legacy stored config without changing its initial state", () => {
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
        variant: "freestyle",
        rated: false,
        timeControl: { initialSeconds: 0, incrementSeconds: 0 },
        boardWidth: 8,
        boardHeight: 8,
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
